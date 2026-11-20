import { describe, expect, it } from 'vitest';
import { loadGrokConfig, redact } from '../../backend/src/config';
import { runAgent } from '../../backend/src/grok';
import { buildServer } from '../../backend/src/index';
import { roster } from '../../shared/roster';
import type { BotEvent } from '../../shared/types';

process.env.MOCK_DELAY_MS = '0';
const KEY = 'xai-TESTKEY0000000000000000000000000000';
const bot = roster[1];
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
  });
const finish = (summary: string, usage = { prompt_tokens: 100, completion_tokens: 50 }) =>
  sse([
    { choices: [{ delta: { content: 'Working. ' } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                function: { name: 'finish_task', arguments: JSON.stringify({ summary }) },
              },
            ],
          },
        },
      ],
      usage,
    },
  ]);
const live = (over: Record<string, string> = {}) => ({
  ...loadGrokConfig({ XAI_API_KEY: KEY, MOCK_MODE: 'false', ...over }),
  timeoutMs: 5000,
});
const ctx = (
  cfg = live(),
  fetchImpl?: typeof fetch,
  events: [string, Record<string, unknown>][] = [],
) => ({
  cfg,
  fetchImpl,
  signal: new AbortController().signal,
  emit: (t: string, p: Record<string, unknown>) => events.push([t, p]),
});

describe('config', () => {
  it('stays in mock mode unless MOCK_MODE=false and a key exists', () => {
    expect(loadGrokConfig({}).mockMode).toBe(true);
    expect(loadGrokConfig({ MOCK_MODE: 'false' }).mockMode).toBe(true);
    expect(loadGrokConfig({ MOCK_MODE: 'false', XAI_API_KEY: KEY }).mockMode).toBe(false);
  });
  it('redacts the key and anything shaped like an xAI key', () => {
    const cfg = live();
    expect(redact(cfg, `bad ${KEY} and xai-${'a'.repeat(30)}`)).toBe(
      'bad [redacted] and [redacted]',
    );
  });
});

describe('runAgent', () => {
  it('streams, executes finish_task and reports usage', async () => {
    const events: [string, Record<string, unknown>][] = [];
    const r = await runAgent(
      { id: 1, title: 'T', details: '' },
      bot,
      ctx(live(), async () => finish('All done'), events),
    );
    expect(r).toMatchObject({
      ok: true,
      summary: 'All done',
      tokensIn: 100,
      tokensOut: 50,
      model: 'grok-4.3',
    });
    expect(r.costUsd).toBeCloseTo((100 * 1.25 + 50 * 2.5) / 1e6);
    expect(
      events.some(([t, p]) => t === 'message' && p.text === 'Working.' && p.model === 'grok-4.3'),
    ).toBe(true);
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    let calls = 0;
    const f = (async () =>
      ++calls < 3
        ? new Response('busy', { status: calls === 1 ? 429 : 503, headers: { 'retry-after': '0' } })
        : finish('ok')) as typeof fetch;
    const r = await runAgent({ id: 1, title: 'T', details: '' }, bot, ctx(live(), f));
    expect(calls).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('fails clearly after 3 tries and never leaks the key', async () => {
    let calls = 0;
    const f = (async () => (
      calls++,
      new Response(`invalid key ${KEY}`, { status: 500, headers: { 'retry-after': '0' } })
    )) as typeof fetch;
    const r = await runAgent({ id: 1, title: 'T', details: '' }, bot, ctx(live(), f));
    expect(calls).toBe(3);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(!r.ok && r.reason).toBe('api_error');
  });

  it('does not retry a 400 and stops after the turn limit', async () => {
    let calls = 0;
    const bad = (async () => (
      calls++,
      new Response('bad request', { status: 400 })
    )) as typeof fetch;
    expect((await runAgent({ id: 1, title: 'T', details: '' }, bot, ctx(live(), bad))).ok).toBe(
      false,
    );
    expect(calls).toBe(1);
    const loop = (async () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 's', function: { name: 'say', arguments: '{"text":"hi"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ])) as typeof fetch;
    const r = await runAgent(
      { id: 1, title: 'T', details: '' },
      bot,
      ctx({ ...live(), maxTurns: 3 }, loop),
    );
    expect(r).toMatchObject({ ok: false, reason: 'max_turns' });
  });

  it('mock mode completes without any network call', async () => {
    const r = await runAgent({ id: 1, title: 'T', details: '' }, bot, ctx(loadGrokConfig({})));
    expect(r).toMatchObject({ ok: true, costUsd: 0 });
  });
});

describe('task queue API', () => {
  const setup = async (grok = loadGrokConfig({}), runAgentImpl?: typeof runAgent) => {
    const s = await buildServer({
      dbPath: ':memory:',
      tasksFile: ':memory:',
      simulation: false,
      grok,
      runAgent: runAgentImpl,
    });
    const events: BotEvent[] = [];
    s.providers.subscribe((e) => events.push(e));
    const post = (url: string, body?: unknown) =>
      s.app.inject({
        method: 'POST',
        url,
        payload: body as object,
        headers: { 'x-office-token': 'secret' },
      });
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    return { ...s, events, post, until };
  };

  it('validates input and never returns the key', async () => {
    const { app, post } = await setup(live({ MOCK_MODE: 'true' }));
    expect((await post('/api/tasks', { title: '', agent: 'auto' })).statusCode).toBe(400);
    expect(
      (await post('/api/tasks', { title: 'x'.repeat(121), agent: 'auto' })).json().error,
    ).toMatch(/120/);
    expect((await post('/api/tasks', { title: 'Ok', agent: 'someone-else' })).statusCode).toBe(400);
    const list = await app.inject({ url: '/api/tasks' });
    expect(list.body).not.toContain(KEY);
    expect(list.json().config).toMatchObject({ mock: true, model: 'grok-4.3' });
    await app.close();
  });

  it('runs by priority, at most N at once, and labels mock output simulated', async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const slow: typeof runAgent = async (task) => {
      order.push(task.id);
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { ok: true, summary: 'done', tokensIn: 1, tokensOut: 1, costUsd: 0, model: 'm' };
    };
    const { app, queue, events, until } = await setup(
      { ...loadGrokConfig({}), concurrency: 2 },
      slow,
    );
    const agents = roster.slice(1, 5).map((b) => b.id);
    // Queued in one tick, so the worker sees all four at once.
    queue.create({ title: 'low', agent: agents[0], priority: 'low' });
    queue.create({ title: 'normal', agent: agents[1], priority: 'normal' });
    queue.create({ title: 'high', agent: agents[2], priority: 'high' });
    queue.create({ title: 'high2', agent: agents[3], priority: 'high' });
    await until(() => queue.list().every((t) => t.status === 'done'));
    expect(order).toEqual([3, 4, 2, 1]);
    expect(peak).toBe(2);
    expect(new Set(events.map((e) => e.source))).toEqual(new Set(['simulated']));
    await app.close();
  });

  it('cancels, retries, and aborts a task that passes its cost cap', async () => {
    const pricey: typeof runAgent = async (_t, _b, c) => {
      const keepGoing = c.onUsage!({ tokensIn: 1000, tokensOut: 1000, costUsd: 0.5, model: 'm' });
      if (!keepGoing)
        return {
          ok: false,
          reason: 'max_cost',
          error: 'cap',
          tokensIn: 1000,
          tokensOut: 1000,
          costUsd: 0.5,
          model: 'm',
        };
      await new Promise((r, j) => c.signal.addEventListener('abort', () => j(new Error('x'))));
      return {
        ok: false,
        reason: 'cancelled',
        error: 'Cancelled.',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: 'm',
      };
    };
    const { app, post, queue, events, until } = await setup(
      { ...live({ DAILY_BUDGET_USD: '10' }) },
      pricey,
    );
    const capped = (
      await post('/api/tasks', { title: 'cap', agent: 'auto', max_cost_usd: 0.1 })
    ).json();
    await until(() => queue.get(capped.id)!.status === 'failed');
    expect(events.find((e) => e.type === 'task_failed')?.payload.reason).toBe('max_cost_exceeded');
    expect(events.find((e) => e.type === 'task_failed')?.source).toBe('real');

    const long = (
      await post('/api/tasks', { title: 'long', agent: 'auto', max_cost_usd: 5 })
    ).json();
    await until(() => queue.get(long.id)!.status === 'running');
    expect((await post(`/api/tasks/${long.id}/cancel`)).statusCode).toBe(200);
    await until(() => queue.get(long.id)!.status === 'cancelled');
    expect((await post(`/api/tasks/${long.id}/cancel`)).statusCode).toBe(409);
    expect((await post(`/api/tasks/${long.id}/retry`)).json()).toMatchObject({
      status: 'queued',
      attempt: 2,
    });
    await app.close();
  });

  it('refuses new tasks once the daily budget is used up', async () => {
    const spend: typeof runAgent = async (_t, _b, c) => {
      c.onUsage!({ tokensIn: 1, tokensOut: 1, costUsd: 1.5, model: 'm' });
      return { ok: true, summary: 's', tokensIn: 1, tokensOut: 1, costUsd: 1.5, model: 'm' };
    };
    const { app, post, queue, until } = await setup(live({ DAILY_BUDGET_USD: '1' }), spend);
    await post('/api/tasks', { title: 'spend', agent: 'auto', max_cost_usd: 5 });
    await until(() => queue.list()[0].status === 'done');
    expect(queue.budget().exhausted).toBe(true);
    const r = await post('/api/tasks', { title: 'next', agent: 'auto' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/budget/);
    await app.close();
  });

  it('requires the shared token when OFFICE_TOKEN is set', async () => {
    const { app } = await setup(loadGrokConfig({ OFFICE_TOKEN: 'secret' }));
    expect((await app.inject({ url: '/api/tasks' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/tasks', headers: { 'x-office-token': 'secret' } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('chat with a Bot', () => {
  // A Grok-shaped stream: reasoning deltas, text, a usage-only chunk with empty choices.
  const grokLike = (text: string, call?: { name: string; args: unknown }) =>
    sse([
      {
        choices: [{ index: 0, delta: { reasoning_content: 'Thinking about it' } }],
        usage: { prompt_tokens: 300, completion_tokens: 4 },
      },
      ...text.split(' ').map((w) => ({ choices: [{ index: 0, delta: { content: w + ' ' } }] })),
      ...(call
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.args) },
                      },
                    ],
                  },
                },
              ],
            },
          ]
        : []),
      { choices: [], usage: { prompt_tokens: 300, completion_tokens: 60 } },
    ]);
  const chatServer = async (fetchImpl: typeof fetch, over: Record<string, string> = {}) => {
    const s = await buildServer({
      dbPath: ':memory:',
      tasksFile: ':memory:',
      chatFile: ':memory:',
      simulation: false,
      grok: live(over),
      fetchImpl,
      runAgent: async () => ({
        ok: true,
        summary: 's',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: 'm',
      }),
    });
    const events: BotEvent[] = [];
    s.providers.subscribe((e) => events.push(e));
    const say = async (text: string, bot = 'mock-execution-04') => {
      const r = await s.app.inject({ method: 'POST', url: `/api/chat/${bot}`, payload: { text } });
      if (r.statusCode !== 200) return { status: r.statusCode, evs: [] };
      const evs = r.body
        .split('\n\n')
        .filter(Boolean)
        .map((b) => ({
          event: b.split('\n')[0].slice(7),
          data: JSON.parse(b.split('\ndata: ')[1]),
        }));
      return { status: r.statusCode, evs };
    };
    return { ...s, events, say };
  };

  it('streams a reply in character, keeps history and labels it real', async () => {
    let sent: { messages: { role: string; content: string }[] } | undefined;
    const f = (async (_u: unknown, init?: RequestInit) => (
      (sent = JSON.parse(String(init?.body))),
      grokLike('Hi there, Lena here.')
    )) as typeof fetch;
    const { app, say, events, queue } = await chatServer(f);
    const r = await say('Hello Lena');
    expect(r.status).toBe(200);
    expect(r.evs.map((e) => e.event)).toEqual(
      expect.arrayContaining(['thinking', 'delta', 'done']),
    );
    expect(
      r.evs
        .filter((e) => e.event === 'delta')
        .map((e) => e.data.text)
        .join(''),
    ).toBe('Hi there, Lena here. ');
    expect(sent!.messages[0].content).toContain('Lena Lalina');
    const hist = (await app.inject({ url: '/api/chat/mock-execution-04' })).json();
    expect(hist.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(hist.messages[1]).toMatchObject({ tokensIn: 300, tokensOut: 60, mock: false });
    expect(queue.budget().spentUsd).toBeCloseTo((300 * 1.25 + 60 * 2.5) / 1e6);
    expect(events.find((e) => e.type === 'message')).toMatchObject({
      source: 'real',
      payload: { kind: 'chat' },
    });
    // Second message carries the history.
    await say('Thanks!');
    expect(sent!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    await app.close();
  });

  it('places a task for this Bot when asked', async () => {
    let n = 0;
    const f = (async () =>
      n++ === 0
        ? grokLike('On it.', {
            name: 'place_task',
            args: { title: 'Write three captions', priority: 'high' },
          })
        : grokLike('Added as task #1.')) as typeof fetch;
    const { app, say, queue } = await chatServer(f);
    const r = await say('Please write three captions for Friday');
    expect(r.evs.find((e) => e.event === 'task')?.data.task).toMatchObject({
      id: 1,
      agent: 'mock-execution-04',
      priority: 'high',
    });
    expect(queue.get(1)?.title).toBe('Write three captions');
    const roles = (await app.inject({ url: '/api/chat/mock-execution-04' }))
      .json()
      .messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'note', 'assistant']);
    await app.close();
  });

  it('estimates and charges a reply that breaks off before usage arrives', async () => {
    const broken = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer ' } }] })}\n\n`,
              ),
            );
            // Error after the reader has taken the chunk (erroring discards queued data).
            setTimeout(() => c.error(new Error('connection reset')), 20);
          },
        }),
      )) as typeof fetch;
    const { app, say, queue } = await chatServer(broken);
    const r = await say('Hello');
    expect(r.evs.at(-1)).toMatchObject({ event: 'error', data: { error: 'connection reset' } });
    expect(queue.budget().spentUsd).toBeGreaterThan(0);
    const last = (await app.inject({ url: '/api/chat/mock-execution-04' })).json().messages.at(-1);
    expect(last.text).toBe('Partial answer (stopped)');
    await app.close();
  });

  it('validates input, rejects unknown Bots, and pauses when the budget is used up', async () => {
    const { app, say, queue } = await chatServer((async () => grokLike('ok')) as typeof fetch, {
      DAILY_BUDGET_USD: '0.0001',
    });
    expect((await say('')).status).toBe(400);
    expect((await say('hi', 'nobody')).status).toBe(404);
    expect((await say('x'.repeat(2001))).status).toBe(400);
    queue.charge(1);
    const r = await say('hi');
    expect(r.status).toBe(409);
    await app.close();
  });

  it('mock mode chats and places tasks without any network call', async () => {
    const s = await buildServer({
      dbPath: ':memory:',
      tasksFile: ':memory:',
      chatFile: ':memory:',
      simulation: false,
      grok: loadGrokConfig({}),
    });
    const r = await s.app.inject({
      method: 'POST',
      url: '/api/chat/mock-visual-05',
      payload: { text: 'Please draft a poster idea' },
    });
    expect(r.body).toContain('event: task');
    expect(r.body).toContain('(mock)');
    await s.app.close();
  });
});
