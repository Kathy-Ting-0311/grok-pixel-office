import type { Bot, BotEventType } from '../../shared/types';
import { costOf, redact, type GrokConfig } from './config';

// xAI chat completions, OpenAI-compatible (docs.x.ai/docs/guides/streaming-response,
// docs.x.ai/docs/guides/function-calling). Called with plain fetch: no SDK dependency.

export const outputTypes = ['text', 'markdown', 'code', 'image', 'file'] as const;
export type OutputType = (typeof outputTypes)[number];
/** What a finished task hands back; results.ts turns it into a saved record. */
export type AgentOutput = {
  type: OutputType;
  text: string;
  language?: string;
  svg?: string;
  files: { name: string; content: string }[];
};
export const locations = ['desk', 'meeting_room', 'coffee', 'chief_office', 'common_area'] as const;
const tools = [
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: 'Walk to a place in the office.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', enum: locations } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'say',
      description: 'Post one short progress update (one sentence) to the team chat.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_file',
      description:
        'Save one deliverable file (max 200 KB) next to the result, e.g. report.md, script.py, data.csv or drawing.svg.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'File name with extension, letters/digits/._- only.',
          },
          content: { type: 'string' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_task',
      description: 'Call exactly once when the task is complete, with the final result.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One sentence describing what you produced.' },
          output_type: { type: 'string', enum: outputTypes },
          output: {
            type: 'string',
            description:
              'The full deliverable. markdown/text: the content. code: only the code. image: a detailed image prompt. file: a short note about the saved files.',
          },
          language: { type: 'string', description: 'For code: the language, e.g. python.' },
          svg: {
            type: 'string',
            description:
              'For image: an optional self-contained SVG drawing (no scripts, max 60 KB).',
          },
        },
        required: ['summary', 'output_type', 'output'],
      },
    },
  },
];

export type AgentTask = { id: number; title: string; details: string };
export type Usage = { tokensIn: number; tokensOut: number; costUsd: number; model: string };
export type AgentResult = (
  | { ok: true; summary: string; output?: AgentOutput }
  | { ok: false; error: string; reason: 'cancelled' | 'max_cost' | 'max_turns' | 'api_error' }
) &
  Usage;
export type AgentContext = {
  cfg: GrokConfig;
  /** Publishes an office event for this agent; usage fields are added automatically. */
  emit: (type: BotEventType, payload: Record<string, unknown>) => void;
  signal: AbortSignal;
  /** Called after every model turn with running totals; return false to stop (cost limit). */
  onUsage?: (u: Usage) => boolean;
  fetchImpl?: typeof fetch;
};

export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export const systemPrompt = (agent: Bot) =>
  `You are ${agent.name}, the ${agent.role} of a small office team.${agent.isChief ? ' You lead the team.' : ''} ` +
  `Complete the task you are given. Keep replies short. Use say() for at most two one-sentence progress updates, ` +
  `move_to() only if the task needs you elsewhere, save_file() for any deliverable that is a separate file, ` +
  `and finish_task exactly once with summary, output_type and the full output (use markdown for documents, code for programs, ` +
  `image when asked for a picture: give a detailed image prompt and, if you can, a simple SVG drawing).`;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

/** POST with a timeout, retrying 429/5xx/network errors (3 tries in total, exponential backoff or Retry-After). */
/** Rough token count (≈4 characters per token) for turns whose usage never arrived. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export type CallContext = Pick<AgentContext, 'cfg' | 'signal' | 'fetchImpl'>;
export async function post(ctx: CallContext, body: unknown): Promise<Response> {
  const f = ctx.fetchImpl ?? (ctx.cfg.mockMode ? mockFetch : fetch);
  let lastErr = new Error('xAI API request failed');
  let wait = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt)
      await sleep(
        Math.min(wait || 1000 * 2 ** (attempt - 1) + Math.random() * 250, 20000),
        ctx.signal,
      );
    wait = 0;
    let res: Response;
    try {
      res = await f(`${ctx.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.cfg.apiKey ?? 'mock'}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.cfg.timeoutMs)]),
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (res.ok) return res;
    const text = redact(ctx.cfg, (await res.text().catch(() => '')).slice(0, 300));
    lastErr = new Error(`xAI API ${res.status}${text ? `: ${text}` : ''}`);
    if (res.status !== 429 && res.status < 500) throw lastErr;
    wait = Number(res.headers.get('retry-after')) * 1000 || 0;
  }
  throw lastErr;
}

/** Reads an OpenAI-style SSE stream; calls onText/onReasoning as deltas arrive. */
export async function readStream(
  res: Response,
  onText: (t: string) => void,
  onReasoning: (t: string) => void,
) {
  let content = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const calls: { id: string; name: string; args: string }[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) onReasoning(String(delta.reasoning_content));
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name = tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    }
  }
  return { content, usage, calls: calls.filter(Boolean) };
}

/** Runs one task for one agent: streams Grok's reply, executes tool calls, stops after cfg.maxTurns. */
export async function runAgent(
  task: AgentTask,
  agent: Bot,
  ctx: AgentContext,
): Promise<AgentResult> {
  const { cfg } = ctx;
  const model = cfg.model;
  const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0, model };
  const emit = (type: BotEventType, payload: Record<string, unknown>) =>
    ctx.emit(type, {
      ...payload,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      model,
      cost_usd: Number(totals.costUsd.toFixed(6)),
    });
  const fail = (
    reason: Extract<AgentResult, { ok: false }>['reason'],
    error: string,
  ): AgentResult => ({ ok: false, reason, error: redact(cfg, error), ...totals });

  const messages: Msg[] = [
    { role: 'system', content: systemPrompt(agent) },
    {
      role: 'user',
      content: `Task #${task.id}: ${task.title}${task.details ? `\n\nDetails:\n${task.details}` : ''}`,
    },
  ];
  // Usage of the turn being streamed; if the stream breaks before usage arrives, it is estimated and still charged.
  let inFlight: { in: number; outChars: number } | null = null;
  const files: AgentOutput['files'] = [];
  try {
    for (let turn = 0; turn < cfg.maxTurns; turn++) {
      const remaining = cfg.maxTokensPerTask - totals.tokensIn - totals.tokensOut;
      if (remaining < 200)
        return fail('max_cost', `Token limit reached (${cfg.maxTokensPerTask} tokens per task).`);
      emit('status_changed', { status: 'thinking', turn: turn + 1 });
      const res = await post(ctx, {
        model,
        messages,
        tools,
        stream: true,
        max_tokens: Math.min(4000, remaining),
      });
      const turnUsage = { in: estimateTokens(JSON.stringify(messages).length), outChars: 0 };
      inFlight = turnUsage;

      // Stream text into the office in readable pieces rather than one event per token.
      let pending = '';
      let lastFlush = Date.now();
      let thinkingSent = false;
      const flush = (force = false) => {
        const text = pending.trim();
        if (!text || (!force && text.length < 60 && Date.now() - lastFlush < 1500)) return;
        emit('message', { text, kind: 'stream' });
        pending = '';
        lastFlush = Date.now();
      };
      const out = await readStream(
        res,
        (t) => {
          turnUsage.outChars += t.length;
          pending += t;
          if (/[.!?\n]\s*$/.test(pending) || pending.length > 280) flush();
        },
        (r) => {
          turnUsage.outChars += r.length;
          if (!thinkingSent) emit('status_changed', { status: 'thinking', reasoning: true });
          thinkingSent = true;
        },
      );
      flush(true);

      inFlight = null;
      totals.tokensIn += out.usage?.prompt_tokens ?? turnUsage.in;
      totals.tokensOut +=
        out.usage?.completion_tokens ??
        estimateTokens(turnUsage.outChars + JSON.stringify(out.calls).length);
      totals.costUsd = cfg.mockMode ? 0 : costOf(model, totals.tokensIn, totals.tokensOut);
      if (ctx.onUsage && !ctx.onUsage({ ...totals }))
        return fail('max_cost', 'Stopped: this task passed its cost limit.');

      if (!out.calls.length) {
        const text = out.content.trim() || 'Done.';
        return {
          ok: true,
          summary: text.split('\n')[0].slice(0, 200),
          output: { type: 'markdown', text, files },
          ...totals,
        };
      }
      messages.push({
        role: 'assistant',
        content: out.content,
        tool_calls: out.calls.map((c, i) => ({
          id: c.id || `call_${turn}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });
      for (const [i, c] of out.calls.entries()) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.args || '{}');
        } catch {
          /* answered below as invalid */
        }
        const id = c.id || `call_${turn}_${i}`;
        if (c.name === 'finish_task') {
          const summary = String(args.summary ?? out.content ?? '').trim() || 'Done.';
          const type = outputTypes.includes(args.output_type as OutputType)
            ? (args.output_type as OutputType)
            : 'markdown';
          const output: AgentOutput = {
            type,
            text: String(args.output ?? summary),
            files,
            ...(typeof args.language === 'string' && { language: args.language.slice(0, 30) }),
            ...(typeof args.svg === 'string' && args.svg.trim() && { svg: args.svg }),
          };
          return { ok: true, summary, output, ...totals };
        }
        let result = 'ok';
        if (c.name === 'save_file') {
          const name = String(args.name ?? '');
          const content = String(args.content ?? '');
          if (files.length >= 5) result = 'error: at most 5 files per task';
          else if (!name || !content) result = 'error: name and content are required';
          else {
            files.push({ name, content });
            result = `saved ${name}`;
          }
          messages.push({ role: 'tool', tool_call_id: id, content: result });
          continue;
        }
        if (c.name === 'say' && typeof args.text === 'string' && args.text.trim())
          emit('message', { text: args.text.trim().slice(0, 500), kind: 'say' });
        else if (
          c.name === 'move_to' &&
          locations.includes(args.location as (typeof locations)[number])
        )
          emit('status_changed', { status: 'moving', location: args.location });
        else result = `error: invalid call to ${c.name}`;
        messages.push({ role: 'tool', tool_call_id: id, content: result });
      }
    }
    return fail('max_turns', `Stopped after ${cfg.maxTurns} turns without finish_task.`);
  } catch (err) {
    if (inFlight) {
      totals.tokensIn += inFlight.in;
      totals.tokensOut += estimateTokens(inFlight.outChars);
      totals.costUsd = cfg.mockMode ? 0 : costOf(model, totals.tokensIn, totals.tokensOut);
      ctx.onUsage?.({ ...totals });
    }
    if (ctx.signal.aborted) return fail('cancelled', 'Cancelled.');
    const msg =
      err instanceof Error
        ? err.name === 'TimeoutError'
          ? `Request timed out after ${cfg.timeoutMs / 1000}s`
          : err.message
        : String(err);
    return fail('api_error', msg);
  }
}

/** MOCK_MODE results: the output type follows the title, so every renderer can be tried for free. */
export function mockOutput(title: string) {
  const summary = `Mock result for "${title}": generated locally by MOCK_MODE, with no API call.`;
  if (/picture|image|draw|poster|logo|illustration/i.test(title))
    return {
      summary,
      output_type: 'image',
      output: `Pixel-art illustration for "${title}": warm autumn office, isometric, soft light. (mock prompt)`,
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40" shape-rendering="crispEdges">' +
        '<rect width="64" height="40" fill="#fde68a"/><rect y="28" width="64" height="12" fill="#b45309"/>' +
        '<rect x="8" y="14" width="18" height="14" fill="#f472b6"/><rect x="34" y="8" width="22" height="20" fill="#60a5fa"/>' +
        '<rect x="12" y="18" width="4" height="4" fill="#1f2937"/><rect x="40" y="14" width="10" height="8" fill="#e0f2fe"/></svg>',
    };
  if (/code|script|function|program/i.test(title))
    return {
      summary,
      output_type: 'code',
      language: 'python',
      output: `# ${title} (mock)\ndef main():\n    print("Hello from MOCK_MODE")\n\nif __name__ == "__main__":\n    main()\n`,
    };
  return {
    summary,
    output_type: 'markdown',
    output:
      `## ${title}\n\nThis is a **mock** result from MOCK_MODE, with no API call.\n\n` +
      `- First point\n- Second point with \`inline code\`\n\n\`\`\`js\nconsole.log('copy me');\n\`\`\`\n`,
  };
}

/** MOCK_MODE: a fake xAI endpoint that streams the same chunk format with no network call. */
export const mockFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const msgs: Msg[] = body.messages ?? [];
  const title = String(msgs[1]?.content ?? '')
    .split('\n')[0]
    .replace(/^Task #\d+:\s*/, '');
  const toolTurns = msgs.filter((m) => m.role === 'tool').length;
  const promptTokens = 120 + JSON.stringify(msgs).length / 4;
  const isChat = (body.tools ?? []).some(
    (t: { function?: { name?: string } }) => t.function?.name === 'place_task',
  );
  const chunks: unknown[] = [];
  const text = (t: string) =>
    t
      .split(/(?<= )/)
      .forEach((w) => chunks.push({ choices: [{ index: 0, delta: { content: w } }] }));
  const call = (name: string, args: unknown) =>
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `mock_${name}_${toolTurns}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
  if (isChat) {
    // Chat with a Bot: greet, echo, and place a task when asked for one.
    const name = /You are ([^,]+),/.exec(String(msgs[0]?.content ?? ''))?.[1] ?? 'your Bot';
    const last = msgs.at(-1);
    const ask = String(last?.content ?? '');
    if (last?.role === 'tool')
      text(
        `(mock) Done: ${String(last.content).replace(/\.$/, '')}. I'll start on it as soon as I'm free.`,
      );
    else if (/\b(task|please|can you|could you|write|make|create|draft|prepare)\b/i.test(ask)) {
      text(`(mock) Sure, I'll put that in my queue. `);
      call('place_task', { title: ask.replace(/\s+/g, ' ').slice(0, 80), priority: 'normal' });
    } else
      text(
        `(mock) Hi, I'm ${name}. You said: "${ask.slice(0, 80)}". With MOCK_MODE=false I'd answer with Grok.`,
      );
  } else if (toolTurns === 0) {
    text(`(mock) Reading the brief for "${title}". `);
    call('say', { text: `Starting on ${title} now (mock reply).` });
  } else {
    text('(mock) Wrapping up with a short summary. ');
    call('finish_task', mockOutput(title));
  }
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: toolTurns ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: Math.round(promptTokens), completion_tokens: 40 + toolTurns * 25 },
  });
  const signal = init?.signal ?? undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) {
        if (signal?.aborted) return c.error(signal.reason);
        c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS ?? 250)));
      }
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
