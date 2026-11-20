import { useMemo, useState } from 'react';
import { durationMs, filterTasks, taskStats, type TaskFilter } from '../../../shared/events';
import { botById, roster } from '../../../shared/roster';
import type { EventSource, TaskStatus } from '../../../shared/types';
import { displayState, useStore } from '../store';
import { fmtDateTime, fmtDuration, Modal, Progress, SourceBadge, StatusChip } from './common';

const periods: Record<string, number | undefined> = {
  'Last hour': 3600e3,
  'Last 24 h': 86400e3,
  'Last 7 days': 7 * 86400e3,
  'All time': undefined,
};

export function Dashboard() {
  const state = useStore(displayState);
  const mode = useStore((s) => s.mode);
  const [filter, setFilter] = useState<{
    botId: string;
    status: string;
    source: string;
    period: string;
  }>({ botId: '', status: '', source: '', period: 'All time' });
  const [hover, setHover] = useState<string | null>(null);
  const all = Object.values(state.tasks);
  const f: TaskFilter = {
    botId: filter.botId || undefined,
    status: (filter.status || undefined) as TaskStatus | undefined,
    source: (filter.source || undefined) as EventSource | undefined,
    periodMs: periods[filter.period],
    now: mode === 'replay' ? useStore.getState().replay?.time : Date.now(),
  };
  const tasks = filterTasks(all, f).sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  const stats = taskStats(tasks);
  const byBot = useMemo(
    () =>
      roster.map((b) => ({
        bot: b,
        n: tasks.filter((t) => t.botId === b.id).length,
        done: tasks.filter((t) => t.botId === b.id && t.status === 'completed').length,
      })),
    [tasks],
  );
  const max = Math.max(1, ...byBot.map((x) => x.n));
  const sources = new Set(all.map((t) => t.source));
  const focus = (botId: string) => {
    const s = useStore.getState();
    s.select({ kind: 'bot', id: botId });
    s.focus({ kind: 'bot', id: botId });
    s.openModal(null);
  };
  return (
    <Modal title={`Task dashboard${mode === 'replay' ? ' — replay' : ''}`} wide>
      <div
        className="mb-3 flex flex-wrap items-center gap-2 text-xs"
        role="group"
        aria-label="Filters"
      >
        <select
          className="field"
          value={filter.botId}
          onChange={(e) => setFilter({ ...filter, botId: e.target.value })}
          aria-label="Filter by Bot"
        >
          <option value="">All Bots</option>
          {roster.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          className="field"
          value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {['pending', 'active', 'completed', 'failed'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          className="field"
          value={filter.source}
          onChange={(e) => setFilter({ ...filter, source: e.target.value })}
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          {(['real', 'simulated', 'replayed', 'unknown'] as const).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="field"
          value={filter.period}
          onChange={(e) => setFilter({ ...filter, period: e.target.value })}
          aria-label="Time period"
        >
          {Object.keys(periods).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-stone-600">
          Sources in data:{' '}
          {[...sources].map((s) => (
            <SourceBadge key={s} source={s} />
          ))}
          {!sources.has('real') && <span>— no REAL tasks observed</span>}
        </span>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          ['Total', stats.total],
          ['Active', stats.active],
          ['Pending', stats.pending],
          ['Completed', stats.completed],
          ['Failed', stats.failed],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border-2 border-ink/20 bg-white p-2">
            <div className="text-[10px] font-bold uppercase text-stone-500">{k}</div>
            <div className="text-xl font-extrabold tabular-nums">{v}</div>
          </div>
        ))}
        <div
          className="rounded-md border-2 border-ink/20 bg-white p-2"
          title="Completed ÷ all observed tasks in this filter (pending + active + completed + failed) × 100. Not task progress."
        >
          <div className="text-[10px] font-bold uppercase text-stone-500">Completion rate</div>
          <div className="text-xl font-extrabold tabular-nums">
            {stats.completionRate == null ? '—' : `${stats.completionRate.toFixed(0)}%`}
          </div>
          <div className="text-[9px] text-stone-500">
            {stats.completed} / {stats.eligible} observed
          </div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
        <figure className="rounded-md border-2 border-ink/20 bg-white p-2">
          <figcaption className="mb-1 text-[11px] font-bold">Tasks by Bot (in filter)</figcaption>
          <ul className="space-y-1.5">
            {byBot.map(({ bot, n, done }) => (
              <li key={bot.id} className="relative">
                <button
                  className="grid w-full grid-cols-[5.5rem_1fr_2rem] items-center gap-2 text-left text-[11px]"
                  onMouseEnter={() => setHover(bot.id)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(bot.id)}
                  onBlur={() => setHover(null)}
                  onClick={() =>
                    setFilter({ ...filter, botId: filter.botId === bot.id ? '' : bot.id })
                  }
                >
                  <span className="flex items-center gap-1 truncate text-ink">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: bot.color }}
                    />
                    {bot.name.split(' ')[0]}
                  </span>
                  <span className="relative h-3">
                    <span
                      className="absolute inset-y-0 left-0 rounded-r bg-[#5B7FA6]"
                      style={{ width: `${(n / max) * 100}%`, minWidth: n ? 3 : 0 }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-stone-600">{n}</span>
                </button>
                {hover === bot.id && (
                  <div className="pointer-events-none absolute left-24 top-4 z-10 rounded border-2 border-ink bg-white px-2 py-1 text-[10px] shadow">
                    <b>{bot.name}</b>: {n} tasks · {done} completed
                  </div>
                )}
              </li>
            ))}
          </ul>
        </figure>
        <div className="max-h-[46vh] overflow-auto rounded-md border-2 border-ink/20 bg-white">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-paper">
              <tr>
                {[
                  'Task',
                  'Bot',
                  'Status',
                  'Progress',
                  'Start',
                  'Finish',
                  'Duration',
                  'Source',
                  'Updated',
                ].map((h) => (
                  <th key={h} className="px-2 py-1 font-bold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-2 py-4 text-center text-stone-500">
                    No tasks match.
                  </td>
                </tr>
              )}
              {tasks.slice(0, 300).map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-t border-ink/10 hover:bg-amber-50"
                  onClick={() => focus(t.botId)}
                  title="Focus this Bot in the office"
                >
                  <td className="px-2 py-1">
                    <div className="font-bold">{t.title}</div>
                    <div className="font-pixel text-[9px] text-stone-400">{t.id}</div>
                  </td>
                  <td className="px-2 py-1">{botById(t.botId)?.name ?? t.botId}</td>
                  <td className="px-2 py-1">
                    <StatusChip status={t.status} />
                  </td>
                  <td className="w-20 px-2 py-1">
                    {t.status === 'active' ? (
                      <Progress value={t.progress} />
                    ) : t.progress != null ? (
                      `${Math.round(t.progress * 100)}%`
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-1">{fmtDateTime(t.startedAt)}</td>
                  <td className="px-2 py-1">{fmtDateTime(t.completedAt)}</td>
                  <td className="px-2 py-1 tabular-nums">{fmtDuration(durationMs(t))}</td>
                  <td className="px-2 py-1">
                    <SourceBadge source={t.source} />
                  </td>
                  <td className="px-2 py-1">{fmtDateTime(t.lastUpdated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[10px] text-stone-500">
        Progress bars show only values reported by the source; striped bars mean progress is
        unknown. Completion rate counts tasks, not progress.
      </p>
    </Modal>
  );
}
