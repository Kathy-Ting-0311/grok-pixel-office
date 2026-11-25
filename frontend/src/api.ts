import { SimulationProvider } from '../../shared/simProvider';
import { roster } from '../../shared/roster';
import { splitSessions, type ReplaySession } from '../../shared/replay';
import type { Appearance, BotEvent, OfficeLayout } from '../../shared/types';
import type { Progression } from '../../shared/progression';
import { loadLocal, saveLocal, useStore, type Settings, type SourcesStatus } from './store';
import { setLiveControlEnabled } from './live/liveFlag';

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
    if (await healthy()) void connectStream();
    else scheduleRetry();
  }, 10000);
}

/**
 * The stream URL with a one-time ticket. The access token goes only in a request header, never in a URL (URLs
 * reach the dev proxy's log). 'token-needed' when the server refuses the token; servers without tickets still work.
 */
async function streamUrl(): Promise<string> {
  try {
    const r = await fetch('/api/stream-ticket', {
      method: 'POST',
      headers: { 'x-office-token': loadLocal<string>('office-token') ?? '' },
    });
    if (r.status === 401) return 'token-needed';
    const ticket = r.ok ? ((await r.json()) as { ticket?: string }).ticket : undefined;
    return ticket ? `/api/stream?ticket=${encodeURIComponent(ticket)}` : '/api/stream';
  } catch {
    return '/api/stream';
  }
}

/** The server needs its access token: say so and wait. Never start the browser simulation for this. */
function tokenNeeded() {
  stopFallback();
  useStore.getState().setConnection('token-needed');
}

/** Save the access token (same key as placed tasks) and connect again. */
export function unlockStream(token: string) {
  saveLocal('office-token', token);
  void connectStream();
}

let streamFailures = 0;
async function recoverStream() {
  // A ticket works once, so reconnect with a fresh one; fall back only when the server is really down.
  if (++streamFailures <= 3 && (await healthy())) return void connectStream();
  backendUp = false;
  startFallback();
}

async function connectStream() {
  source?.close();
  const url = await streamUrl();
  if (url === 'token-needed') return tokenNeeded();
  const es = new EventSource(url);
  source = es;
  let opened = false;
  es.addEventListener('snapshot', (m) => {
    opened = true;
    streamFailures = 0;
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
    setLiveControlEnabled((data as { liveControl?: boolean }).liveControl === true);
  });
  es.addEventListener('event', (m) =>
    useStore.getState().ingest([JSON.parse((m as MessageEvent).data)]),
  );
  es.addEventListener('sources', (m) =>
    useStore.getState().setSources(JSON.parse((m as MessageEvent).data)),
  );
  es.onerror = () => {
    // Never let EventSource reconnect on its own with a used ticket; decide here instead.
    es.close();
    if (source !== es) return;
    window.setTimeout(() => void recoverStream(), opened ? 3000 : 0);
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
    void connectStream();
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
    useStore.getState().setSources(
      await json('/api/sources/simulation', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    );
  },
  async setLocalCache(dir: string | null, authorize: boolean) {
    if (!backendUp) throw new Error('Local cache access requires the local backend (npm run dev).');
    useStore.getState().setSources(
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

// ---- Placed tasks (local server only; the xAI key never leaves the server) ----
export type PlacedTask = {
  id: number;
  title: string;
  details: string;
  agent: string;
  requestedAgent: string;
  priority: 'low' | 'normal' | 'high';
  maxCostUsd: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  attempt: number;
  mock: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model?: string;
};
export type TaskBoard = {
  tasks: PlacedTask[];
  budget: { spentUsd: number; dailyBudgetUsd: number; remainingUsd: number; exhausted: boolean };
  config: {
    mock: boolean;
    model: string;
    maxTokensPerTask: number;
    estimateMaxCostUsd: number;
    tokenRequired: boolean;
  };
};
export class TaskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
  }
}
const officeToken = () => loadLocal<string>('office-token') ?? '';
async function taskCall<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-office-token': officeToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string; field?: string };
  if (!r.ok)
    throw new TaskApiError(data.error ?? `Request failed (HTTP ${r.status})`, r.status, data.field);
  return data as T;
}
export const tasksApi = {
  board: () => taskCall<TaskBoard>('/api/tasks'),
  create: (t: { title: string; details?: string; agent: string; priority: string }) =>
    taskCall<PlacedTask>('/api/tasks', t),
  cancel: (id: number) => taskCall<PlacedTask>(`/api/tasks/${id}/cancel`, {}),
  retry: (id: number) => taskCall<PlacedTask>(`/api/tasks/${id}/retry`, {}),
  setToken: (token: string) => saveLocal('office-token', token),
};

// ---- Direct chat with one Bot (local server only) ----
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'note';
  text: string;
  ts: string;
  mock: boolean;
  taskId?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
};
export type ChatInfo = {
  messages: ChatMessage[];
  busy: boolean;
  mock: boolean;
  budget: TaskBoard['budget'];
};
type ChatEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'thinking'; data: object }
  | { event: 'task'; data: { task: PlacedTask; message: ChatMessage } }
  | { event: 'done'; data: { message: ChatMessage } }
  | { event: 'error'; data: { error: string } };
export const chatApi = {
  history: (botId: string) => taskCall<ChatInfo>(`/api/chat/${botId}`),
  async clear(botId: string) {
    const r = await fetch(`/api/chat/${botId}`, {
      method: 'DELETE',
      headers: { 'x-office-token': officeToken() },
    });
    if (!r.ok)
      throw new TaskApiError(
        ((await r.json().catch(() => ({}))) as { error?: string }).error ??
          'Could not clear the chat.',
        r.status,
      );
  },
  /** Sends a message and calls onEvent for each streamed event. Resolves when the reply ends. */
  async send(botId: string, text: string, onEvent: (e: ChatEvent) => void, signal: AbortSignal) {
    const r = await fetch(`/api/chat/${botId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-office-token': officeToken() },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!r.ok || !r.body) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new TaskApiError(data.error ?? `Request failed (HTTP ${r.status})`, r.status);
    }
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) onEvent({ event, data: JSON.parse(data) } as ChatEvent);
      }
    }
  },
};

// ---- Results board (saved outputs of finished tasks) ----
export type OutputType = 'text' | 'markdown' | 'code' | 'image' | 'file';
export type ResultStatus = 'done' | 'failed' | 'cancelled';
export type ResultEntry = {
  id: number;
  title: string;
  agent: string;
  time: string;
  status: ResultStatus;
  type: OutputType;
  cost: number;
  pinned: boolean;
  read: boolean;
  /** 'grok-desktop' for results saved from Grok Bot Desktop; absent for xAI task results. */
  src?: 'grok-desktop';
};
export type ResultRecord = {
  task_id: number;
  title: string;
  details: string;
  agent: string;
  created_at: string;
  finished_at: string;
  status: ResultStatus;
  output_type: OutputType;
  output: string;
  language?: string;
  summary?: string;
  error?: string;
  files: { name: string; size: number; type: string }[];
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
  mock: boolean;
  /** Grok Desktop results: where the saved reply came from (no URLs: attachments are not reachable). */
  source?: {
    kind: 'grok-desktop';
    agentId: string;
    agentName: string;
    messageKey: string;
    timestamp: string;
    attribution: string;
    attachments: { name: string; type: string }[];
  };
};
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      'x-office-token': officeToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new TaskApiError(data.error ?? `Request failed (HTTP ${r.status})`, r.status);
  return data as T;
}
/** Links for <img>/downloads cannot send headers, so the optional token goes in the query. */
const withToken = (url: string) => {
  const t = officeToken();
  return t ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : url;
};
export const resultsApi = {
  list: () => call<{ keep: number; results: ResultEntry[] }>('GET', '/api/results'),
  get: (id: number) => call<ResultRecord>('GET', `/api/results/${id}`),
  patch: (id: number, p: { pinned?: boolean; read?: boolean }) =>
    call<ResultEntry>('PATCH', `/api/results/${id}`, p),
  remove: (id: number) => call<{ ok: true }>('DELETE', `/api/results/${id}`),
  rerun: (id: number) => call<PlacedTask>('POST', `/api/results/${id}/rerun`),
  setKeep: (keep: number) => call<{ keep: number }>('PUT', '/api/results/settings', { keep }),
  fileUrl: (id: number, name: string, download = false) =>
    withToken(
      `/api/results/${id}/files/${encodeURIComponent(name)}${download ? '?download=1' : ''}`,
    ),
  downloadUrl: (id: number) => withToken(`/api/results/${id}/download`),
  exportUrl: (kind: 'md' | 'zip') => withToken(`/api/results/export.${kind}`),
  /** "/task ..." or Make-it-a-task from the chat box. */
  chatTask: (botId: string, text: string) =>
    call<{ task: PlacedTask; messages: ChatMessage[] }>('POST', `/api/chat/${botId}/task`, {
      text,
    }),
};
