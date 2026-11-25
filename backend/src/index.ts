import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { botById, roster } from '../../shared/roster';
import { splitSessions } from '../../shared/replay';
import type { BotEvent } from '../../shared/types';
import { openStore } from './db';
import { ProviderManager } from './providers';
import { loadGrokConfig, redact, type GrokConfig } from './config';
import { TaskQueue } from './tasks';
import { ChatService } from './chat';
import { generateImage, isImage, mimeOf, ResultStore } from './results';
import type { runAgent } from './grok';
import { loadLiveControlConfig, type LiveControlConfig } from './grokbot/config';
import { createCliClient, type CliClient } from './grokbot/cli';
import { GrokBotGatewayAdapter } from './grokbot/adapter';
import { registerLiveControlRoutes } from './grokbot/routes';
import { bridgeToOffice } from './grokbot/bridge';
import { parseAgentMap } from './grokbot/mapping';
import { hostGuarded, isLocalHost } from './hostCheck';

const port = Number(process.env.OFFICE_PORT ?? 4319);
const dbPath = process.env.OFFICE_DATABASE ?? resolve('data/office.db');
const production = process.env.NODE_ENV === 'production';

export async function buildServer(opts: {
  dbPath: string;
  simulation?: boolean;
  cacheDir?: string;
  logger?: boolean;
  /** Placed-task queue file; ':memory:' keeps it in memory (tests). */
  tasksFile?: string;
  grok?: GrokConfig;
  runAgent?: typeof runAgent;
  /** Chat history file; ':memory:' for tests. */
  chatFile?: string;
  /** Results folder; ':memory:' for tests. */
  resultsDir?: string;
  fetchImpl?: typeof fetch;
  /** Grok Bot Live Control (tests inject config and a fake CLI). Off unless enabled. */
  liveControl?: { config?: LiveControlConfig; client?: CliClient };
}) {
  const store = openStore(opts.dbPath);
  const providers = new ProviderManager(store);
  const grok = opts.grok ?? loadGrokConfig();
  // After shutdown, late events (a task or chat finishing) are dropped instead of hitting the closed database.
  let closed = false;
  const publish = (e: Parameters<typeof providers.publish>[0]) => {
    if (!closed) providers.publish(e);
  };
  const results = new ResultStore(
    opts.resultsDir ?? process.env.OFFICE_RESULTS_DIR ?? resolve('data/results'),
    grok.resultsKeep,
  );
  const queue: TaskQueue = new TaskQueue(
    grok,
    publish,
    opts.tasksFile ?? process.env.OFFICE_TASKS_FILE ?? resolve('data/tasks.json'),
    {
      hold: (id, on) => providers.hold(id, on),
      runAgent: opts.runAgent,
      onFinish: (t, output, files) => results.save(t, grok, output, files),
      // Real image generation only when explicitly enabled, live, and within budget.
      prepareOutput: async (t, output) => {
        if (output.type !== 'image' || !grok.imageApi || grok.mockMode)
          return { output, files: [] };
        if (queue.budget().remainingUsd < grok.imagePriceUsd)
          return {
            output: {
              ...output,
              text: `${output.text}\n\n(No image generated: not enough daily budget left.)`,
            },
            files: [],
          };
        const img = await generateImage(grok, output.text, opts.fetchImpl);
        queue.charge(grok.imagePriceUsd);
        return { output, files: [img], costUsd: grok.imagePriceUsd };
      },
    },
  );
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024 });
  const chat = new ChatService(
    grok,
    queue,
    publish,
    opts.chatFile ?? process.env.OFFICE_CHAT_FILE ?? resolve('data/chats.json'),
    opts.fetchImpl,
  );

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
  app.get('/api/roster', async () => ({
    bots: roster,
    source: 'project roster (grok-3d-office/shared/simulation.ts)',
  }));
  app.get('/api/sources', async () => providers.status());

  app.post('/api/sources/simulation', async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    providers.setSimulation(body.enabled);
    return providers.status();
  });

  app.post('/api/sources/local', async (req, reply) => {
    const body = z
      .object({ dir: z.string().min(1).max(1024).nullable(), authorize: z.boolean().optional() })
      .parse(req.body);
    if (body.dir && body.authorize !== true)
      return reply
        .code(400)
        .send({ error: 'Read access must be explicitly authorised for this folder.' });
    try {
      await providers.setLocalCache(body.dir);
      return providers.status();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/simulate/meeting', async (req, reply) => {
    const body = z
      .object({
        participants: z.array(z.string()).optional(),
        title: z.string().max(80).optional(),
      })
      .parse(req.body ?? {});
    const r = providers.simulatedMeeting(body.participants, body.title);
    return r.ok ? r : reply.code(409).send({ error: r.reason });
  });

  app.get('/api/events', async (req) => {
    const q = z
      .object({
        from: z.coerce.number().optional(),
        to: z.coerce.number().optional(),
        limit: z.coerce.number().max(50000).optional(),
      })
      .parse(req.query);
    if (q.from !== undefined)
      return { events: store.range(q.from, q.to ?? Date.now(), q.limit ?? 20000) };
    return { events: store.recent(q.limit ?? 500) };
  });

  app.get('/api/sessions', async () => {
    const rows = store.timestamps();
    const fake = rows.map(
      (r) =>
        ({
          id: r.id,
          botId: '',
          timestamp: r.ts,
          type: 'message',
          source: r.source,
          payload: {},
        }) as BotEvent,
    );
    return { sessions: splitSessions(fake).reverse() };
  });

  // DNS-rebinding guard for the event stream and Live Control: non-local Host headers get 403.
  app.addHook('onRequest', async (req, reply) => {
    if (hostGuarded(req.url) && !isLocalHost(req.headers.host)) return reply.code(403).send({ error: 'Forbidden host.' });
  });
  // Server-Sent Events: snapshot then live events.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // `liveControl` is added only when the adapter exists, so with the flag off the snapshot is unchanged.
    send('snapshot', {
      // With Live Control on, buffered live messages (memory only) are added so a reload keeps them.
      events: bridge ? bridge.snapshot(store.recent(800)) : store.recent(800),
      sources: providers.status(),
      ...(live ? { liveControl: true } : {}),
    });
    const off = providers.subscribe((e) => send('event', e));
    const beat = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
    const sourcesBeat = setInterval(() => send('sources', providers.status()), 5000);
    req.raw.on('close', () => {
      off();
      clearInterval(beat);
      clearInterval(sourcesBeat);
    });
  });

  // Placed tasks. Optional shared secret (OFFICE_TOKEN) for when the server is reachable from a network.
  const tokenOk = (given: unknown) => {
    if (!grok.officeToken) return true;
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(grok.officeToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  app.addHook('onRequest', async (req, reply) => {
    const guarded = ['/api/tasks', '/api/chat', '/api/results'].some((p) => req.url.startsWith(p));
    // <img> and download links cannot send headers, so results also accept ?token=.
    const given =
      req.headers['x-office-token'] ?? (req.query as { token?: string } | undefined)?.token;
    if (guarded && !tokenOk(given))
      return reply
        .code(401)
        .send({ error: 'This server requires an access token (x-office-token header).' });
  });
  // /api/stream with OFFICE_TOKEN set: EventSource cannot send headers, and a token in the URL would reach the Vite
  // proxy's error log, so the page trades the token (header only) for a one-time ticket that expires after 30 s.
  const streamTickets = new Map<string, number>();
  app.post('/api/stream-ticket', async (req, reply) => {
    if (!tokenOk(req.headers['x-office-token']))
      return reply.code(401).send({ error: 'This server requires an access token (x-office-token header).' });
    const now = Date.now();
    for (const [t, exp] of streamTickets) if (exp < now || streamTickets.size > 1000) streamTickets.delete(t);
    const ticket = randomBytes(24).toString('base64url');
    streamTickets.set(ticket, now + 30_000);
    return { ticket };
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!grok.officeToken || req.url.split('?')[0] !== '/api/stream') return;
    const ticket = (req.query as { ticket?: string } | undefined)?.ticket;
    const exp = ticket ? streamTickets.get(ticket) : undefined;
    if (ticket) streamTickets.delete(ticket); // single use
    if (!exp || exp < Date.now())
      return reply.code(401).send({ error: 'This server requires an access token (stream ticket).' });
  });
  // Grok Bot Live Control: nothing below is constructed, registered or scheduled when the flag is off.
  const liveCfg = opts.liveControl?.config ?? loadLiveControlConfig();
  const live = liveCfg.enabled
    ? new GrokBotGatewayAdapter(liveCfg, opts.liveControl?.client ?? createCliClient(liveCfg))
    : undefined;
  // Live messages are broadcast over SSE only, never stored (decision D4).
  const bridge = live
    ? bridgeToOffice(live, (e) => !closed && providers.broadcast(e), parseAgentMap(liveCfg.agentMap))
    : undefined;
  if (live) registerLiveControlRoutes(app, live, tokenOk, bridge!.mapping);
  const agentIds = ['auto', ...roster.map((b) => b.id)] as [string, ...string[]];
  const newTask = z.object({
    title: z
      .string()
      .trim()
      .min(1, 'Give the task a title.')
      .max(120, 'Keep the title under 120 characters.'),
    details: z.string().max(4000, 'Keep details under 4000 characters.').optional(),
    agent: z.enum(agentIds, { message: 'Choose Auto or one of the six agents.' }),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    max_cost_usd: z.number().positive().max(100).optional(),
  });
  const idParam = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const result = <T extends object>(
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    r: T | { error: string },
  ) => ('error' in r ? reply.code(409).send(r) : r);
  app.get('/api/tasks', async () => ({
    tasks: queue.list(),
    budget: queue.budget(),
    config: queue.info(),
  }));
  app.post('/api/tasks', async (req, reply) => {
    const body = newTask.safeParse(req.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.code(400).send({ error: issue.message, field: issue.path.join('.') });
    }
    return result(reply, queue.create(body.data));
  });
  app.post('/api/tasks/:id/cancel', async (req, reply) =>
    result(reply, queue.cancel(idParam(req))),
  );
  app.post('/api/tasks/:id/retry', async (req, reply) => result(reply, queue.retry(idParam(req))));

  // Results board: saved outputs of finished tasks.
  app.get('/api/results', async () => results.list());
  app.get('/api/results/export.md', async (_req, reply) =>
    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="pixel-office-results.md"')
      .send(results.exportMarkdown()),
  );
  app.get('/api/results/export.zip', async (_req, reply) =>
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="pixel-office-results.zip"')
      .send(results.exportZip()),
  );
  app.put('/api/results/settings', async (req, reply) => {
    const body = z
      .object({ keep: z.number().int().min(10, 'Keep at least 10 results.').max(100000) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    return { keep: results.setKeep(body.data.keep) };
  });
  app.get('/api/results/:id', async (req, reply) => {
    const rec = results.get(idParam(req));
    return rec ?? reply.code(404).send({ error: 'Result not found.' });
  });
  app.patch('/api/results/:id', async (req, reply) => {
    const body = z
      .object({ pinned: z.boolean().optional(), read: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid change.' });
    return (
      results.patch(idParam(req), body.data) ?? reply.code(404).send({ error: 'Result not found.' })
    );
  });
  app.delete('/api/results/:id', async (req, reply) =>
    results.delete(idParam(req))
      ? { ok: true }
      : reply.code(404).send({ error: 'Result not found.' }),
  );
  app.post('/api/results/:id/rerun', async (req, reply) => {
    const rec = results.get(idParam(req));
    if (!rec) return reply.code(404).send({ error: 'Result not found.' });
    return result(
      reply,
      queue.create({
        title: rec.title,
        details: rec.details,
        agent: rec.agent,
        priority: 'normal',
      }),
    );
  });
  // Files are served from this local server only, never as active content.
  const safeHeaders = (reply: { header: (k: string, v: string) => unknown }) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    );
    reply.header('Cache-Control', 'no-store');
  };
  app.get('/api/results/:id/files/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const data = results.file(idParam(req), name);
    if (!data) return reply.code(404).send({ error: 'File not found.' });
    safeHeaders(reply);
    const download = (req.query as { download?: string }).download === '1' || !isImage(name);
    if (download) reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.type(mimeOf(name)).send(data);
  });
  const extOf: Record<string, string> = {
    python: 'py',
    javascript: 'js',
    js: 'js',
    typescript: 'ts',
    ts: 'ts',
    html: 'html',
    css: 'css',
    sql: 'sql',
    json: 'json',
    bash: 'sh',
    shell: 'sh',
  };
  app.get('/api/results/:id/download', async (req, reply) => {
    const rec = results.get(idParam(req));
    if (!rec) return reply.code(404).send({ error: 'Result not found.' });
    const ext =
      rec.output_type === 'code'
        ? (extOf[rec.language?.toLowerCase() ?? ''] ?? 'txt')
        : rec.output_type === 'text'
          ? 'txt'
          : 'md';
    safeHeaders(reply);
    return reply
      .header('Content-Disposition', `attachment; filename="result-${rec.task_id}.${ext}"`)
      .type('text/plain; charset=utf-8')
      .send(rec.output);
  });

  // Direct chat with one Bot. POST streams the reply as server-sent events.
  const botParam = (req: { params: unknown }) =>
    botById((req.params as { botId: string }).botId)?.id;
  app.get('/api/chat/:botId', async (req, reply) => {
    const id = botParam(req);
    if (!id) return reply.code(404).send({ error: 'Unknown Bot.' });
    return {
      messages: chat.history(id),
      busy: chat.isBusy(id),
      mock: grok.mockMode,
      budget: queue.budget(),
    };
  });
  app.delete('/api/chat/:botId', async (req, reply) => {
    const id = botParam(req);
    if (!id) return reply.code(404).send({ error: 'Unknown Bot.' });
    if (chat.isBusy(id))
      return reply.code(409).send({ error: 'Wait for the current reply to finish.' });
    chat.clear(id);
    return { ok: true };
  });
  // "/task ..." or "Make it a task": first line is the title, the rest the details.
  app.post('/api/chat/:botId/task', async (req, reply) => {
    const id = botParam(req);
    if (!id) return reply.code(404).send({ error: 'Unknown Bot.' });
    const body = z
      .object({ text: z.string().trim().min(1, 'Type the task first.').max(4120) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    const [first, ...rest] = body.data.text.replace(/^\/task\b\s*/i, '').split('\n');
    const title = first.trim().slice(0, 120);
    if (!title) return reply.code(400).send({ error: 'Give the task a title after /task.' });
    const t = queue.create({
      title,
      details: rest.join('\n').trim().slice(0, 4000),
      agent: id,
      priority: 'normal',
    });
    if ('error' in t) return reply.code(409).send(t);
    return { task: t, messages: chat.noteTask(id, body.data.text, t) };
  });
  app.post('/api/chat/:botId', async (req, reply) => {
    const id = botParam(req);
    if (!id) return reply.code(404).send({ error: 'Unknown Bot.' });
    const body = z
      .object({
        text: z
          .string()
          .trim()
          .min(1, 'Type a message first.')
          .max(2000, 'Keep messages under 2000 characters.'),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    if (chat.isBusy(id))
      return reply.code(409).send({ error: 'This Bot is still answering. Wait a moment.' });
    if (queue.budget().exhausted)
      return reply
        .code(409)
        .send({ error: 'The daily budget is used up, so chat replies are paused until tomorrow.' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const ctl = new AbortController();
    reply.raw.on('close', () => ctl.abort(new Error('client closed')));
    await chat.send(id, body.data.text, ctl.signal, (event, data) => {
      if (!reply.raw.writableEnded)
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    reply.raw.end();
  });

  const keySchema = z.string().regex(/^[a-z0-9:_-]{1,64}$/);
  app.get('/api/state/:key', async (req, reply) => {
    const key = keySchema.safeParse((req.params as { key: string }).key);
    if (!key.success) return reply.code(400).send({ error: 'bad key' });
    return { value: store.getState(key.data) ?? null };
  });
  app.put('/api/state/:key', async (req, reply) => {
    const key = keySchema.safeParse((req.params as { key: string }).key);
    if (!key.success || key.data.startsWith('source:'))
      return reply.code(400).send({ error: 'bad key' });
    store.setState(key.data, (req.body as { value: unknown })?.value ?? null);
    return { ok: true };
  });

  const dist = resolve('dist');
  if (production && existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api')
        ? reply.code(404).send({ error: 'not found' })
        : reply.sendFile('index.html'),
    );
  }

  const prune = setInterval(() => store.prune(), 10 * 60 * 1000);
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(prune);
    queue.stop();
    live?.stop();
    providers.stop();
    store.close();
  });
  await providers.restore({ simulation: opts.simulation ?? true, cacheDir: opts.cacheDir });
  // Not awaited: a slow or missing CLI must never delay or break server start.
  if (live) void live.start({ paused: liveCfg.startPaused });
  return { app, store, providers, queue, live };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const { app } = await buildServer({
    dbPath,
    simulation: process.env.OFFICE_SIMULATION !== '0',
    cacheDir: process.env.OFFICE_CACHE_DIR,
    logger: !!process.env.OFFICE_LOG,
  });
  await app.listen({ host: '127.0.0.1', port });
  const cfg = loadGrokConfig();
  // Leave a trace if the server ever dies (key removed from the text).
  for (const ev of ['uncaughtException', 'unhandledRejection'] as const)
    process.on(ev, (err: unknown) => {
      console.error(
        `Server error (${ev}):`,
        redact(cfg, err instanceof Error ? (err.stack ?? err.message) : String(err)),
      );
      if (ev === 'uncaughtException') process.exit(1);
    });
  console.log(
    `Pixel Office API on http://127.0.0.1:${port}${production ? ' (serving dist/)' : ''}`,
  );
  console.log(
    cfg.mockMode
      ? 'Placed tasks: MOCK_MODE (no API calls, no cost).'
      : `Placed tasks: live xAI API, model ${cfg.model}, daily budget $${cfg.dailyBudgetUsd}.`,
  );
}
