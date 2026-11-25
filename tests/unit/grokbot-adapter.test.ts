import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrokBotGatewayAdapter } from '../../backend/src/grokbot/adapter';
import { GrokBotCliError, type CliClient, type CliCommand } from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { attribute, ThreadSync } from '../../backend/src/grokbot/transcript';
import { entrySchema } from '../../backend/src/grokbot/schemas';
import type { LiveMessage } from '../../shared/liveControl';
import {
  assistantMessage,
  bots,
  COZ,
  GROUP,
  groups,
  KRYSTAL,
  OWNER,
  sendMessage,
  STRANGER,
  thread,
  userMessage,
} from '../fixtures/grokbot/fixtures';

const cfg = (over: Record<string, string> = {}) => ({
  ...loadLiveControlConfig({
    ENABLE_GROKBOT_LIVE_CONTROL: 'true',
    GROKBOT_CLI_PATH: '/fake/gbot.mjs',
    GROKBOT_OWNER_AGENT_ID: OWNER,
    GROKBOT_POLL_ACTIVE_MS: '10000',
    GROKBOT_POLL_IDLE_MS: '15000',
    GROKBOT_DISCOVERY_MS: '300000',
    ...over,
  }),
});

type Handler = (c: CliCommand) => unknown | Promise<unknown>;

/** Fake CLI: records every command; per-thread responses are queued and the last one repeats. */
class FakeCli implements CliClient {
  calls: CliCommand[] = [];
  verifyError?: Error;
  threads = new Map<string, unknown[]>();
  override?: Handler;
  async verify() {
    if (this.verifyError) throw this.verifyError;
    return { path: '/fake/gbot.mjs', repo: '/fake', commit: '9616503', version: 'gbot 0.12.5' };
  }
  async json(c: CliCommand) {
    this.calls.push(c);
    if (this.override) return this.override(c);
    if (c.cmd === 'bots') return bots;
    if (c.cmd === 'groups') return groups;
    if (c.cmd === 'thread') {
      const q = this.threads.get(c.id) ?? [];
      const next = q.length > 1 ? q.shift() : q[0];
      return next ?? thread(c.id, [], { isGroup: c.id === GROUP });
    }
    throw new Error('unexpected');
  }
  async send(): Promise<never> {
    throw new Error('the adapter must never send');
  }
  threadCalls(id?: string) {
    return this.calls.filter((c) => c.cmd === 'thread' && (!id || c.id === id));
  }
}

const ctx = (threadId: string, isGroup: boolean) => ({ threadId, isGroup, ownerId: OWNER });
const entry = (o: unknown) => entrySchema.parse(o);

describe('sender attribution (rules confirmed at the Phase 1 gate)', () => {
  it('an author decides: the owner id is mine, any other id is verified', () => {
    expect(
      attribute(entry(sendMessage('a', 1, 'x', { author: { id: COZ } })), ctx(GROUP, true)),
    ).toEqual({ attribution: 'verified', senderId: COZ, basis: 'author.id' });
    expect(
      attribute(entry(sendMessage('a', 1, 'x', { author: { id: OWNER } })), ctx(GROUP, true)),
    ).toMatchObject({ attribution: 'owner', senderId: OWNER });
    expect(
      attribute(entry(sendMessage('a', 1, 'x', { author: { id: STRANGER } })), ctx(GROUP, true)),
    ).toMatchObject({ attribution: 'verified', senderId: STRANGER });
    // An author also wins inside a 1:1 thread.
    expect(
      attribute(entry(sendMessage('a', 1, 'x', { author: { id: KRYSTAL } })), ctx(COZ, false)),
    ).toMatchObject({ attribution: 'verified', senderId: KRYSTAL });
    expect(attribute(entry(userMessage('u', 2, 'hi')), ctx(GROUP, true))).toMatchObject({
      attribution: 'owner',
      basis: 'role:user',
    });
    // A group entry without author is never guessed.
    expect(attribute(entry(sendMessage('b', 3, 'x')), ctx(GROUP, true))).toEqual({
      attribution: 'unknown',
      basis: 'group entry without author.id',
    });
  });

  it('thread-target needs a 1:1 thread, kind send-message, no author and role not user', () => {
    expect(attribute(entry(sendMessage('a', 1, 'x')), ctx(COZ, false))).toEqual({
      attribution: 'thread-target',
      senderId: COZ,
      basis: '1:1 send-message, no author',
    });
    // d) role "user" on a send-message: mine, never the bot's.
    expect(
      attribute(entry(sendMessage('b', 2, 'x', { role: 'user' })), ctx(COZ, false)).attribution,
    ).toBe('owner');
    // b) kind must be send-message: a role:assistant "message" is unknown.
    expect(attribute(entry(assistantMessage('c', 3, 'x')), ctx(COZ, false))).toEqual({
      attribution: 'unknown',
      basis: 'no rule matches (kind=message, role=assistant)',
    });
    expect(attribute(entry({ kind: 'tool-call', id: 'd', content: 'x' }), ctx(COZ, false))).toEqual(
      { attribution: 'unknown', basis: 'no rule matches (kind=tool-call, role=none)' },
    );
    // a) a group is never thread-target.
    expect(attribute(entry(sendMessage('e', 4, 'x')), ctx(GROUP, true)).attribution).toBe(
      'unknown',
    );
    // The owner's own thread is the owner, never a bot.
    expect(attribute(entry(sendMessage('f', 5, 'x')), ctx(OWNER, false)).attribution).toBe('owner');
  });
});

describe('ThreadSync cursors and dedupe', () => {
  const c = { ownerId: OWNER };
  it('dedupes by entry id, keeps the CLI cursor, survives gap resets', () => {
    const s = new ThreadSync(COZ, 'Coz', false);
    const a = s.apply([sendMessage('t1', 1, 'one'), userMessage('t2', 2, 'two')], c, {});
    expect(a.fresh.map((m) => [m.key, m.attribution])).toEqual([
      [`${COZ}:t1`, 'thread-target'],
      [`${COZ}:t2`, 'owner'],
    ]);
    expect(s.cursor).toBe('t2');
    const b = s.apply([sendMessage('t3', 3, 'three')], c, { cursor: 't3' });
    expect(b.fresh.map((m) => m.entryId)).toEqual(['t3']);
    // Gap reset: the CLI returns the whole page again; only unseen entries come out.
    const g = s.apply(
      [sendMessage('t2', 2, 'two'), sendMessage('t3', 3, 'three'), sendMessage('t4', 4, 'four')],
      c,
      { cursor: 't4', gapReset: true },
    );
    expect(g.fresh.map((m) => m.entryId)).toEqual(['t4']);
    expect(g.duplicates).toBe(2);
    expect(s.gapResets).toBe(1);
    expect(s.messages).toHaveLength(4);
  });

  it('holds back a streaming entry and everything after it', () => {
    const s = new ThreadSync(COZ, 'Coz', false);
    const r = s.apply(
      [
        sendMessage('t1', 1, 'done'),
        assistantMessage('t2', 2, 'partial', { isStreaming: true }),
        sendMessage('t3', 3, 'later'),
      ],
      c,
      { cursor: 't3' },
    );
    expect(r.fresh.map((m) => m.entryId)).toEqual(['t1']);
    expect(s.cursor).toBe('t1');
    const r2 = s.apply([assistantMessage('t2', 2, 'complete'), sendMessage('t3', 3, 'later')], c, {
      cursor: 't3',
    });
    expect(r2.fresh.map((m) => [m.entryId, m.text])).toEqual([
      ['t2', 'complete'],
      ['t3', 'later'],
    ]);
  });

  it('counts malformed entries and never drops a well-formed one silently', () => {
    const s = new ThreadSync(COZ, 'Coz', false);
    const r = s.apply([null, 42, { nokind: true }, sendMessage('t1', 1, '   ')], c, {});
    expect(r.malformed).toBe(3);
    expect(r.fresh.map((m) => [m.text, m.placeholder])).toEqual([
      ['[empty message]', { type: 'text' }],
    ]);
  });
});

describe('GrokBotGatewayAdapter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('discovers bots and groups, marks the owner, syncs incrementally with cursors', async () => {
    const cli = new FakeCli();
    cli.threads.set(COZ, [
      thread(COZ, [sendMessage('t1', 1, 'hello'), userMessage('t2', 2, 'hi Coz')]),
      thread(COZ, [sendMessage('t3', 3, 'next')], { after: { cursor: 't3' } }),
    ]);
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    const got: LiveMessage[] = [];
    live.onMessages((m) => got.push(...m));
    await live.start();
    const st = live.status();
    expect(st.state).toBe('ok');
    expect(st.agents.find((a) => a.id === OWNER)?.owner).toBe(true);
    expect(st.agents.filter((a) => !a.owner)).toHaveLength(3);
    expect(st.groups).toEqual([{ id: GROUP, name: 'Test Team', memberIds: [COZ, KRYSTAL] }]);
    expect(st.threads).toHaveLength(5);
    expect(cli.calls.slice(0, 2).map((c) => c.cmd)).toEqual(['bots', 'groups']);

    // Round-robin: one thread every pollIdleMs (15 s), never two at once.
    await vi.advanceTimersByTimeAsync(15000 * 5);
    expect(cli.threadCalls()).toHaveLength(5);
    const firstCoz = cli.threadCalls(COZ)[0];
    expect(firstCoz).toEqual({ cmd: 'thread', id: COZ, limit: 20, after: undefined });
    await vi.advanceTimersByTimeAsync(15000 * 5);
    expect(cli.threadCalls(COZ)[1]).toEqual({ cmd: 'thread', id: COZ, limit: 50, after: 't2' });
    expect(got.filter((m) => m.threadId === COZ).map((m) => [m.entryId, m.attribution])).toEqual([
      ['t1', 'thread-target'],
      ['t2', 'owner'],
      ['t3', 'thread-target'],
    ]);
    live.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls the active thread at the faster interval', async () => {
    const cli = new FakeCli();
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start();
    live.setActiveThread(GROUP);
    await vi.advanceTimersByTimeAsync(60000);
    // 60 s: ~6 active polls (10 s) vs ~4 idle polls (15 s).
    expect(cli.threadCalls(GROUP).length).toBeGreaterThanOrEqual(5);
    expect(cli.threadCalls().length - cli.threadCalls(GROUP).length).toBeLessThanOrEqual(4);
    live.stop();
  });

  it('runs one CLI call at a time', async () => {
    const cli = new FakeCli();
    let release!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start();
    cli.override = async (c) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => (release = r));
      inFlight--;
      return thread((c as { id: string }).id, []);
    };
    await vi.advanceTimersByTimeAsync(15000);
    expect(inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(maxInFlight).toBe(1);
    expect(cli.threadCalls()).toHaveLength(1);
    release();
    live.stop();
  });

  it('backs off, then turns itself off after maxFailures and spawns nothing more', async () => {
    const cli = new FakeCli();
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start();
    cli.override = () => {
      throw new GrokBotCliError('timeout', 'The Grok Bot CLI did not answer in time.');
    };
    // The first thread poll runs 250 ms after discovery.
    await vi.advanceTimersByTimeAsync(250);
    expect(live.status()).toMatchObject({ state: 'degraded', consecutiveFailures: 1 });
    const t1 = Date.parse(live.status().nextRunAt!) - Date.now();
    expect(t1).toBe(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(Date.parse(live.status().nextRunAt!) - Date.now()).toBe(4000);
    await vi.advanceTimersByTimeAsync(4000);
    const st = live.status();
    expect(st.state).toBe('off-error');
    expect(st.counters.timeouts).toBe(3);
    expect(st.reason).toMatch(/turned itself off/);
    const n = cli.calls.length;
    await vi.advanceTimersByTimeAsync(3600000);
    expect(cli.calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);

    // Reconnect is the only way back.
    cli.override = undefined;
    await live.reconnect();
    expect(live.status()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    live.stop();
  });

  it('recovers from a transient failure', async () => {
    const cli = new FakeCli();
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start();
    let fail = true;
    cli.override = (c) => {
      if (fail) {
        fail = false;
        throw new GrokBotCliError('exit', 'gateway down');
      }
      return thread((c as { id: string }).id, []);
    };
    await vi.advanceTimersByTimeAsync(250);
    expect(live.status().state).toBe('degraded');
    await vi.advanceTimersByTimeAsync(2000);
    expect(live.status()).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    live.stop();
  });

  it('a CLI that goes missing mid-session turns Live Control off at once', async () => {
    const cli = new FakeCli();
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start();
    cli.override = () => {
      throw new GrokBotCliError('missing', 'The Grok Bot CLI was not found at GROKBOT_CLI_PATH.');
    };
    await vi.advanceTimersByTimeAsync(15000);
    expect(live.status()).toMatchObject({ state: 'unavailable', consecutiveFailures: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed verification spawns no CLI command at all', async () => {
    const cli = new FakeCli();
    cli.verifyError = new GrokBotCliError(
      'unverified',
      'The CLI repo is at abc1234, expected 9616503.',
    );
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start();
    expect(live.status()).toMatchObject({
      state: 'unavailable',
      lastError: expect.stringMatching(/abc1234/),
    });
    await vi.advanceTimersByTimeAsync(600000);
    expect(cli.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pause stops polling and resume continues it', async () => {
    const cli = new FakeCli();
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    await live.start({ paused: true });
    expect(live.status()).toMatchObject({ state: 'paused', paused: true });
    await vi.advanceTimersByTimeAsync(600000);
    expect(cli.calls).toEqual([]);
    live.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(cli.calls.map((c) => c.cmd)).toEqual(['bots', 'groups']);
    live.pause();
    const n = cli.calls.length;
    await vi.advanceTimersByTimeAsync(600000);
    expect(cli.calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
    live.stop();
  });

  it('rejects a thread answer for a different target', async () => {
    const cli = new FakeCli();
    cli.threads.set(COZ, [thread(KRYSTAL, [sendMessage('x', 1, 'wrong thread')])]);
    const live = new GrokBotGatewayAdapter(cfg(), cli);
    const got: LiveMessage[] = [];
    live.onMessages((m) => got.push(...m));
    await live.start();
    await vi.advanceTimersByTimeAsync(15000 * 5);
    expect(got).toEqual([]);
    expect(live.status().lastError).toMatch(/different thread/);
    live.stop();
  });
});
