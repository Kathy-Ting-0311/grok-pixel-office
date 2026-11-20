import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { ChevronDown, ChevronRight, RotateCcw, Send, X } from 'lucide-react';
import { botById, roster } from '../../../shared/roster';
import { api, TaskApiError, tasksApi, type PlacedTask, type TaskBoard } from '../api';
import { useStore } from '../store';
import { fmtTime, SourceBadge } from './common';

// "Place a task": threads (top of the Conversation tab) + a compact form pinned to the panel bottom.

export const statusCls: Record<PlacedTask['status'], string> = {
  queued: 'bg-stone-200 text-stone-800',
  running: 'bg-amber-200 text-amber-900',
  done: 'bg-emerald-200 text-emerald-900',
  failed: 'bg-rose-200 text-rose-900',
  cancelled: 'bg-stone-200 text-stone-600',
};
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export const useBoard = create<{
  board: TaskBoard | null;
  loadError: string | null;
  needsToken: boolean;
  /** Expanded threads; tasks placed in this session start open. */
  open: Record<number, boolean>;
  refresh: () => Promise<void>;
}>((set) => ({
  board: null,
  open: {},
  loadError: null,
  needsToken: false,
  refresh: async () => {
    try {
      set({ board: await tasksApi.board(), loadError: null, needsToken: false });
    } catch (err) {
      if (err instanceof TaskApiError && err.status === 401) set({ needsToken: true });
      else set({ loadError: err instanceof Error ? err.message : String(err) });
    }
  },
}));

/** Keeps the board fresh: refetch when a placed-task event arrives over SSE, plus a slow fallback poll. */
let syncUsers = 0;
/** Safe to call from several components: only the first mounted one subscribes. */
export function useBoardSync() {
  useEffect(() => {
    if (!api.backend || syncUsers++ > 0)
      return () => {
        syncUsers--;
      };
    const { refresh } = useBoard.getState();
    void refresh();
    let t: number | undefined;
    const off = useStore.subscribe((s, prev) => {
      // The event list is capped, so look at its tail rather than diffing lengths.
      if (
        s.events !== prev.events &&
        s.events.slice(-12).some((e) => e.payload?.placedTaskId !== undefined)
      ) {
        clearTimeout(t);
        t = window.setTimeout(refresh, 150);
      }
    });
    const poll = window.setInterval(refresh, 10000);
    return () => {
      syncUsers--;
      off();
      clearTimeout(t);
      clearInterval(poll);
    };
  }, []);
}

export function TaskThreads() {
  const board = useBoard((s) => s.board);
  const conversations = useStore((s) => s.conversations);
  const open = useBoard((s) => s.open);
  const setOpen = (id: number, v: boolean) =>
    useBoard.setState((s) => ({ open: { ...s.open, [id]: v } }));
  const [error, setError] = useState<string | null>(null);
  if (!board?.tasks.length) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await useBoard.getState().refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <ul className="mb-2 space-y-1" data-testid="task-threads" aria-label="Placed tasks">
      {error && (
        <li className="text-[11px] font-bold text-rose-700" role="alert">
          {error}
        </li>
      )}
      {board.tasks.slice(0, 12).map((t) => {
        const expanded = open[t.id] ?? t.status === 'running';
        const lines = conversations
          .filter((l) => l.taskId === `placed-${t.id}.${t.attempt}`)
          .slice(-6);
        return (
          <li
            key={t.id}
            className="rounded border border-ink/15 bg-white text-xs"
            data-testid={`thread-${t.id}`}
          >
            <div className="flex items-center gap-1 px-1.5 py-1">
              <button
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                onClick={() => setOpen(t.id, !expanded)}
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate font-bold">
                  #{t.id} {t.title}
                </span>
              </button>
              <span className={`chip ${statusCls[t.status]}`} data-testid={`thread-status-${t.id}`}>
                {t.status}
              </span>
              {(t.status === 'queued' || t.status === 'running') && (
                <button
                  className="btn !min-h-0 !min-w-0 !px-1 !py-0"
                  onClick={() => act(() => tasksApi.cancel(t.id))}
                  aria-label={`Cancel task ${t.id}`}
                  title="Cancel"
                >
                  <X size={11} />
                </button>
              )}
              {(t.status === 'failed' || t.status === 'cancelled') && (
                <button
                  className="btn !min-h-0 !min-w-0 !px-1 !py-0"
                  disabled={board.budget.exhausted}
                  onClick={() => act(() => tasksApi.retry(t.id))}
                  aria-label={`Retry task ${t.id}`}
                  title="Retry"
                >
                  <RotateCcw size={11} />
                </button>
              )}
            </div>
            {expanded && (
              <div className="space-y-1 border-t border-ink/10 px-1.5 py-1 text-[11px]">
                <div className="flex flex-wrap items-center gap-1 text-[10px] text-stone-500">
                  <SourceBadge source={t.mock ? 'simulated' : 'real'} />
                  {botById(t.agent)?.name ?? t.agent}
                  {t.requestedAgent === 'auto' && ' (auto)'} · {t.priority} ·{' '}
                  {fmtTime(t.startedAt ?? t.createdAt)}
                  {t.tokensIn + t.tokensOut > 0 &&
                    ` · ${t.tokensIn + t.tokensOut} tokens · ${usd(t.costUsd)}`}
                </div>
                {lines.map((l) => (
                  <p key={l.id} className="text-stone-700">
                    {l.text}
                  </p>
                ))}
                {t.status === 'running' && <p className="text-stone-500">…working</p>}
                {t.error && <p className="text-rose-700">{t.error}</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TaskForm() {
  useBoardSync();
  const { board, loadError, needsToken, refresh } = useBoard();
  const [form, setForm] = useState({ title: '', details: '', agent: 'auto', priority: 'normal' });
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [token, setToken] = useState('');
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  // Pinned to the bottom of the scrolling panel (which has 0.75rem padding).
  const shell =
    'sticky -bottom-3 -mx-3 -mb-3 mt-2 border-t-2 border-ink/15 bg-cream px-3 pb-3 pt-2';

  if (!api.backend)
    return (
      <p className={`${shell} text-[11px] text-stone-600`} data-testid="task-form-offline">
        Placing tasks needs the local server. Run <code className="font-pixel">npm start</code> on
        your computer; this online preview has no server.
      </p>
    );
  if (needsToken)
    return (
      <form
        className={`${shell} flex gap-1`}
        onSubmit={(e) => {
          e.preventDefault();
          tasksApi.setToken(token);
          void refresh();
        }}
      >
        <input
          id="task-token"
          className="field min-w-0 flex-1"
          type="password"
          placeholder="Access token for this server"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Access token"
        />
        <button className="btn">Unlock</button>
      </form>
    );

  const exhausted = !!board?.budget.exhausted;
  const submit = async () => {
    if (sending || exhausted) return;
    if (!form.title.trim()) return setError({ text: 'Give the task a title.', field: 'title' });
    setSending(true);
    setError(null);
    try {
      const t = await tasksApi.create({ ...form, details: form.details || undefined });
      useBoard.setState((s) => ({ open: { ...s.open, [t.id]: true } }));
      setForm((f) => ({ ...f, title: '', details: '' }));
      setShowDetails(false);
      await refresh();
    } catch (err) {
      setError(
        err instanceof TaskApiError
          ? { text: err.message, field: err.field }
          : { text: 'Could not reach the local server.' },
      );
    } finally {
      setSending(false);
    }
  };
  // Enter sends; Shift+Enter adds a line (in the title it opens the details box).
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.shiftKey) {
      if (e.currentTarget.tagName === 'INPUT') {
        e.preventDefault();
        setShowDetails(true);
        setTimeout(() => detailsRef.current?.focus(), 0);
      }
      return;
    }
    e.preventDefault();
    void submit();
  };
  const invalid = (f: string) => (error?.field === f ? '!border-rose-600' : '');

  return (
    <form
      className={`${shell} space-y-1`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
      data-testid="task-form"
    >
      <div className="flex gap-1">
        <button
          type="button"
          className="btn !min-w-0 !px-1"
          onClick={() => setShowDetails(!showDetails)}
          aria-label={showDetails ? 'Hide details' : 'Add details'}
          aria-expanded={showDetails}
        >
          {showDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <input
          id="task-title"
          className={`field min-w-0 flex-1 ${invalid('title')}`}
          placeholder="Place a task…"
          maxLength={120}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          onKeyDown={onKey}
          aria-label="Task title"
          aria-invalid={error?.field === 'title'}
        />
      </div>
      {showDetails && (
        <textarea
          id="task-details"
          ref={detailsRef}
          className={`field block w-full resize-y ${invalid('details')}`}
          rows={3}
          maxLength={4000}
          placeholder="Details (Shift+Enter for a new line)"
          value={form.details}
          onChange={(e) => setForm({ ...form, details: e.target.value })}
          onKeyDown={onKey}
          aria-label="Task details"
        />
      )}
      <div className="flex gap-1">
        <select
          id="task-agent"
          className={`field min-w-0 flex-1 ${invalid('agent')}`}
          value={form.agent}
          onChange={(e) => setForm({ ...form, agent: e.target.value })}
          aria-label="Agent"
        >
          <option value="auto">Auto</option>
          {roster.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name.split(' ')[0]}
            </option>
          ))}
        </select>
        <select
          id="task-priority"
          className="field"
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
          aria-label="Priority"
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
        <button
          className="btn btn-active"
          disabled={sending || exhausted || !board}
          data-testid="task-send"
        >
          <Send size={12} /> Send
        </button>
      </div>
      {error && (
        <p className="text-[11px] font-bold text-rose-700" role="alert" data-testid="task-error">
          {error.text}
        </p>
      )}
      {board && (
        <p className="text-[10px] text-stone-500" data-testid="task-cost">
          {exhausted ? (
            <b className="text-rose-700">
              Daily budget used up ({usd(board.budget.spentUsd)} of{' '}
              {usd(board.budget.dailyBudgetUsd)}). New tasks can run tomorrow.
            </b>
          ) : board.config.mock ? (
            <>MOCK_MODE: fake replies, no API call, no cost.</>
          ) : (
            <>
              Up to ~{usd(board.config.estimateMaxCostUsd)} per task (
              {board.config.maxTokensPerTask.toLocaleString()} tokens, {board.config.model}) ·{' '}
              {usd(board.budget.spentUsd)} of {usd(board.budget.dailyBudgetUsd)} used today
            </>
          )}
        </p>
      )}
      {loadError && <p className="text-[11px] text-rose-700">Task server: {loadError}</p>}
    </form>
  );
}
