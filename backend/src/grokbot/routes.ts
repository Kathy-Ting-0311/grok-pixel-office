import type { FastifyInstance } from 'fastify';
import type { LiveMapping } from '../../../shared/liveControl';
import type { GrokBotGatewayAdapter } from './adapter';

/**
 * /api/live-control/* — registered ONLY when ENABLE_GROKBOT_LIVE_CONTROL=true. With the flag off these
 * routes do not exist (404). The server already listens on 127.0.0.1 only.
 */
export function registerLiveControlRoutes(
  app: FastifyInstance,
  live: GrokBotGatewayAdapter,
  tokenOk: (given: unknown) => boolean,
  mapping: () => LiveMapping[] = () => [],
) {
  const status = () => ({ ...live.status(), mapping: mapping() });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/live-control')) return;
    if (!tokenOk(req.headers['x-office-token']))
      return reply
        .code(401)
        .send({ error: 'This server requires an access token (x-office-token header).' });
  });

  app.get('/api/live-control/status', async () => status());

  app.get('/api/live-control/thread/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const messages = live.thread(id);
    if (!messages) return reply.code(404).send({ error: 'Unknown thread.' });
    return { messages };
  });

  app.post('/api/live-control/active', async (req) => {
    const id = (req.body as { id?: unknown } | undefined)?.id;
    live.setActiveThread(typeof id === 'string' ? id : undefined);
    return status();
  });

  app.post('/api/live-control/reconnect', async () => {
    await live.reconnect();
    return status();
  });

  // Pause / resume polling. In memory only: every server start begins paused again (D7).
  app.post('/api/live-control/pause', async () => {
    live.pause();
    return status();
  });
  app.post('/api/live-control/resume', async () => {
    live.resume();
    return status();
  });

  /**
   * Sending. Refused here, before anything else, while GROKBOT_LIVE_SEND_ENABLED is off. When on, the
   * request must carry `confirm: true` (set only by the UI's explicit confirmation) and is sent once.
   */
  app.post('/api/live-control/send', async (req, reply) => {
    const gate = live.status().send;
    if (!gate.enabled)
      return reply.code(403).send({ ok: false, delivery: 'refused', error: gate.reason });
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown; confirm?: unknown };
    if (b.confirm !== true || typeof b.id !== 'string' || typeof b.text !== 'string')
      return reply
        .code(400)
        .send({ ok: false, delivery: 'refused', error: 'Send needs id, text and confirm: true.' });
    const r = await live.send(b.id, b.text);
    return reply.code(r.ok ? 200 : r.delivery === 'refused' ? 400 : 502).send(r);
  });
}
