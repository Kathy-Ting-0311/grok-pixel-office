import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ListPlus, RotateCcw, Send, Square, X } from 'lucide-react';
import type { Bot } from '../../../shared/types';
import {
  api,
  chatApi,
  resultsApi,
  TaskApiError,
  tasksApi,
  type ChatInfo,
  type ChatMessage,
} from '../api';
import { fmtTime } from './common';
import { usd } from './CompletionPopup';
import { useResults } from './results';
import { statusCls, useBoard } from './TaskComposer';

/** Live card for a task placed from the chat: "#14 Make a picture · running", with Cancel / Retry. */
function TaskCard({ id }: { id: number }) {
  const t = useBoard((s) => s.board?.tasks.find((x) => x.id === id));
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await useBoard.getState().refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  if (!t)
    return (
      <div className="mx-auto w-fit rounded-full bg-paper px-2 py-0.5 text-[10px] text-stone-500">
        Task #{id}
      </div>
    );
  return (
    <div
      className="mx-auto flex w-full max-w-[92%] items-center gap-1 rounded-md bg-paper px-2 py-1 text-[11px]"
      data-testid={`task-card-${id}`}
    >
      <span className="min-w-0 flex-1 truncate font-bold">
        #{t.id} {t.title}
      </span>
      <span
        className={`chip !px-1 !py-0 !text-[9px] ${statusCls[t.status]}`}
        data-testid="chat-task-status"
      >
        {t.status}
      </span>
      {(t.status === 'queued' || t.status === 'running') && (
        <button
          className="btn !min-h-0 !min-w-0 !px-1 !py-0"
          onClick={() => act(() => tasksApi.cancel(t.id))}
          aria-label={`Cancel task ${t.id}`}
          title="Cancel"
        >
          <X size={10} />
        </button>
      )}
      {(t.status === 'failed' || t.status === 'cancelled') && (
        <button
          className="btn !min-h-0 !min-w-0 !px-1 !py-0"
          onClick={() => act(() => tasksApi.retry(t.id))}
          aria-label={`Retry task ${t.id}`}
          title="Retry"
        >
          <RotateCcw size={10} />
        </button>
      )}
      {(t.status === 'done' || t.status === 'failed') && (
        <button
          className="btn !min-h-0 !px-1 !py-0 !text-[9px]"
          onClick={() => useResults.getState().openBoard(t.id)}
          data-testid="chat-task-open"
        >
          Result
        </button>
      )}
      {error && <span className="w-full text-[10px] text-rose-700">{error}</span>}
    </div>
  );
}

const LINE = 18;

/** Direct chat with one Bot: one scroll area, input pinned at the bottom of the same surface. */
export function BotChat({
  bot,
  clearAsk,
  setClearAsk,
  onCount,
}: {
  bot: Bot;
  clearAsk: boolean;
  setClearAsk: (v: boolean) => void;
  onCount?: (n: number) => void;
}) {
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [asTask, setAsTask] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pill, setPill] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const first = bot.name.split(' ')[0];

  const reload = () =>
    chatApi
      .history(bot.id)
      .then((h) => {
        setInfo(h);
        setMessages(h.messages);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    if (!api.backend) return;
    setMessages([]);
    setError(null);
    stick.current = true;
    void reload();
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  useEffect(() => onCount?.(messages.length), [messages.length, onCount]);

  // Auto-scroll unless the reader scrolled up; then offer a "New messages" pill.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setPill(true);
  }, [messages.length, streaming]);
  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (stick.current) setPill(false);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stick.current = true;
    setPill(false);
  };
  // Auto-grow the input up to 4 lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, LINE * 4 + 12)}px`;
  }, [draft]);

  if (!api.backend)
    return (
      <p
        className="m-3 rounded bg-paper px-2 py-1.5 text-[11px] text-stone-600"
        data-testid="chat-offline"
      >
        Chatting with {first} needs the local server. Run{' '}
        <code className="font-pixel">npm start</code> on your computer; this online preview has no
        server.
      </p>
    );

  const exhausted = !!info?.budget.exhausted;
  const busy = streaming !== null;
  const isTask = asTask || /^\/task\b/i.test(draft.trim());

  const sendTask = async (text: string) => {
    const r = await resultsApi.chatTask(bot.id, text);
    setMessages((m) => [...m, ...r.messages]);
    void useBoard.getState().refresh();
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (exhausted)
      return setError(
        'The daily budget is used up, so replies and tasks are paused until tomorrow.',
      );
    setError(null);
    stick.current = true;
    if (isTask) {
      try {
        await sendTask(text);
        setDraft('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    setDraft('');
    setMessages((m) => [
      ...m,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        text,
        ts: new Date().toISOString(),
        mock: !!info?.mock,
      },
    ]);
    setStreaming('');
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await chatApi.send(
        bot.id,
        text,
        (e) => {
          if (e.event === 'delta') setStreaming((s) => (s ?? '') + e.data.text);
          else if (e.event === 'task') {
            setMessages((m) => [...m, e.data.message]);
            void useBoard.getState().refresh();
          } else if (e.event === 'done') {
            setMessages((m) => [...m, e.data.message]);
            setStreaming(null);
          } else if (e.event === 'error') setError(e.data.error);
        },
        ctl.signal,
      );
    } catch (err) {
      if (!ctl.signal.aborted)
        setError(err instanceof TaskApiError ? err.message : 'Could not reach the local server.');
    } finally {
      setStreaming(null);
      abort.current = null;
      // The saved version (including a partial reply after Stop) and the new budget.
      setTimeout(() => void reload(), 300);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const clear = async () => {
    try {
      await chatApi.clear(bot.id);
      setMessages([]);
      setClearAsk(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="bot-chat">
      {clearAsk && (
        <div
          className="flex items-center gap-1 bg-rose-50 px-3 py-1 text-[11px] font-bold text-rose-900"
          role="alert"
        >
          Clear the chat with {first}?
          <button
            className="btn ml-auto !min-h-0 !px-1.5 !py-0 !text-[10px]"
            onClick={clear}
            data-testid="chat-clear-yes"
          >
            Clear
          </button>
          <button
            className="btn !min-h-0 !px-1.5 !py-0 !text-[10px]"
            onClick={() => setClearAsk(false)}
          >
            Keep
          </button>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-2"
        data-testid="chat-scroll"
      >
        <ol
          className="flex flex-col"
          aria-label={`Chat with ${bot.name}`}
          aria-live="polite"
          data-testid="chat-messages"
        >
          {messages.length === 0 && !busy && (
            <li className="my-6 text-center text-[11px] text-stone-500">
              Say hello to {first}, or start with <code className="font-pixel">/task</code> to give
              them work. Results open in a pop-up when they finish.
            </li>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.role === m.role && m.role !== 'note';
            if (m.role === 'note')
              return (
                <li key={m.id} className="my-1" data-testid="chat-note">
                  {m.taskId !== undefined ? (
                    <TaskCard id={m.taskId} />
                  ) : (
                    <div className="mx-auto w-fit rounded-full bg-paper px-2 py-0.5 text-[10px] font-bold">
                      {m.text}
                    </div>
                  )}
                </li>
              );
            const mine = m.role === 'user';
            return (
              <li
                key={m.id}
                className={`flex ${mine ? 'justify-end' : 'justify-start'} ${grouped ? 'mt-0.5' : 'mt-2'}`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-2 py-1 text-xs ${mine ? 'rounded-br-sm bg-amber-100' : 'rounded-bl-sm bg-white'}`}
                  data-testid={mine ? 'chat-user' : 'chat-bot'}
                >
                  {!mine && !grouped && (
                    <div className="flex items-center gap-1 text-[10px] font-bold">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: bot.color }}
                      />
                      {first}
                    </div>
                  )}
                  {m.text}
                  <div className="text-right text-[9px] leading-3 text-stone-400">
                    {fmtTime(m.ts)}
                    {!mine && !!m.tokensIn && ` · ${m.tokensIn + (m.tokensOut ?? 0)} tok`}
                    {!mine && !!m.costUsd && ` · ${usd(m.costUsd)}`}
                  </div>
                </div>
              </li>
            );
          })}
          {busy && (
            <li
              className={`flex justify-start ${messages.at(-1)?.role === 'assistant' ? 'mt-0.5' : 'mt-2'}`}
            >
              <div
                className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-bl-sm bg-white px-2 py-1 text-xs"
                data-testid="chat-streaming"
              >
                {streaming ? (
                  <>
                    {streaming}
                    <span className="ml-0.5 inline-block animate-pulse">▍</span>
                  </>
                ) : (
                  <span
                    className="flex items-center gap-0.5 py-1"
                    aria-label={`${first} is typing`}
                    data-testid="typing"
                  >
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400"
                        style={{ animationDelay: `${d * 120}ms` }}
                      />
                    ))}
                  </span>
                )}
              </div>
            </li>
          )}
        </ol>
      </div>
      {pill && (
        <button
          className="btn absolute bottom-24 left-1/2 z-10 -translate-x-1/2 !min-h-0 !rounded-full !px-2 !py-0.5 !text-[10px] shadow"
          onClick={toBottom}
          data-testid="new-messages"
        >
          <ArrowDown size={10} /> New messages
        </button>
      )}
      <form
        className="px-3 pb-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        noValidate
      >
        <div className="flex items-end gap-1">
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={input}
              className="block w-full resize-none rounded-2xl bg-white py-1.5 pl-3 pr-8 text-xs leading-[18px] outline-none focus:ring-2 focus:ring-amber-400"
              rows={1}
              maxLength={4120}
              placeholder={
                isTask
                  ? `Task for ${first}: title, details on new lines`
                  : `Message ${first}…  (/task for work)`
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              aria-label={`Message ${bot.name}`}
              data-testid="chat-input"
            />
            {busy ? (
              <button
                type="button"
                className="absolute bottom-1 right-1 rounded-full p-1 text-ink hover:bg-paper"
                onClick={() => abort.current?.abort()}
                aria-label="Stop the reply"
                data-testid="chat-stop"
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                className="absolute bottom-1 right-1 rounded-full p-1 text-amber-700 hover:bg-paper disabled:text-stone-300"
                disabled={!draft.trim() || exhausted}
                aria-label={isTask ? 'Create task' : 'Send'}
                data-testid="chat-send"
              >
                <Send size={13} />
              </button>
            )}
          </div>
          <button
            type="button"
            className={`btn !min-h-0 shrink-0 !px-1.5 !py-1 !text-[10px] ${asTask ? 'btn-active' : ''}`}
            onClick={() => setAsTask((v) => !v)}
            aria-pressed={asTask}
            title="Make it a task: first line is the title, the rest the details"
            data-testid="make-task"
          >
            <ListPlus size={11} /> Task
          </button>
        </div>
        {error && (
          <p
            className="mt-0.5 text-[11px] font-bold text-rose-700"
            role="alert"
            data-testid="chat-error"
          >
            {error}
          </p>
        )}
        <p className="mt-0.5 text-[10px] text-stone-500" data-testid="chat-status">
          {info ? (
            <>
              <b className={info.mock ? 'text-violet-700' : 'text-emerald-700'}>
                {info.mock ? 'SIMULATED' : 'REAL'}
              </b>
              {' | '}
              {info.mock
                ? 'MOCK_MODE, no cost'
                : `${usd(info.budget.spentUsd)} / ${usd(info.budget.dailyBudgetUsd)} today`}
              {exhausted && <b className="text-rose-700"> | budget used up</b>}
            </>
          ) : (
            '…'
          )}
        </p>
      </form>
    </div>
  );
}
