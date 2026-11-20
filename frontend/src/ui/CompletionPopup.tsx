import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { botById } from '../../../shared/roster';
import { resultsApi } from '../api';
import { fmtTime, SourceBadge } from './common';
import { CopyButton, ResultOutput } from './Markdown';
import { useResults } from './results';

export const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** One window over the office for finished tasks; several finishing together are paged ("1 of 3"). */
export function CompletionPopup() {
  const queue = useResults((s) => s.popup);
  const index = useResults((s) => Math.min(s.popupIndex, Math.max(0, s.popup.length - 1)));
  const id = queue[index];
  const rec = useResults((s) => (id === undefined ? undefined : s.records[id]));
  const close = () => useResults.setState({ popup: [], popupIndex: 0 });
  const go = (d: number) =>
    useResults.setState({ popupIndex: (index + d + queue.length) % queue.length });

  useEffect(() => {
    if (id === undefined) return;
    if (!useResults.getState().records[id]) void useResults.getState().load(id);
    useResults.getState().markRead(id);
  }, [id]);
  useEffect(() => {
    if (!queue.length) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowRight' && queue.length > 1) go(1);
      else if (e.key === 'ArrowLeft' && queue.length > 1) go(-1);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  if (id === undefined) return null;
  const bot = rec ? botById(rec.agent) : undefined;

  return (
    <div
      className="absolute inset-0 z-[45] flex items-center justify-center bg-ink/40 p-2 sm:p-4"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      role="dialog"
      aria-modal="true"
      aria-label="Task finished"
      data-testid="completion-popup"
    >
      <div className="panel flex max-h-[90%] w-full max-w-lg flex-col">
        <div className="flex items-center gap-2 border-b-2 border-ink/80 bg-paper px-3 py-2">
          <span
            className="h-7 w-7 shrink-0 rounded border-2 border-ink"
            style={{ background: bot?.color ?? '#ccc' }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-extrabold" data-testid="popup-title">
              {rec ? `#${rec.task_id} ${rec.title}` : `Task #${id}`}
            </h2>
            <div className="flex items-center gap-1 text-[10px] text-stone-600">
              {rec && <SourceBadge source={rec.mock ? 'simulated' : 'real'} />}
              <span className="truncate">
                {bot?.name ?? rec?.agent} · {rec ? fmtTime(rec.finished_at) : '…'} ·{' '}
                {rec ? usd(rec.cost_usd) : ''}
              </span>
            </div>
          </div>
          {queue.length > 1 && (
            <div
              className="flex items-center gap-0.5 text-[11px] font-bold"
              data-testid="popup-pager"
            >
              <button className="btn !px-1" onClick={() => go(-1)} aria-label="Previous result">
                <ChevronLeft size={12} />
              </button>
              <span>
                {index + 1} of {queue.length}
              </span>
              <button className="btn !px-1" onClick={() => go(1)} aria-label="Next result">
                <ChevronRight size={12} />
              </button>
            </div>
          )}
          <button
            className="btn !px-1.5"
            onClick={close}
            aria-label="Close"
            data-testid="popup-close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="scroll-thin min-h-24 overflow-auto p-3">
          {rec ? <ResultOutput rec={rec} /> : <p className="text-xs text-stone-500">Loading…</p>}
        </div>
        {rec && (
          <div className="flex flex-wrap items-center gap-1 border-t-2 border-ink/15 px-3 py-2">
            <CopyButton text={rec.output} />
            <a
              className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
              href={resultsApi.downloadUrl(rec.task_id)}
            >
              <Download size={11} /> Download
            </a>
            <button
              className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
              onClick={() => useResults.getState().openBoard(rec.task_id)}
              data-testid="popup-open-board"
            >
              <ExternalLink size={11} /> Open in Results board
            </button>
            <button
              className="btn btn-active ml-auto !min-h-0 !px-2 !py-0.5 !text-[10px]"
              onClick={close}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
