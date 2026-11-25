import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FileArchive,
  FileDown,
  RotateCcw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { botById, roster } from '../../../shared/roster';
import { resultsApi, type OutputType, type ResultEntry, type ResultStatus } from '../api';
import { useStore } from '../store';
import { fmtTime, SourceBadge } from './common';
import { usd } from './CompletionPopup';
import { CopyButton, ResultOutput } from './Markdown';
import { DesktopBadge, DesktopSource } from './DesktopSource';
import { useResults } from './results';

const statusCls: Record<ResultStatus, string> = {
  done: 'bg-emerald-200 text-emerald-900',
  failed: 'bg-rose-200 text-rose-900',
  cancelled: 'bg-stone-200 text-stone-700',
};
const ROW = 52;
const dateOf = (iso: string) => iso.slice(0, 10);
const fmtWhen = (iso: string) =>
  dateOf(iso) === dateOf(new Date().toISOString())
    ? fmtTime(iso)
    : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** A virtualized list: only the rows in view (plus a few) are rendered. */
function ResultList({
  items,
  selected,
  onPick,
}: {
  items: ResultEntry[];
  selected?: number;
  onPick: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(top / ROW) - 4);
  const last = Math.min(items.length, Math.ceil((top + height) / ROW) + 4);
  return (
    <div
      ref={ref}
      className="scroll-thin h-full overflow-y-auto"
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      role="listbox"
      aria-label="Results"
      data-testid="results-list"
    >
      {items.length === 0 && <p className="p-3 text-xs text-stone-500">No results match.</p>}
      <div style={{ height: items.length * ROW, position: 'relative' }}>
        {items.slice(first, last).map((r, i) => {
          const bot = botById(r.agent);
          return (
            <button
              key={r.id}
              role="option"
              aria-selected={selected === r.id}
              onClick={() => onPick(r.id)}
              className={`absolute left-0 right-0 flex flex-col justify-center gap-0.5 border-b border-ink/10 px-2 text-left text-xs ${selected === r.id ? 'bg-amber-100' : 'hover:bg-paper'}`}
              style={{ top: (first + i) * ROW, height: ROW }}
              data-testid={`result-row-${r.id}`}
            >
              <span className="flex min-w-0 items-center gap-1">
                {!r.read && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-sky-500"
                    aria-label="Unread"
                    data-testid="unread-dot"
                  />
                )}
                {r.pinned && (
                  <Star
                    size={10}
                    className="shrink-0 fill-amber-400 text-amber-500"
                    aria-label="Pinned"
                  />
                )}
                <span className="truncate font-bold">
                  #{r.id} {r.title}
                </span>
                {r.src === 'grok-desktop' && <DesktopBadge />}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-stone-500">
                <span className="flex items-center gap-0.5 rounded-full bg-paper px-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: bot?.color }} />
                  {bot?.name.split(' ')[0] ?? r.agent}
                </span>
                <span className={`chip !px-1 !py-0 !text-[9px] ${statusCls[r.status]}`}>
                  {r.status}
                </span>
                <span>{r.type}</span>
                <span className="ml-auto">{fmtWhen(r.time)}</span>
                <span>{usd(r.cost)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ResultDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const rec = useResults((s) => s.records[id]);
  const entry = useResults((s) => s.entries.find((e) => e.id === id));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setConfirm(false);
    setError(null);
    void useResults.getState().load(id);
    useResults.getState().markRead(id);
  }, [id]);
  if (!entry) return <p className="p-3 text-xs text-stone-500">This result was deleted.</p>;
  const bot = botById(entry.agent);
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try {
      await fn();
      after?.();
      await useResults.getState().refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="result-detail">
      <div className="flex flex-wrap items-center gap-1 border-b-2 border-ink/15 px-3 py-2">
        <button className="btn !px-1 sm:!hidden" onClick={onBack} aria-label="Back to list">
          <ArrowLeft size={12} />
        </button>
        <span
          className="h-5 w-5 shrink-0 rounded border-2 border-ink"
          style={{ background: bot?.color }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-extrabold">
            #{entry.id} {entry.title}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-stone-600">
            {rec && <SourceBadge source={rec.mock ? 'simulated' : 'real'} />}
            {entry.src === 'grok-desktop' && <DesktopBadge />}
            <span className="truncate">
              {bot?.name} · {new Date(entry.time).toLocaleString()} · {usd(entry.cost)}
              {rec && ` · ${rec.tokens_in + rec.tokens_out} tokens · ${rec.model}`}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-ink/10 px-3 py-1.5">
        {rec && <CopyButton text={rec.output} />}
        <a className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]" href={resultsApi.downloadUrl(id)}>
          <Download size={11} /> Download
        </a>
        {entry.src !== 'grok-desktop' && (
          <button
            className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
            onClick={() =>
              act(
                () => resultsApi.rerun(id),
                () => useStore.getState().toast('Re-run placed as a new task.', 'good'),
              )
            }
            data-testid="result-rerun"
          >
            <RotateCcw size={11} /> {entry.status === 'done' ? 'Re-run' : 'Retry'}
          </button>
        )}
        <button
          className={`btn !min-h-0 !px-1.5 !py-0.5 !text-[10px] ${entry.pinned ? 'btn-active' : ''}`}
          onClick={() => act(() => resultsApi.patch(id, { pinned: !entry.pinned }))}
          aria-pressed={entry.pinned}
          data-testid="result-pin"
        >
          <Star size={11} /> {entry.pinned ? 'Pinned' : 'Pin'}
        </button>
        {confirm ? (
          <span className="flex items-center gap-1 text-[10px] font-bold text-rose-800">
            Delete this result?
            <button
              className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
              onClick={() => act(() => resultsApi.remove(id), onBack)}
              data-testid="result-delete-yes"
            >
              Delete
            </button>
            <button
              className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
              onClick={() => setConfirm(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
            onClick={() => setConfirm(true)}
            data-testid="result-delete"
          >
            <Trash2 size={11} /> Delete
          </button>
        )}
      </div>
      {error && (
        <p className="px-3 pt-1 text-[11px] font-bold text-rose-700" role="alert">
          {error}
        </p>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-3 py-2">
        {rec ? (
          <>
            {rec.source && <DesktopSource source={rec.source} />}
            {rec.details && !rec.source && (
              <p className="mb-2 whitespace-pre-wrap rounded bg-paper px-2 py-1 text-[11px] text-stone-600">
                <b>Prompt:</b> {rec.details}
              </p>
            )}
            <ResultOutput rec={rec} />
          </>
        ) : (
          <p className="text-xs text-stone-500">Loading…</p>
        )}
      </div>
    </div>
  );
}

export function ResultsBoard() {
  const entries = useResults((s) => s.entries);
  const keep = useResults((s) => s.keep);
  const loadError = useResults((s) => s.error);
  const selected = useResults((s) => s.selected);
  const [q, setQ] = useState('');
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState<'' | ResultStatus>('');
  const [type, setType] = useState<'' | OutputType>('');
  const [src, setSrc] = useState<'' | 'grok-desktop' | 'xai'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [keepDraft, setKeepDraft] = useState(String(keep));
  const [keepMsg, setKeepMsg] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(selected !== undefined);
  const close = () => useStore.getState().openModal(null);
  useEffect(() => setKeepDraft(String(keep)), [keep]);
  useEffect(() => void useResults.getState().refresh(), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Esc closes only the top window: the completion pop-up first, if it is open.
      if (e.key === 'Escape' && !useResults.getState().popup.length) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...entries]
      .filter(
        (r) =>
          (!needle ||
            r.title.toLowerCase().includes(needle) ||
            (botById(r.agent)?.name.toLowerCase().includes(needle) ?? false) ||
            String(r.id) === needle.replace('#', '')) &&
          (!agent || r.agent === agent) &&
          (!status || r.status === status) &&
          (!type || r.type === type) &&
          (!src || (src === 'grok-desktop') === (r.src === 'grok-desktop')) &&
          (!from || dateOf(r.time) >= from) &&
          (!to || dateOf(r.time) <= to),
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id);
  }, [entries, q, agent, status, type, src, from, to]);
  // Open on the newest result (desktop) instead of an empty detail pane.
  useEffect(() => {
    if (selected === undefined && items.length && !window.matchMedia('(max-width: 639px)').matches)
      useResults.setState({ selected: items[0].id });
  }, [selected, items]);
  const pick = (id: number) => {
    useResults.setState({ selected: id });
    setMobileDetail(true);
  };
  const unread = entries.filter((e) => !e.read).length;
  const saveKeep = async () => {
    setKeepMsg(null);
    const n = Number(keepDraft);
    if (!Number.isInteger(n) || n < 10) return setKeepMsg('Enter a whole number of at least 10.');
    try {
      await resultsApi.setKeep(n);
      await useResults.getState().refresh();
      setKeepMsg('Saved.');
    } catch (err) {
      setKeepMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-ink/40 p-1 sm:p-3"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      role="dialog"
      aria-label="Results board"
      data-testid="results-board"
    >
      <div className="panel flex h-full max-h-[94%] w-full max-w-6xl flex-col overflow-hidden sm:max-h-[90vh]">
        <div className="flex flex-wrap items-center gap-1 border-b-2 border-ink/80 bg-paper px-3 py-1.5">
          <h2 className="mr-1 text-sm font-extrabold">Results</h2>
          <span className="text-[10px] text-stone-600">
            {entries.length} saved{unread ? ` · ${unread} unread` : ''}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <a
              className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
              href={resultsApi.exportUrl('md')}
            >
              <FileDown size={11} /> .md
            </a>
            <a
              className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
              href={resultsApi.exportUrl('zip')}
              data-testid="export-zip"
            >
              <FileArchive size={11} /> .zip
            </a>
            <label
              className="flex items-center gap-1 text-[10px] text-stone-600"
              title="Older unpinned results are deleted. Pinned results are always kept."
            >
              Keep last
              <input
                className="field !min-h-0 w-14 !py-0 text-[10px]"
                inputMode="numeric"
                value={keepDraft}
                onChange={(e) => setKeepDraft(e.target.value)}
                onBlur={saveKeep}
                onKeyDown={(e) => e.key === 'Enter' && saveKeep()}
                aria-label="Results to keep"
              />
            </label>
            <button
              className="btn !px-1.5"
              onClick={close}
              aria-label="Close"
              data-testid="results-close"
            >
              <X size={14} />
            </button>
          </span>
          {keepMsg && (
            <span className="w-full text-right text-[10px] text-stone-600">{keepMsg}</span>
          )}
        </div>
        <div
          className="flex flex-wrap items-center gap-1 border-b border-ink/15 px-2 py-1"
          data-testid="results-filters"
        >
          <input
            className="field !min-h-0 min-w-0 flex-1 basis-32 !py-0.5 text-xs"
            placeholder="Search title, agent or #id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search results"
            data-testid="results-search"
          />
          <select
            className="field !min-h-0 !py-0.5 text-xs"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            aria-label="Agent filter"
          >
            <option value="">All agents</option>
            {roster.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            className="field !min-h-0 !py-0.5 text-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value as ResultStatus | '')}
            aria-label="Status filter"
            data-testid="results-status"
          >
            <option value="">Any status</option>
            <option value="done">Done</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            className="field !min-h-0 !py-0.5 text-xs"
            value={src}
            onChange={(e) => setSrc(e.target.value as '' | 'grok-desktop' | 'xai')}
            aria-label="Source filter"
            data-testid="results-source"
          >
            <option value="">All sources</option>
            <option value="grok-desktop">Grok Desktop</option>
            <option value="xai">xAI API</option>
          </select>
          <select
            className="field !min-h-0 !py-0.5 text-xs"
            value={type}
            onChange={(e) => setType(e.target.value as OutputType | '')}
            aria-label="Type filter"
            data-testid="results-type"
          >
            <option value="">Any type</option>
            {(['markdown', 'text', 'code', 'image', 'file'] as const).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="field !min-h-0 !py-0.5 text-xs"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="From date"
          />
          <input
            type="date"
            className="field !min-h-0 !py-0.5 text-xs"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="To date"
          />
        </div>
        {loadError && (
          <p className="px-3 py-1 text-[11px] font-bold text-rose-700" role="alert">
            {loadError}
          </p>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(240px,320px)_1fr]">
          <div
            className={`min-h-0 border-ink/15 sm:border-r-2 ${mobileDetail ? 'max-sm:hidden' : ''}`}
          >
            <ResultList items={items} selected={selected} onPick={pick} />
          </div>
          <div className={`min-h-0 ${mobileDetail ? '' : 'max-sm:hidden'}`}>
            {selected !== undefined ? (
              <ResultDetail id={selected} onBack={() => setMobileDetail(false)} />
            ) : (
              <p className="p-3 text-xs text-stone-500">
                {entries.length
                  ? 'Pick a result on the left.'
                  : 'Finished tasks appear here. Send a /task from any Bot chat.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
