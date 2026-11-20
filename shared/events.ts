import { z } from 'zod';
import { botEventTypes, type BotEvent, type EventSource, type Meeting, type Task, type TaskStatus } from './types';

export const eventSourceSchema = z.enum(['real', 'simulated', 'replayed', 'unknown']);
export const botEventSchema = z.object({
  id: z.string().min(1).max(200),
  botId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200).optional(),
  timestamp: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp'),
  type: z.enum(botEventTypes),
  source: eventSourceSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Classify an externally supplied record. Only an explicit, recognised claim keeps its label;
 * anything else is UNKNOWN. A provider can never upgrade a record to REAL by itself.
 */
export function classifySource(claimed: unknown, allowReal: boolean): EventSource {
  if (claimed === 'simulated') return 'simulated';
  if (claimed === 'real' && allowReal) return 'real';
  return 'unknown';
}

/** Order by timestamp, then id, so replay and reducers are deterministic. */
export const compareEvents = (a: BotEvent, b: BotEvent) => {
  const d = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Bounded set for duplicate suppression across reconnects/file re-reads. */
export class Deduper {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(private limit = 20000) {}
  /** True when the id is new. */
  add(id: string) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.limit) this.seen.delete(this.order.shift()!);
    return true;
  }
  has(id: string) {
    return this.seen.has(id);
  }
}

export type TaskState = {
  tasks: Record<string, Task>;
  meetings: Record<string, Meeting>;
  botStatus: Record<string, { status: string; source: EventSource; timestamp: string }>;
  lastEventAt: Record<EventSource, string | undefined>;
  applied: number;
};

export const emptyTaskState = (): TaskState => ({
  tasks: {},
  meetings: {},
  botStatus: {},
  lastEventAt: { real: undefined, simulated: undefined, replayed: undefined, unknown: undefined },
  applied: 0,
});

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const progressOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

const terminal = (s: TaskStatus) => s === 'completed' || s === 'failed';

/** Pure reducer: apply one event. Unknown/out-of-order transitions never invent completion. */
export function applyEvent(state: TaskState, e: BotEvent): TaskState {
  const tasks = { ...state.tasks };
  const meetings = { ...state.meetings };
  const botStatus = { ...state.botStatus };
  const lastEventAt = { ...state.lastEventAt };
  const prevLast = lastEventAt[e.source];
  if (!prevLast || Date.parse(prevLast) < Date.parse(e.timestamp)) lastEventAt[e.source] = e.timestamp;
  const p = e.payload ?? {};
  const taskId = e.taskId;
  const existing = taskId ? tasks[taskId] : undefined;
  const base = (status: TaskStatus): Task => ({
    id: taskId!,
    title: str(p.title, existing?.title ?? 'Untitled task'),
    botId: e.botId,
    status,
    source: e.source,
    createdAt: existing?.createdAt ?? e.timestamp,
    startedAt: existing?.startedAt,
    completedAt: existing?.completedAt,
    progress: existing?.progress ?? null,
    summary: str(p.summary, existing?.summary ?? '') || undefined,
    lastUpdated: e.timestamp,
  });
  switch (e.type) {
    case 'task_created':
      if (taskId && !existing) tasks[taskId] = base('pending');
      break;
    case 'task_started':
      if (taskId && (!existing || !terminal(existing.status)))
        tasks[taskId] = { ...base('active'), startedAt: existing?.startedAt ?? e.timestamp, progress: progressOf(p.progress) ?? existing?.progress ?? null };
      break;
    case 'task_updated':
      if (taskId && existing && !terminal(existing.status)) {
        const progress = progressOf(p.progress);
        tasks[taskId] = { ...base(existing.status), progress: progress ?? existing.progress };
      }
      break;
    case 'task_completed':
      if (taskId) tasks[taskId] = { ...base('completed'), completedAt: e.timestamp, progress: existing?.progress != null ? 1 : null };
      break;
    case 'task_failed':
      if (taskId) tasks[taskId] = { ...base('failed'), completedAt: e.timestamp };
      break;
    case 'meeting_started': {
      const id = str(p.meetingId, e.id);
      const participants = Array.isArray(p.participants) ? p.participants.filter((x): x is string => typeof x === 'string') : [e.botId];
      meetings[id] = {
        id,
        title: str(p.title, 'Team meeting'),
        participants,
        state: 'in_progress',
        source: e.source,
        startedAt: e.timestamp,
        messages: meetings[id]?.messages ?? [],
      };
      break;
    }
    case 'meeting_ended': {
      const id = str(p.meetingId, '');
      if (meetings[id]) meetings[id] = { ...meetings[id], state: 'ended', endedAt: e.timestamp };
      break;
    }
    case 'message': {
      const id = str(p.meetingId, '');
      if (id && meetings[id]) {
        meetings[id] = {
          ...meetings[id],
          messages: [...meetings[id].messages, { botId: e.botId, text: str(p.text), timestamp: e.timestamp, source: e.source }].slice(-200),
        };
      }
      break;
    }
    case 'status_changed':
      botStatus[e.botId] = { status: str(p.status, 'unknown'), source: e.source, timestamp: e.timestamp };
      break;
  }
  return { tasks, meetings, botStatus, lastEventAt, applied: state.applied + 1 };
}

export const reduceEvents = (events: BotEvent[], initial = emptyTaskState()) => [...events].sort(compareEvents).reduce(applyEvent, initial);

export type TaskFilter = {
  botId?: string;
  status?: TaskStatus;
  source?: EventSource;
  /** Only tasks updated within the last N ms of `now`. */
  periodMs?: number;
  now?: number;
};

export function filterTasks(tasks: Task[], f: TaskFilter) {
  const now = f.now ?? Date.now();
  return tasks.filter(
    (t) =>
      (!f.botId || t.botId === f.botId) &&
      (!f.status || t.status === f.status) &&
      (!f.source || t.source === f.source) &&
      (!f.periodMs || now - Date.parse(t.lastUpdated) <= f.periodMs),
  );
}

/**
 * Completion rate = completed / eligible × 100, where ELIGIBLE = every task in scope that has been
 * observed in any state (pending + active + completed + failed). Individual progress is not used.
 */
export function taskStats(tasks: Task[]) {
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const completed = count('completed');
  const eligible = tasks.length;
  return {
    total: tasks.length,
    active: count('active'),
    pending: count('pending'),
    completed,
    failed: count('failed'),
    eligible,
    completionRate: eligible ? (completed / eligible) * 100 : null,
  };
}

export function durationMs(t: Task, now = Date.now()) {
  if (!t.startedAt) return null;
  const end = t.completedAt ? Date.parse(t.completedAt) : now;
  return Math.max(0, end - Date.parse(t.startedAt));
}

/** The current task a Bot should visually work on (most recently started active task). */
export function activeTaskFor(state: TaskState, botId: string) {
  let best: Task | undefined;
  for (const t of Object.values(state.tasks))
    if (t.botId === botId && t.status === 'active' && (!best || (t.startedAt ?? '') > (best.startedAt ?? ''))) best = t;
  return best;
}
