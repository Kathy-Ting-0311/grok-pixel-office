import { SimulationProvider } from '../../shared/simProvider';
import { roster } from '../../shared/roster';
import type { BotEvent } from '../../shared/types';
import type { Store } from './db';
import { LocalCacheProvider, type LocalCacheStatus } from './localCache';

/**
 * Provider C — Official API adapter (placeholder interface only).
 * No official Grok Bot activity/event API is documented or verified, so this adapter is
 * intentionally unavailable. It exists so a future, documented integration can be dropped in
 * without touching the rest of the pipeline. It does not call any endpoint.
 */
export interface EventProvider {
  readonly id: 'local-cache' | 'simulation' | 'official-api';
  readonly available: boolean;
  readonly reason?: string;
}
export class OfficialApiAdapter implements EventProvider {
  readonly id = 'official-api' as const;
  readonly available = false;
  readonly reason =
    'No official Grok Bot event API is documented. Nothing is called; this is an interface for a future integration.';
  connect(): never {
    throw new Error(this.reason);
  }
}

export type SourcesStatus = {
  simulation: { enabled: boolean; startedAt?: string };
  localCache: LocalCacheStatus;
  officialApi: { available: false; reason: string };
  storedEvents: number;
};

export class ProviderManager {
  private sim?: SimulationProvider;
  private simTimer?: NodeJS.Timeout;
  private simStartedAt?: string;
  readonly local: LocalCacheProvider;
  readonly api = new OfficialApiAdapter();
  private listeners = new Set<(e: BotEvent) => void>();
  private held = new Set<string>();

  constructor(private readonly store: Store) {
    this.local = new LocalCacheProvider(new Set(roster.map((b) => b.id)), (e) => this.publish(e));
  }

  subscribe(fn: (e: BotEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Persist + broadcast. Returns false for duplicates. */
  publish(e: BotEvent) {
    if (!this.store.addEvent(e)) return false;
    for (const l of this.listeners) l(e);
    return true;
  }

  setSimulation(enabled: boolean) {
    if (enabled && !this.sim) {
      this.sim = new SimulationProvider(roster, {
        seed: Date.now() & 0xffff,
        prefix: `sim${Date.now().toString(36)}`,
      });
      this.held.forEach((id) => this.sim!.held.add(id));
      this.simStartedAt = new Date().toISOString();
      this.simTimer = setInterval(() => {
        for (const e of this.sim!.tick(Date.now())) this.publish(e);
      }, 1000);
    } else if (!enabled && this.sim) {
      clearInterval(this.simTimer);
      this.sim = undefined;
      this.simTimer = undefined;
      this.simStartedAt = undefined;
    }
    this.store.setState('source:simulation', { enabled });
  }

  /** Keep the demo simulation away from a Bot that is running a placed task. */
  hold(botId: string, on: boolean) {
    if (on) this.held.add(botId);
    else this.held.delete(botId);
    if (on) this.sim?.held.add(botId);
    else this.sim?.held.delete(botId);
  }

  simulatedMeeting(participants?: string[], title?: string) {
    if (!this.sim)
      return {
        ok: false as const,
        reason: 'Turn on the simulation provider to run a demo meeting.',
      };
    const events = this.sim.startMeeting(Date.now(), participants, title);
    if (!events.length)
      return {
        ok: false as const,
        reason: 'A meeting is already running, or not enough Bots are free.',
      };
    events.forEach((e) => this.publish(e));
    return { ok: true as const };
  }

  async setLocalCache(dir: string | null) {
    if (!dir) {
      this.local.stop();
      this.store.setState('source:local', null);
      return;
    }
    const authorizedAt = new Date().toISOString();
    await this.local.start(dir, authorizedAt);
    this.store.setState('source:local', { dir, authorizedAt });
  }

  status(): SourcesStatus {
    return {
      simulation: { enabled: !!this.sim, startedAt: this.simStartedAt },
      localCache: this.local.status,
      officialApi: { available: false, reason: this.api.reason },
      storedEvents: this.store.count(),
    };
  }

  async restore(defaults: { simulation: boolean; cacheDir?: string }) {
    const sim = this.store.getState<{ enabled: boolean }>('source:simulation');
    this.setSimulation(sim ? sim.enabled : defaults.simulation);
    const local = this.store.getState<{ dir: string } | null>('source:local');
    const dir = defaults.cacheDir ?? local?.dir;
    if (dir)
      await this.setLocalCache(dir).catch(
        (err) =>
          (this.local.status = {
            ...this.local.status,
            state: 'error',
            dir,
            lastError: String(err?.message ?? err),
          }),
      );
  }

  stop() {
    this.setSimulation(false);
    this.local.stop();
  }
}
