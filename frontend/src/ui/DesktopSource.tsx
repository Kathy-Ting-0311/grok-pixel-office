import { ExternalLink, Paperclip } from 'lucide-react';
import type { ResultRecord } from '../api';

/** Grok Bot Desktop's own declared link route (`/v1/agent`, id `[A-Za-z0-9_-]{1,128}`), verified in 1.3.0. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const openInGrokBot = (agentId: string) => {
  const a = document.createElement('a');
  a.href = AGENT_ID.test(agentId)
    ? `grokbot://app/v1/agent?id=${encodeURIComponent(agentId)}`
    : 'grokbot://app/v1/open';
  a.click();
};

export function DesktopBadge() {
  return (
    <span
      className="chip bg-violet-200 text-violet-900"
      title="Saved from a real Grok Bot Desktop reply"
      data-testid="desktop-badge"
    >
      Grok Desktop
    </span>
  );
}

/**
 * Where a saved Grok Desktop result came from, and its attachments as reference cards. Attachments live on the
 * bot's server and are not reachable from here, so there is no preview or download, only "View Original".
 */
export function DesktopSource({ source }: { source: NonNullable<ResultRecord['source']> }) {
  return (
    <div
      className="mb-2 space-y-1.5 rounded bg-violet-50 px-2 py-1.5 text-[11px] text-stone-700"
      data-testid="desktop-source"
    >
      <p>
        <b>Source:</b> {source.agentName} in Grok Bot Desktop ·{' '}
        {new Date(source.timestamp).toLocaleString()} · attribution{' '}
        {source.attribution === 'thread-target'
          ? 'thread target (inferred from the 1:1 thread)'
          : source.attribution}
      </p>
      {source.attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Attachments">
          {source.attachments.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-1 rounded border border-ink/20 bg-white px-1.5 py-0.5"
              data-testid="desktop-attachment"
            >
              <Paperclip size={10} /> <span className="font-bold">{f.name}</span>
              <span className="text-stone-500">{f.type}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn !min-h-0 !px-1.5 !py-0.5 !text-[10px]"
        onClick={() => openInGrokBot(source.agentId)}
        data-testid="desktop-view-original"
      >
        <ExternalLink size={11} /> View Original in Grok Bot
      </button>
      {source.attachments.length > 0 && (
        <p className="text-[10px] text-stone-500">
          Attachments stay in Grok Bot; open the original to view or download them.
        </p>
      )}
    </div>
  );
}
