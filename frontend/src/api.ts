import { SimulationProvider } from '../../shared/simProvider';
import { roster } from '../../shared/roster';
import { splitSessions, type ReplaySession } from '../../shared/replay';
import type { Appearance, BotEvent, OfficeLayout } from '../../shared/types';
import type { Progression } from '../../shared/progression';
import { loadLocal, saveLocal, useStore, type Settings, type SourcesStatus } from './store';

let source: EventSource | undefined;
let fallbackSim: SimulationProvider | undefined;
let fallbackTimer: number | undefined;
let retryTimer: number | undefined;
let backendUp = false;

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
};

async function healthy() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('/api/health', { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/** Fallback: run the simulation provider in the browser when no backend is reachable. */
function startFallback() {
  if (fallbackSim) return;
  useStore.getState().setConnection('fallback');
  fallbackSim = new SimulationProvider(roster, {
    seed: Date.now() & 0xffff,
    prefix: `local${Date.now().toString(36)}`,
  });
  const log = loadLocal<BotEvent[]>('fallback-log') ?? [];
  useStore.getState().ingest(log.slice(-800), { snapshot: true });
  fallbackTimer = window.setInterval(() => {
    const evs = fallbackSim!.tick(Date.now());
    if (!evs.length) return;
    useStore.getState().ingest(evs);
    const next = [...(loadLocal<BotEvent[]>('fallback-log') ?? []), ...evs].slice(-3000);
    saveLocal('fallback-log', next);
  }, 1000);
  scheduleRetry();
}
function stopFallback() {
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = undefined;
  fallbackSim = undefined;
}
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = window.setTimeout(async () => {
    retryTimer = undefined;
    if (await healthy()) connectStream();
    else scheduleRetry();
  }, 10000);
}

function connectStream() {
  source?.close();
  const es = new EventSource('/api/stream');
  source = es;
  let opened = false;
  es.addEventListener('snapshot', (m) => {
    opened = true;
    backendUp = true;
    stopFallback();
    const data = JSON.parse((m as MessageEvent).data) as {
      events: BotEvent[];
      sources: SourcesStatus;
    };
    const st = useStore.getState();
    st.setConnection('backend');
    st.setSources(data.sources);
    st.ingest(data.events, { snapshot: true });
  });
  es.addEventListener('event', (m) =>
    useStore.getState().ingest([JSON.parse((m as MessageEvent).data)]),
  );
  es.addEventListener('sources', (m) =>
    useStore.getState().setSources(JSON.parse((m as MessageEvent).data)),
  );
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED || !opened) {
      es.close();
      backendUp = false;
      startFallback();
    } else {
      // EventSource reconnects by itself; if it stays down, fall back.
      setTimeout(() => {
        if (es.readyState !== EventSource.OPEN) {
          es.close();
          backendUp = false;
          startFallback();
        }
      }, 6000);
    }
  };
}

const persisted = ['layout', 'appearances', 'progression', 'settings'] as const;

async function loadBackendState() {
  const st = useStore.getState();
  for (const key of persisted) {
    try {
      const { value } = await json<{ value: unknown }>(`/api/state/${key}`);
      if (!value) continue;
      if (key === 'layout') useStore.setState({ layout: value as OfficeLayout });
      if (key === 'appearances')
        useStore.setState({
          appearances: { ...st.appearances, ...(value as Record<string, Appearance>) },
        });
      if (key === 'progression') useStore.setState({ progression: value as Progression });
      if (key === 'settings') {
        const v = value as Settings;
        useStore.setState({
          settings: {
            ...st.settings,
            ...v,
            audio: { ...st.settings.audio, ...v.audio, enabled: false },
          },
        });
      }
    } catch {
      /* keep local copy */
    }
  }
}

function persistChanges() {
  const timers: Record<string, number> = {};
  useStore.subscribe((s, prev) => {
    for (const key of persisted) {
      if (s[key] === prev[key]) continue;
      clearTimeout(timers[key]);
      timers[key] = window.setTimeout(() => {
        const value = useStore.getState()[key];
        saveLocal(key, value);
        if (backendUp)
          void json(`/api/state/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }).catch(
            () => undefined,
          );
      }, 600);
    }
  });
}

export async function startConnection() {
  const up = await healthy();
  if (up) {
    backendUp = true;
    await loadBackendState();
    connectStream();
  } else startFallback();
  persistChanges();
}

export const api = {
  get backend() {
    return backendUp;
  },
  async setSimulation(enabled: boolean) {
    if (!backendUp)
      throw new Error(
        'The local backend is not running (browser fallback simulation is always on).',
      );
    useStore
      .getState()
      .setSources(
        await json('/api/sources/simulation', {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        }),
      );
  },
  async setLocalCache(dir: string | null, authorize: boolean) {
    if (!backendUp) throw new Error('Local cache access requires the local backend (npm run dev).');
    useStore
      .getState()
      .setSources(
        await json('/api/sources/local', {
          method: 'POST',
          body: JSON.stringify({ dir, authorize }),
        }),
      );
  },
  async simulateMeeting(participants?: string[], title?: string) {
    if (backendUp)
      return json('/api/simulate/meeting', {
        method: 'POST',
        body: JSON.stringify({ participants, title }),
      });
    const evs = fallbackSim?.startMeeting(Date.now(), participants, title) ?? [];
    if (!evs.length) throw new Error('A meeting is already running, or not enough Bots are free.');
    useStore.getState().ingest(evs);
    return { ok: true };
  },
  async sessions(): Promise<ReplaySession[]> {
    if (backendUp) return (await json<{ sessions: ReplaySession[] }>('/api/sessions')).sessions;
    return splitSessions(loadLocal<BotEvent[]>('fallback-log') ?? []).reverse();
  },
  async range(from: number, to: number): Promise<BotEvent[]> {
    if (backendUp)
      return (await json<{ events: BotEvent[] }>(`/api/events?from=${from}&to=${to}&limit=50000`))
        .events;
    return (loadLocal<BotEvent[]>('fallback-log') ?? []).filter((e) => {
      const t = Date.parse(e.timestamp);
      return t >= from && t <= to;
    });
  },
};
