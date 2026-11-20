import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { roster } from '../../shared/roster';
import { splitSessions } from '../../shared/replay';
import type { BotEvent } from '../../shared/types';
import { openStore } from './db';
import { ProviderManager } from './providers';

const port = Number(process.env.OFFICE_PORT ?? 4319);
const dbPath = process.env.OFFICE_DATABASE ?? resolve('data/office.db');
const production = process.env.NODE_ENV === 'production';

export async function buildServer(opts: { dbPath: string; simulation?: boolean; cacheDir?: string; logger?: boolean }) {
  const store = openStore(opts.dbPath);
  const providers = new ProviderManager(store);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024 });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
  app.get('/api/roster', async () => ({ bots: roster, source: 'project roster (grok-3d-office/shared/simulation.ts)' }));
  app.get('/api/sources', async () => providers.status());

  app.post('/api/sources/simulation', async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    providers.setSimulation(body.enabled);
    return providers.status();
  });

  app.post('/api/sources/local', async (req, reply) => {
    const body = z.object({ dir: z.string().min(1).max(1024).nullable(), authorize: z.boolean().optional() }).parse(req.body);
    if (body.dir && body.authorize !== true) return reply.code(400).send({ error: 'Read access must be explicitly authorised for this folder.' });
    try {
      await providers.setLocalCache(body.dir);
      return providers.status();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/simulate/meeting', async (req, reply) => {
    const body = z.object({ participants: z.array(z.string()).optional(), title: z.string().max(80).optional() }).parse(req.body ?? {});
    const r = providers.simulatedMeeting(body.participants, body.title);
    return r.ok ? r : reply.code(409).send({ error: r.reason });
  });

  app.get('/api/events', async (req) => {
    const q = z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional(), limit: z.coerce.number().max(50000).optional() }).parse(req.query);
    if (q.from !== undefined) return { events: store.range(q.from, q.to ?? Date.now(), q.limit ?? 20000) };
    return { events: store.recent(q.limit ?? 500) };
  });

  app.get('/api/sessions', async () => {
    const rows = store.timestamps();
    const fake = rows.map((r) => ({ id: r.id, botId: '', timestamp: r.ts, type: 'message', source: r.source, payload: {} }) as BotEvent);
    return { sessions: splitSessions(fake).reverse() };
  });

  // Server-Sent Events: snapshot then live events.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', { events: store.recent(800), sources: providers.status() });
    const off = providers.subscribe((e) => send('event', e));
    const beat = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
    const sourcesBeat = setInterval(() => send('sources', providers.status()), 5000);
    req.raw.on('close', () => {
      off();
      clearInterval(beat);
      clearInterval(sourcesBeat);
    });
  });

  const keySchema = z.string().regex(/^[a-z0-9:_-]{1,64}$/);
  app.get('/api/state/:key', async (req, reply) => {
    const key = keySchema.safeParse((req.params as { key: string }).key);
    if (!key.success) return reply.code(400).send({ error: 'bad key' });
    return { value: store.getState(key.data) ?? null };
  });
  app.put('/api/state/:key', async (req, reply) => {
    const key = keySchema.safeParse((req.params as { key: string }).key);
    if (!key.success || key.data.startsWith('source:')) return reply.code(400).send({ error: 'bad key' });
    store.setState(key.data, (req.body as { value: unknown })?.value ?? null);
    return { ok: true };
  });

  const dist = resolve('dist');
  if (production && existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }

  const prune = setInterval(() => store.prune(), 10 * 60 * 1000);
  app.addHook('onClose', async () => {
    clearInterval(prune);
    providers.stop();
    store.close();
  });
  await providers.restore({ simulation: opts.simulation ?? true, cacheDir: opts.cacheDir });
  return { app, store, providers };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const { app } = await buildServer({
    dbPath,
    simulation: process.env.OFFICE_SIMULATION !== '0',
    cacheDir: process.env.OFFICE_CACHE_DIR,
    logger: !!process.env.OFFICE_LOG,
  });
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Pixel Office API on http://127.0.0.1:${port}${production ? ' (serving dist/)' : ''}`);
}
