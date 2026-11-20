import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { botById } from '../../shared/roster';
import type { Bot, BotEvent } from '../../shared/types';
import { costOf, redact, type GrokConfig } from './config';
import { estimateTokens, post, readStream, type Msg } from './grok';
import type { PlacedTask, Priority, TaskQueue } from './tasks';

// Direct chat with one Bot. Grok answers in the Bot's role and can place tasks into the queue.

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'note';
  text: string;
  ts: string;
  /** true when produced by MOCK_MODE (shown as SIMULATED). */
  mock: boolean;
  taskId?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
};
type Out = (event: 'delta' | 'thinking' | 'task' | 'done' | 'error', data: unknown) => void;

const tools = [
  {
    type: 'function',
    function: {
      name: 'place_task',
      description:
        'Add a piece of work to your own task queue when the user asks you to do something that takes more than a quick answer. It runs separately; afterwards reply briefly to confirm.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title (max 120 characters).' },
          details: { type: 'string', description: 'What exactly to produce.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
        required: ['title'],
      },
    },
  },
];

export const chatPrompt = (bot: Bot, tasks: PlacedTask[]) => {
  const mine = tasks.filter((t) => t.agent === bot.id).slice(0, 5);
  const list = mine.length
    ? mine.map((t) => `#${t.id} "${t.title}" (${t.status})`).join('; ')
    : 'none';
  return (
    `You are ${bot.name}, the ${bot.role} of a small office team in the Pixel Office app. ` +
    `You are chatting directly with the user, who manages the team. Stay in character, be friendly and concise (usually 1-4 sentences). ` +
    `If the user asks you to do a piece of work, call place_task so it goes into your queue, then confirm briefly; do not do long work inside the chat. ` +
    `Your recent placed tasks: ${list}.`
  );
};

const HISTORY_SENT = 20;
const HISTORY_KEPT = 200;

export class ChatService {
  private data: Record<string, ChatMessage[]>;
  private busy = new Set<string>();
  private seq = 0;

  constructor(
    private readonly cfg: GrokConfig,
    private readonly queue: TaskQueue,
    private readonly publish: (e: BotEvent) => void,
    private readonly file: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    try {
      this.data = file === ':memory:' ? {} : JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  private save() {
    if (this.file === ':memory:') return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }
  private add(botId: string, m: Omit<ChatMessage, 'id' | 'ts'>) {
    const msg: ChatMessage = {
      id: `c${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      ts: new Date().toISOString(),
      ...m,
    };
    this.data[botId] = [...(this.data[botId] ?? []), msg].slice(-HISTORY_KEPT);
    this.save();
    return msg;
  }

  /** Records a task the user placed from the chat box: their message plus a live task card. */
  noteTask(botId: string, text: string, t: PlacedTask) {
    const mock = this.cfg.mockMode;
    return [
      this.add(botId, { role: 'user', text, mock }),
      this.add(botId, { role: 'note', text: `📋 Task #${t.id}: ${t.title}`, mock, taskId: t.id }),
    ];
  }
  history(botId: string) {
    return this.data[botId] ?? [];
  }
  isBusy(botId: string) {
    return this.busy.has(botId);
  }
  clear(botId: string) {
    delete this.data[botId];
    this.save();
  }

  /** Streams one reply. Never throws: problems are sent as an 'error' event. */
  async send(botId: string, text: string, signal: AbortSignal, out: Out) {
    const bot = botById(botId)!;
    const { cfg } = this;
    const mock = cfg.mockMode;
    if (this.queue.budget().exhausted)
      return out('error', {
        error: 'The daily budget is used up, so chat replies are paused until tomorrow.',
      });
    this.busy.add(botId);
    this.add(botId, { role: 'user', text, mock });
    const messages: Msg[] = [
      { role: 'system', content: chatPrompt(bot, this.queue.list()) },
      ...this.history(botId)
        .filter((m) => m.role !== 'note')
        .slice(-HISTORY_SENT)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })),
    ];
    let reply = '';
    let tokensIn = 0;
    let tokensOut = 0;
    const ctx = { cfg, signal, fetchImpl: this.fetchImpl };
    // Usage of the turn being streamed; estimated and still charged if the stream breaks first.
    let inFlight: { in: number; outChars: number } | null = null;
    try {
      for (let turn = 0; turn < 3; turn++) {
        const res = await post(ctx, {
          model: cfg.model,
          messages,
          tools,
          stream: true,
          max_tokens: Math.min(1500, cfg.maxTokensPerTask),
        });
        const turn$ = { in: estimateTokens(JSON.stringify(messages).length), outChars: 0 };
        inFlight = turn$;
        let thinking = false;
        const r = await readStream(
          res,
          (t) => {
            turn$.outChars += t.length;
            reply += t;
            out('delta', { text: t });
          },
          (t) => {
            turn$.outChars += t.length;
            if (!thinking) out('thinking', {});
            thinking = true;
          },
        );
        inFlight = null;
        tokensIn += r.usage?.prompt_tokens ?? turn$.in;
        tokensOut += r.usage?.completion_tokens ?? estimateTokens(turn$.outChars);
        if (!r.calls.length) break;
        messages.push({
          role: 'assistant',
          content: r.content,
          tool_calls: r.calls.map((c, i) => ({
            id: c.id || `call_${turn}_${i}`,
            type: 'function',
            function: { name: c.name, arguments: c.args || '{}' },
          })),
        });
        for (const [i, c] of r.calls.entries()) {
          messages.push({
            role: 'tool',
            tool_call_id: c.id || `call_${turn}_${i}`,
            content: this.placeTask(botId, c.name, c.args, mock, out),
          });
        }
        if (reply && !/\s$/.test(reply)) {
          reply += ' ';
          out('delta', { text: ' ' });
        }
      }
      const costUsd = mock ? 0 : costOf(cfg.model, tokensIn, tokensOut);
      this.queue.charge(costUsd);
      const msg = this.add(botId, {
        role: 'assistant',
        text: reply.trim() || '…',
        mock,
        tokensIn,
        tokensOut,
        costUsd,
      });
      // The reply also appears in the office as a speech bubble and in the activity log.
      this.publish({
        id: `chat-${botId}-${msg.id}`,
        botId,
        timestamp: msg.ts,
        type: 'message',
        source: mock ? 'simulated' : 'real',
        payload: {
          text: msg.text,
          kind: 'chat',
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model: cfg.model,
        },
      });
      out('done', { message: msg });
    } catch (err) {
      if (inFlight) {
        tokensIn += inFlight.in;
        tokensOut += estimateTokens(inFlight.outChars);
      }
      const costUsd = mock ? 0 : costOf(cfg.model, tokensIn, tokensOut);
      this.queue.charge(costUsd);
      if (reply.trim())
        this.add(botId, {
          role: 'assistant',
          text: `${reply.trim()} (stopped)`,
          mock,
          tokensIn,
          tokensOut,
          costUsd,
        });
      const msg = signal.aborted
        ? 'Stopped.'
        : err instanceof Error
          ? err.name === 'TimeoutError'
            ? 'Grok took too long to answer.'
            : err.message
          : String(err);
      out('error', { error: redact(cfg, msg) });
    } finally {
      this.busy.delete(botId);
    }
  }

  private placeTask(botId: string, name: string, args: string, mock: boolean, out: Out) {
    if (name !== 'place_task') return `error: unknown tool ${name}`;
    let a: { title?: unknown; details?: unknown; priority?: unknown };
    try {
      a = JSON.parse(args || '{}');
    } catch {
      return 'error: arguments were not valid JSON';
    }
    const title = String(a.title ?? '')
      .trim()
      .slice(0, 120);
    if (!title) return 'error: a title is required';
    const priority: Priority =
      a.priority === 'high' || a.priority === 'low' ? a.priority : 'normal';
    const t = this.queue.create({
      title,
      details: typeof a.details === 'string' ? a.details.slice(0, 4000) : '',
      agent: botId,
      priority,
    });
    if ('error' in t) return `error: ${t.error}`;
    const note = this.add(botId, {
      role: 'note',
      text: `📋 Placed task #${t.id}: ${t.title}`,
      mock,
      taskId: t.id,
    });
    out('task', { task: t, message: note });
    return `Placed as task #${t.id} (${priority} priority) in your queue.`;
  }
}
