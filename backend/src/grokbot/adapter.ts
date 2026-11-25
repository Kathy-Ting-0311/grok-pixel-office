import {
  SEND_BLOCKED_REASON,
  type LiveAgent,
  type LiveGroup,
  type LiveMessage,
  type LiveSendResult,
  type LiveStatus,
  type LiveThreadStatus,
} from '../../../shared/liveControl';
import { GrokBotCliError, scrub, UUID, type CliClient, type CliInfo } from './cli';
import type { LiveControlConfig } from './config';
import { botsSchema, groupsSchema, threadSchema } from './schemas';
import { ThreadSync } from './transcript';

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
};
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

type Job = { kind: 'discovery' } | { kind: 'thread'; id: string };

/**
 * GrokBotGatewayAdapter — read-only (Phase 1).
 *
 * Discovers bots and groups and syncs their transcripts incrementally through the patched CLI.
 * One job at a time (concurrency 1) on a single timer; exponential backoff on failure; after
 * `maxFailures` consecutive failures (or a missing / unverified CLI) it turns itself off and spawns
 * nothing until `reconnect()`. Messages are kept in memory and handed to `onMessages`; nothing is
 * written to disk.
 */
export class GrokBotGatewayAdapter {
  private timer: unknown;
  private running = false;
  private stopped = true;
  private paused = false;
  private cli?: CliInfo;
  private state: LiveStatus['state'] = 'stopped';
  private reason?: string;
  private failures = 0;
  private lastSuccessAt?: number;
  private lastErrorAt?: number;
  private lastError?: string;
  private nextRunAt?: number;
  private lastDiscoveryAt = 0;
  private lastActiveAt = 0;
  private lastIdleAt = 0;
  private rr = 0;
  /** Set while backing off: the failed job runs again as soon as its backoff ends. */
  private retry?: Job;
  private activeThreadId?: string;
  private agents: LiveAgent[] = [];
  private groups: LiveGroup[] = [];
  private threads = new Map<string, ThreadSync>();
  private counters = {
    calls: 0,
    failures: 0,
    timeouts: 0,
    duplicates: 0,
    malformed: 0,
    unknown: 0,
    placeholders: {} as Record<string, number>,
  };
  private listeners = new Set<(m: LiveMessage[]) => void>();
  private readonly t: Timers;

  constructor(
    private readonly cfg: LiveControlConfig,
    private readonly client: CliClient,
    timers: Partial<Timers> = {},
  ) {
    this.t = { ...realTimers, ...timers };
  }

  onMessages(fn: (m: LiveMessage[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Verifies the CLI, discovers, then starts the polling loop (unless paused). */
  async start(opts: { paused?: boolean } = {}) {
    if (!this.stopped) return;
    this.stopped = false;
    this.paused = !!opts.paused;
    this.failures = 0;
    this.state = 'starting';
    this.reason = undefined;
    // Settings are checked before anything is spawned.
    const owner = this.cfg.ownerAgentId;
    if (!owner)
      return this.turnOff(
        'unavailable',
        new GrokBotCliError('config', 'GROKBOT_OWNER_AGENT_ID is not set.'),
      );
    if (!UUID.test(owner))
      return this.turnOff(
        'unavailable',
        new GrokBotCliError('config', 'GROKBOT_OWNER_AGENT_ID is not a valid agent id.'),
      );
    try {
      this.cli = await this.client.verify();
    } catch (err) {
      return this.turnOff('unavailable', err);
    }
    if (this.stopped) return;
    if (this.paused) {
      this.state = 'paused';
      return;
    }
    await this.runJob({ kind: 'discovery' });
  }

  /** Clears every timer. Safe to call any number of times. */
  stop() {
    this.stopped = true;
    this.retry = undefined;
    this.clearTimer();
    if (this.state !== 'off-error' && this.state !== 'unavailable') this.state = 'stopped';
  }

  pause() {
    if (this.stopped) return;
    this.paused = true;
    this.clearTimer();
    this.state = 'paused';
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.state = this.failures ? 'degraded' : 'ok';
    this.schedule(0);
  }

  /** The only way back after Live Control has turned itself off. */
  async reconnect() {
    this.stop();
    this.state = 'stopped';
    await this.start({ paused: this.paused });
  }

  /** The thread open in the UI is polled at the faster `pollActiveMs`. */
  setActiveThread(id?: string) {
    this.activeThreadId = id && this.threads.has(id) ? id : undefined;
  }

  thread(id: string): LiveMessage[] | undefined {
    return this.threads.get(id)?.messages.slice();
  }

  /**
   * One send to a discovered 1:1 bot (never a group, never the owner). Refused before the CLI is
   * called while GROKBOT_LIVE_SEND_ENABLED is off. Never retried, whatever the outcome.
   */
  async send(id: string, text: string): Promise<LiveSendResult> {
    if (!this.cfg.sendEnabled) return { ok: false, delivery: 'refused', error: SEND_BLOCKED_REASON };
    if (this.stopped || this.state === 'off-error' || this.state === 'unavailable')
      return { ok: false, delivery: 'refused', error: 'Live Control is off.' };
    const bot = this.agents.find((a) => a.id === id);
    if (!bot || bot.owner || this.groups.some((g) => g.id === id))
      return { ok: false, delivery: 'refused', error: 'Target is not a discovered 1:1 bot.' };
    let out;
    try {
      out = await this.client.send(id, text);
    } catch (err) {
      const e = err as GrokBotCliError;
      return { ok: false, delivery: 'refused', error: scrub(e.message ?? String(err)) };
    }
    const doc = out.doc as { delivery?: string; error?: unknown } | undefined;
    const known = ['accepted', 'rejected', 'queued', 'unknown'] as const;
    const delivery = known.find((d) => d === doc?.delivery) ?? 'unknown';
    const ok = out.ok && delivery === 'accepted';
    const error = ok
      ? undefined
      : scrub(typeof doc?.error === 'string' ? doc.error : out.timedOut ? 'Timed out.' : 'Send failed.');
    return { ok, delivery, error };
  }

  status(): LiveStatus {
    const iso = (n?: number) => (n ? new Date(n).toISOString() : undefined);
    const threads: LiveThreadStatus[] = [...this.threads.values()].map((s) => ({
      id: s.id,
      name: s.name,
      isGroup: s.isGroup,
      lastPolledAt: s.lastPolledAt,
      cursor: s.cursor,
      messages: s.messages.length,
      gapResets: s.gapResets,
    }));
    return {
      enabled: true,
      state: this.state,
      reason: this.reason,
      paused: this.paused,
      cli: this.cli ? { version: this.cli.version, commit: this.cli.commit } : undefined,
      lastSuccessAt: iso(this.lastSuccessAt),
      lastErrorAt: iso(this.lastErrorAt),
      lastError: this.lastError,
      consecutiveFailures: this.failures,
      nextRunAt: iso(this.nextRunAt),
      activeThreadId: this.activeThreadId,
      agents: this.agents.slice(),
      groups: this.groups.slice(),
      threads,
      counters: { ...this.counters, placeholders: { ...this.counters.placeholders } },
      send: this.cfg.sendEnabled ? { enabled: true } : { enabled: false, reason: SEND_BLOCKED_REASON },
    };
  }

  // ------------------------------------------------------------------ scheduling

  private clearTimer() {
    if (this.timer !== undefined) this.t.clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }

  private schedule(ms: number) {
    this.clearTimer();
    if (this.stopped || this.paused) return;
    this.nextRunAt = this.t.now() + ms;
    this.timer = this.t.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
  }

  /** Picks the job that is due first. */
  private next(): { job: Job; at: number } {
    const c = this.cfg;
    const options: { job: Job; at: number }[] = [
      { job: { kind: 'discovery' }, at: this.lastDiscoveryAt + c.discoveryMs },
    ];
    if (this.activeThreadId)
      options.push({
        job: { kind: 'thread', id: this.activeThreadId },
        at: this.lastActiveAt + c.pollActiveMs,
      });
    const idle = [...this.threads.keys()].filter((id) => id !== this.activeThreadId);
    if (idle.length)
      options.push({
        job: { kind: 'thread', id: idle[this.rr % idle.length] },
        at: this.lastIdleAt + c.pollIdleMs,
      });
    return options.reduce((a, b) => (b.at < a.at ? b : a));
  }

  private async tick() {
    if (this.stopped || this.paused || this.running) return;
    if (this.retry) {
      const job = this.retry;
      this.retry = undefined;
      return this.runJob(job);
    }
    const { job, at } = this.next();
    const wait = at - this.t.now();
    if (wait > 0) return this.schedule(wait);
    await this.runJob(job);
  }

  private async runJob(job: Job) {
    if (this.running) return;
    this.running = true;
    try {
      if (job.kind === 'discovery') await this.discover();
      else await this.syncThread(job.id);
      this.failures = 0;
      this.lastSuccessAt = this.t.now();
      if (this.state !== 'paused') this.state = 'ok';
      this.reason = undefined;
    } catch (err) {
      return this.fail(err, job);
    } finally {
      this.running = false;
    }
    const delay = Math.max(250, this.next().at - this.t.now());
    this.schedule(delay);
  }

  private fail(err: unknown, job: Job) {
    this.counters.failures++;
    this.failures++;
    this.lastErrorAt = this.t.now();
    const e = err instanceof GrokBotCliError ? err : undefined;
    this.lastError = scrub(err instanceof Error ? err.message : String(err));
    if (e?.kind === 'timeout') this.counters.timeouts++;
    if (e && (e.kind === 'missing' || e.kind === 'unverified' || e.kind === 'config'))
      return this.turnOff('unavailable', err);
    if (this.failures >= this.cfg.maxFailures) return this.turnOff('off-error', err);
    this.state = 'degraded';
    this.retry = job;
    this.reason = `Retrying after ${this.failures} failure${this.failures > 1 ? 's' : ''}.`;
    const backoff = Math.min(
      this.cfg.backoffMaxMs,
      this.cfg.backoffBaseMs * 2 ** (this.failures - 1),
    );
    this.schedule(backoff);
  }

  private turnOff(state: 'off-error' | 'unavailable', err: unknown) {
    this.stopped = true;
    this.clearTimer();
    this.state = state;
    this.lastErrorAt = this.t.now();
    this.lastError = scrub(err instanceof Error ? err.message : String(err));
    this.retry = undefined;
    this.reason =
      state === 'unavailable'
        ? `Live Control is off: ${this.lastError} Monitoring, simulation and replay keep working.`
        : `Live Control turned itself off after ${this.failures} failures (${this.lastError}). ` +
          'Monitoring, simulation and replay keep working. Use Reconnect to try again.';
  }

  // ------------------------------------------------------------------ jobs

  private async discover() {
    this.lastDiscoveryAt = this.t.now();
    this.counters.calls++;
    const bots = botsSchema.parse(await this.client.json({ cmd: 'bots' }));
    this.counters.calls++;
    const groups = groupsSchema.parse(await this.client.json({ cmd: 'groups' }));
    const owner = this.cfg.ownerAgentId;
    this.agents = bots
      .filter((b) => (b.kind ?? 'bot') === 'bot')
      .map((b) => ({ id: b.id, name: b.name, owner: b.id === owner }));
    this.groups = groups.map((g) => ({ id: g.id, name: g.name, memberIds: g.members }));
    if (!this.agents.some((a) => a.owner))
      throw new GrokBotCliError(
        'config',
        'GROKBOT_OWNER_AGENT_ID does not appear in the bots list from the CLI.',
      );
    const ids = new Set<string>();
    for (const a of this.agents) {
      ids.add(a.id);
      const s = this.threads.get(a.id);
      if (s) s.name = a.name;
      else this.threads.set(a.id, new ThreadSync(a.id, a.name, false));
    }
    for (const g of this.groups) {
      ids.add(g.id);
      const s = this.threads.get(g.id);
      if (s) s.name = g.name;
      else this.threads.set(g.id, new ThreadSync(g.id, g.name, true));
    }
    // Bots and groups that disappeared stop being polled; their buffered messages go with them.
    for (const id of [...this.threads.keys()]) if (!ids.has(id)) this.threads.delete(id);
    if (this.activeThreadId && !ids.has(this.activeThreadId)) this.activeThreadId = undefined;
  }

  private async syncThread(id: string) {
    const s = this.threads.get(id);
    if (!s) return;
    const now = this.t.now();
    if (id === this.activeThreadId) this.lastActiveAt = now;
    else {
      this.lastIdleAt = now;
      this.rr++;
    }
    this.counters.calls++;
    const out = threadSchema.parse(
      await this.client.json({
        cmd: 'thread',
        id,
        limit: s.cursor ? 50 : this.cfg.initialLimit,
        after: s.cursor,
      }),
    );
    if (out.target.id !== id)
      throw new Error('The CLI returned a different thread than requested.');
    if (out.target.isGroup !== undefined) s.isGroup = out.target.isGroup;
    const r = s.apply(
      out.transcript.entries,
      { ownerId: this.cfg.ownerAgentId },
      { cursor: out.cursor, gapReset: out.gapReset },
    );
    this.counters.duplicates += r.duplicates;
    this.counters.malformed += r.malformed;
    for (const m of r.fresh) {
      if (m.attribution === 'unknown') this.counters.unknown++;
      if (m.placeholder)
        this.counters.placeholders[m.placeholder.type] =
          (this.counters.placeholders[m.placeholder.type] ?? 0) + 1;
    }
    if (r.fresh.length && !this.stopped) for (const l of this.listeners) l(r.fresh);
  }
}
