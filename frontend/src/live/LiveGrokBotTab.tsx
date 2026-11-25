import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw, Send } from 'lucide-react';
import {
  SEND_BLOCKED_REASON,
  type LiveAttribution,
  type LiveMessage,
  type LiveState,
  type LiveStatus,
} from '../../../shared/liveControl';
import type { Bot } from '../../../shared/types';
import { loadLocal } from '../store';
import { fmtTime } from '../ui/common';

/**
 * "Live Grok Bot" tab: the real 1:1 transcript of the Grok Bot mapped to this character, read through
 * the local server. Read-only: the send box is shown but disabled. Nothing here is simulated; when live
 * data cannot be read the tab says so.
 */

const POLL_MS = 5000;

const req = async <T,>(url: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> => {
  const r = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-office-token': loadLocal<string>('office-token') ?? '',
    },
    // Fastify rejects an empty body sent as JSON, so POSTs always carry one.
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
};

const stateLook: Record<LiveState, [string, string]> = {
  starting: ['bg-amber-400', 'Connecting…'],
  ok: ['bg-emerald-500', 'Live'],
  degraded: ['bg-amber-500', 'Live (retrying)'],
  paused: ['bg-stone-400', 'Paused'],
  'off-error': ['bg-rose-500', 'Off (errors)'],
  unavailable: ['bg-rose-500', 'Unavailable'],
  stopped: ['bg-stone-400', 'Stopped'],
};

const attrLook: Record<LiveAttribution, [string, string]> = {
  verified: ['bg-emerald-200 text-emerald-900', 'verified'],
  'thread-target': ['bg-sky-200 text-sky-900', 'thread target'],
  owner: ['bg-amber-200 text-amber-900', 'you'],
  unknown: ['bg-stone-200 text-stone-700', 'unknown'],
};

export function LiveGrokBotTab({ bot }: { bot: Bot }) {
  const [status, setStatus] = useState<LiveStatus>();
  const [messages, setMessages] = useState<LiveMessage[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const agentId = status?.mapping?.find((m) => m.rosterId === bot.id)?.agentId;
  const thread = agentId ? status?.threads.find((t) => t.id === agentId) : undefined;
  const known = !!thread;

  // Status, polled while the tab is open (local server only; it never calls the CLI for this).
  useEffect(() => {
    let alive = true;
    const load = () =>
      req<LiveStatus>('/api/live-control/status').then(
        (s) => alive && (setStatus(s), setError(undefined)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The open thread is polled faster by the adapter; cleared when the tab closes.
  useEffect(() => {
    if (!agentId || !known) return;
    void req('/api/live-control/active', 'POST', { id: agentId }).catch(() => {});
    return () => void req('/api/live-control/active', 'POST', {}).catch(() => {});
  }, [agentId, known]);

  useEffect(() => {
    if (!agentId || !known) return;
    let alive = true;
    const load = () =>
      req<{ messages: LiveMessage[] }>(`/api/live-control/thread/${agentId}`).then(
        (r) => alive && setMessages(r.messages),
        () => alive && setMessages(undefined),
      );
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agentId, known]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  const act = async (path: 'pause' | 'resume' | 'reconnect') => {
    setBusy(true);
    try {
      setStatus(await req<LiveStatus>(`/api/live-control/${path}`, 'POST'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const look = status ? stateLook[status.state] : (['bg-stone-300', 'Checking…'] as const);
  const off = status?.state === 'off-error' || status?.state === 'unavailable';
  const nameOf = (id?: string) => status?.agents.find((a) => a.id === id)?.name;
  const sendReason = status?.send.reason ?? SEND_BLOCKED_REASON;
  const btn = 'btn !min-h-0 !px-1.5 !py-0 !text-[10px]';

  let body: React.ReactNode;
  if (error && !status)
    body = <Note testId="live-unavailable">Live data unavailable: {error}</Note>;
  else if (!status) body = <Note>Checking Live Control…</Note>;
  else if (!agentId)
    body = (
      <Note testId="live-unmapped">
        {status.agents.length
          ? `No real Grok Bot is mapped to ${bot.name}.`
          : 'Live data unavailable: no Grok Bots have been read yet.'}
      </Note>
    );
  else if (!messages)
    body = (
      <Note testId="live-unavailable">
        Live data unavailable{status.paused ? ' while paused' : ''}: this thread has not been read
        yet.
      </Note>
    );
  else if (messages.length === 0) body = <Note>No messages read in this thread yet.</Note>;
  else
    body = (
      <ol className="flex flex-col" aria-label={`Live transcript with ${bot.name}`} data-testid="live-messages">
        {messages.map((m) => {
          const mine = m.attribution === 'owner';
          const [chip, label] = attrLook[m.attribution];
          const who = mine
            ? 'You'
            : m.attribution === 'unknown'
              ? 'Unknown sender'
              : (nameOf(m.senderId) ?? thread?.name ?? bot.name);
          return (
            <li key={m.key} className={`mt-2 flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid="live-msg">
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-2 py-1 text-xs ${mine ? 'rounded-br-sm bg-amber-100' : 'rounded-bl-sm bg-white'}`}
              >
                <div className="flex items-center gap-1 text-[10px] font-bold">
                  {!mine && m.attribution !== 'unknown' && (
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: bot.color }} />
                  )}
                  {who}
                  <span className={`chip ${chip}`} title={`Attribution: ${m.basis}`} data-testid="live-attr">
                    {label}
                  </span>
                </div>
                {m.placeholder ? (
                  <span className="italic text-stone-500" data-testid="live-placeholder">
                    {m.text}
                  </span>
                ) : (
                  m.text
                )}
                <div className="text-right text-[9px] leading-3 text-stone-400">{fmtTime(m.timestamp)}</div>
              </div>
            </li>
          );
        })}
      </ol>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="live-tab">
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1 text-[10px]" data-testid="live-indicator">
        <span className={`h-2 w-2 rounded-full ${look[0]}`} aria-hidden />
        <span className="font-bold" data-testid="live-state">
          {look[1]}
        </span>
        <span className="text-stone-500">· Reads from real Grok Bot Desktop</span>
        <span className="ml-auto flex gap-1">
          {status && !off && (
            <button
              className={btn}
              disabled={busy}
              onClick={() => void act(status.paused ? 'resume' : 'pause')}
              aria-label={status.paused ? 'Resume live reading' : 'Pause live reading'}
              data-testid="live-toggle"
            >
              {status.paused ? <Play size={10} /> : <Pause size={10} />}
              {status.paused ? ' Resume' : ' Pause'}
            </button>
          )}
          {off && (
            <button className={btn} disabled={busy} onClick={() => void act('reconnect')} data-testid="live-reconnect">
              <RefreshCw size={10} /> Reconnect
            </button>
          )}
        </span>
        {status?.reason && (
          <p className="w-full text-stone-600" data-testid="live-reason">
            {status.reason}
          </p>
        )}
        {error && status && (
          <p className="w-full text-rose-700" role="alert" data-testid="live-error">
            {error}
          </p>
        )}
      </div>
      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {body}
      </div>
      <form className="px-3 pb-2 pt-1" onSubmit={(e) => e.preventDefault()} noValidate>
        <div className="relative">
          <textarea
            className="block w-full resize-none rounded-2xl bg-white py-1.5 pl-3 pr-8 text-xs leading-[18px] outline-none disabled:bg-stone-100 disabled:text-stone-400"
            rows={1}
            disabled
            placeholder={`Message ${bot.name} in Grok Bot Desktop`}
            aria-label={`Message ${bot.name} in Grok Bot Desktop (unavailable)`}
            aria-describedby="live-send-reason"
            data-testid="live-send-input"
          />
          <button
            type="button"
            className="absolute bottom-1 right-1 rounded-full p-1 disabled:text-stone-300"
            disabled
            aria-label="Send to Grok Bot Desktop (unavailable)"
            data-testid="live-send-button"
          >
            <Send size={13} />
          </button>
        </div>
        <p id="live-send-reason" className="mt-1 text-[10px] text-stone-600" data-testid="live-send-reason">
          {sendReason}
        </p>
      </form>
    </div>
  );
}

function Note({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="my-6 text-center text-[11px] text-stone-500" data-testid={testId}>
      {children}
    </p>
  );
}
