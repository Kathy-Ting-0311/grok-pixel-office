import { useCallback, useEffect, useState } from 'react';
import { BookmarkPlus, Check, ListPlus, RotateCcw, X } from 'lucide-react';
import { desktopTaskState, type DesktopTaskState } from '../../../shared/desktopTasks';
import type { LiveMessage } from '../../../shared/liveControl';
import { loadLocal, useStore } from '../store';
import { useResults } from '../ui/results';

/**
 * Manual Grok Bot Desktop actions: "Save as Result" on a real bot reply, "Track as Task" on your own message,
 * and a tracked-task list with "Mark as Completed" and result linking. Everything goes through the local server;
 * nothing here calls Grok Bot, and nothing is saved or marked done without a click.
 */

export type DesktopTask = {
  id: string;
  agentId: string;
  requestKey: string;
  title: string;
  requestedAt: string;
  resultIds: number[];
  completedAt?: string;
};
type SavedResult = { id: number; title: string };

const call = async <T,>(url: string, method = 'GET', body?: unknown): Promise<T> => {
  const r = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-office-token': loadLocal<string>('office-token') ?? '',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
};

/** Saved-result keys and tracked tasks for one bot thread, refreshed with the transcript. */
export function useDesktop(threadId: string | undefined, refreshKey: unknown) {
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [tasks, setTasks] = useState<DesktopTask[]>([]);
  const [results, setResults] = useState<SavedResult[]>([]);
  // Also reload when the Results board saves or deletes something, so links never point at a deleted result.
  const resultsVersion = useResults((r) => r.entries.map((e) => e.id).join(','));
  const load = useCallback(async () => {
    if (!threadId) return;
    const [s, t] = await Promise.all([
      call<{ saved: Record<string, number> }>(
        `/api/live-control/desktop/saved?thread=${encodeURIComponent(threadId)}`,
      ),
      call<{ tasks: DesktopTask[] }>(
        `/api/live-control/desktop/tasks?agent=${encodeURIComponent(threadId)}`,
      ),
    ]);
    setSaved(s.saved);
    setTasks(t.tasks);
    const ids = new Set(Object.values(s.saved));
    const list = await call<{ results: { id: number; title: string }[] }>('/api/results');
    setResults(
      list.results.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, title: r.title })),
    );
  }, [threadId]);
  useEffect(() => void load().catch(() => {}), [load, refreshKey, resultsVersion]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) useStore.getState().toast(ok, 'good');
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'warn');
    }
    await load().catch(() => {});
  };
  return {
    saved,
    tasks,
    results,
    saveResult: (key: string) =>
      run(async () => {
        const r = await call<{ id: number; duplicate: boolean }>(
          '/api/live-control/desktop/results',
          'POST',
          { key },
        );
        useStore
          .getState()
          .toast(
            r.duplicate ? `Already saved as result #${r.id}.` : `Saved as result #${r.id}.`,
            'good',
          );
      }),
    track: (key: string) =>
      run(() => call('/api/live-control/desktop/tasks', 'POST', { key }), 'Tracked as a task.'),
    update: (id: string, p: { completed?: boolean; resultIds?: number[] }) =>
      run(() => call(`/api/live-control/desktop/tasks/${id}`, 'PATCH', p)),
    remove: (id: string) =>
      run(() => call(`/api/live-control/desktop/tasks/${id}`, 'DELETE'), 'No longer tracked.'),
  };
}

const small =
  'inline-flex items-center gap-0.5 rounded px-1 text-[9px] font-bold text-stone-500 hover:bg-paper hover:text-ink';

/** "Save as Result" under a real bot reply, "Track as Task" under your own message. */
export function MessageActions({
  m,
  desktop,
}: {
  m: LiveMessage;
  desktop: ReturnType<typeof useDesktop>;
}) {
  const bot = m.attribution === 'verified' || m.attribution === 'thread-target';
  if (bot && (!m.placeholder || m.attachment)) {
    const id = desktop.saved[m.key];
    return id ? (
      <span className={small} data-testid="live-saved">
        <Check size={9} /> Saved as #{id}
      </span>
    ) : (
      <button
        type="button"
        className={small}
        onClick={() => void desktop.saveResult(m.key)}
        data-testid="live-save-result"
      >
        <BookmarkPlus size={9} /> Save as Result
      </button>
    );
  }
  if (m.attribution === 'owner' && !m.placeholder && !m.isGroup) {
    const tracked = desktop.tasks.some((t) => t.requestKey === m.key);
    return tracked ? (
      <span className={small} data-testid="live-tracked">
        <Check size={9} /> Tracked
      </span>
    ) : (
      <button
        type="button"
        className={small}
        onClick={() => void desktop.track(m.key)}
        data-testid="live-track-task"
      >
        <ListPlus size={9} /> Track as Task
      </button>
    );
  }
  return null;
}

const stateLook: Record<DesktopTaskState, [string, string]> = {
  tracked: ['bg-stone-200 text-stone-700', 'Tracked'],
  working: ['bg-sky-200 text-sky-900', 'Working'],
  'waiting-input': ['bg-amber-200 text-amber-900', 'Waiting for your input'],
  'result-available': ['bg-violet-200 text-violet-900', 'Result available'],
  completed: ['bg-emerald-200 text-emerald-900', 'Completed'],
};

/** Tracked Desktop tasks for this bot. Completion is only ever set by the user. */
export function TrackedTasks({
  messages,
  desktop,
}: {
  messages: LiveMessage[];
  desktop: ReturnType<typeof useDesktop>;
}) {
  if (!desktop.tasks.length) return null;
  return (
    <ul
      className="mb-1 space-y-1"
      aria-label="Tracked Grok Desktop tasks"
      data-testid="desktop-tasks"
    >
      {desktop.tasks.map((t) => {
        const { state, basis } = desktopTaskState(t, messages);
        const [chip, label] = stateLook[state];
        const linkable = desktop.results.filter((r) => !t.resultIds.includes(r.id));
        return (
          <li
            key={t.id}
            className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]"
            data-testid="desktop-task"
          >
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-bold">{t.title}</span>
              <span className={`chip ${chip}`} title={basis} data-testid="desktop-task-state">
                {label}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-stone-600">
              {t.resultIds.map((id) => (
                <span key={id} className="rounded bg-violet-50 px-1">
                  result #{id}
                </span>
              ))}
              {linkable.length > 0 && (
                <select
                  className="field !min-h-0 !py-0 !text-[10px]"
                  value=""
                  onChange={(e) =>
                    void desktop.update(t.id, {
                      resultIds: [...t.resultIds, Number(e.target.value)],
                    })
                  }
                  aria-label="Link a saved result"
                  data-testid="desktop-task-link"
                >
                  <option value="">Link a saved result…</option>
                  {linkable.map((r) => (
                    <option key={r.id} value={r.id}>
                      #{r.id} {r.title}
                    </option>
                  ))}
                </select>
              )}
              <span className="ml-auto flex gap-1">
                {t.completedAt ? (
                  <button
                    type="button"
                    className={small}
                    onClick={() => void desktop.update(t.id, { completed: false })}
                  >
                    <RotateCcw size={9} /> Reopen
                  </button>
                ) : (
                  <button
                    type="button"
                    className={small}
                    onClick={() => void desktop.update(t.id, { completed: true })}
                    data-testid="desktop-task-complete"
                  >
                    <Check size={9} /> Mark as Completed
                  </button>
                )}
                <button
                  type="button"
                  className={small}
                  onClick={() => void desktop.remove(t.id)}
                  aria-label="Stop tracking"
                >
                  <X size={9} />
                </button>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
