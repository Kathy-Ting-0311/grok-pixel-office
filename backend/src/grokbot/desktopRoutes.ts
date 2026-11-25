import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LiveMapping, LiveMessage } from '../../../shared/liveControl';
import type { DesktopSource, ResultStore } from '../results';
import type { GrokBotGatewayAdapter } from './adapter';
import type { DesktopTaskStore } from './desktopTasks';

/**
 * Grok Bot Desktop results and manual task tracking. Registered only with Live Control on, under
 * /api/live-control/ (so the existing token and Host checks apply). Content is always taken from the server's
 * own synced transcript by message key, never from the request, so nothing can be saved that a real bot did
 * not send. Nothing is saved or tracked unless the user asks for that one message.
 */

const KEY = z.string().regex(/^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_.:-]{1,200}$/);
const BOT = new Set(['verified', 'thread-target']);

/** First meaningful line, without Markdown markers, as a short title. */
export function titleOf(text: string) {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*(#{1,6}\s+|[-*+>]\s+|\d+\.\s+)/, '')
          .replace(/[*_`~]/g, '')
          .trim(),
      )
      .find(Boolean) ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || 'Grok Desktop reply';
}

export const looksLikeMarkdown = (t: string) =>
  /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\//.test(t);

export function registerDesktopRoutes(
  app: FastifyInstance,
  live: GrokBotGatewayAdapter,
  results: ResultStore,
  tasks: DesktopTaskStore,
  mapping: () => LiveMapping[],
) {
  const find = (key: string): { m: LiveMessage; thread: LiveMessage[] } | undefined => {
    const threadId = key.slice(0, key.indexOf(':'));
    const thread = live.thread(threadId);
    const m = thread?.find((x) => x.key === key);
    return m && thread ? { m, thread } : undefined;
  };
  const nameOf = (id: string) => live.status().agents.find((a) => a.id === id)?.name ?? 'Grok Bot';

  app.post('/api/live-control/desktop/results', async (req, reply) => {
    const body = z.object({ key: KEY }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid message key.' });
    const hit = find(body.data.key);
    if (!hit)
      return reply.code(404).send({ error: 'That message is not in the synced transcript.' });
    const { m, thread } = hit;
    const isAttachment = m.placeholder?.type === 'attachment' && !!m.attachment;
    if (!BOT.has(m.attribution) || !m.senderId || (m.placeholder && !isAttachment))
      return reply
        .code(400)
        .send({ error: 'Only a real bot reply (text or attachment) can be saved.' });
    const rosterId = mapping().find((x) => x.agentId === m.senderId)?.rosterId;
    if (!rosterId)
      return reply.code(400).send({ error: 'This bot is not mapped to an office character.' });
    // Attachment references from the same turn (name and type only), plus the message itself if it is one.
    const attachments = thread
      .filter(
        (x) =>
          x.attachment &&
          BOT.has(x.attribution) &&
          (x === m || (!!m.requestId && x.requestId === m.requestId)),
      )
      .map((x) => x.attachment!);
    const text = isAttachment ? `Attachment: ${m.attachment!.name}` : m.text;
    const source: DesktopSource = {
      kind: 'grok-desktop',
      agentId: m.senderId,
      agentName: nameOf(m.senderId),
      threadId: m.threadId,
      messageKey: m.key,
      entryId: m.entryId,
      timestamp: m.timestamp,
      attribution: m.attribution,
      attachments,
    };
    const r = results.saveDesktop({
      title: titleOf(text),
      agent: rosterId,
      outputType: looksLikeMarkdown(text) ? 'markdown' : 'text',
      output: text,
      source,
    });
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });

  /** The user's own saved-result keys for one thread, so the view can show "Saved" without loading records. */
  app.get('/api/live-control/desktop/saved', async (req) => {
    const thread = z
      .object({ thread: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
      .safeParse(req.query);
    if (!thread.success) return { saved: {} };
    const saved: Record<string, number> = {};
    for (const e of results.list().results)
      if (e.src === 'grok-desktop') {
        const s = results.get(e.id)?.source;
        if (s?.threadId === thread.data.thread) saved[s.messageKey] = e.id;
      }
    return { saved };
  });

  app.get('/api/live-control/desktop/tasks', async (req) => {
    const agent = (req.query as { agent?: unknown } | undefined)?.agent;
    tasks.forgetResults((id) => !!results.get(id)?.source);
    return { tasks: tasks.list(typeof agent === 'string' ? agent : undefined) };
  });

  app.post('/api/live-control/desktop/tasks', async (req, reply) => {
    const body = z.object({ key: KEY }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid message key.' });
    const hit = find(body.data.key);
    if (!hit)
      return reply.code(404).send({ error: 'That message is not in the synced transcript.' });
    const { m } = hit;
    if (m.attribution !== 'owner' || m.placeholder || m.isGroup)
      return reply
        .code(400)
        .send({ error: 'Only your own text message in a 1:1 thread can be tracked as a task.' });
    const r = tasks.track({
      agentId: m.threadId,
      agentName: nameOf(m.threadId),
      requestKey: m.key,
      title: titleOf(m.text),
      requestedAt: m.timestamp,
    });
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });

  app.patch('/api/live-control/desktop/tasks/:id', async (req, reply) => {
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    const body = z
      .object({
        completed: z.boolean().optional(),
        resultIds: z.array(z.number().int().positive()).max(50).optional(),
      })
      .safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'Invalid change.' });
    if (body.data.resultIds?.some((r) => !results.get(r)?.source))
      return reply.code(400).send({ error: 'Only saved Grok Desktop results can be linked.' });
    const t = tasks.update(id.data, body.data);
    return t ? { task: t } : reply.code(404).send({ error: 'Task not found.' });
  });

  app.delete('/api/live-control/desktop/tasks/:id', async (req, reply) => {
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: 'Invalid task.' });
    return tasks.remove(id.data)
      ? { ok: true }
      : reply.code(404).send({ error: 'Task not found.' });
  });
}
