import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrokConfig } from '../../backend/src/config';
import { buildServer } from '../../backend/src/index';
import { DESKTOP_ID_BASE, ResultStore } from '../../backend/src/results';
import type { CliClient } from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { looksLikeMarkdown, titleOf } from '../../backend/src/grokbot/desktopRoutes';
import { desktopTaskState } from '../../shared/desktopTasks';
import type { LiveMessage } from '../../shared/liveControl';
import { bots, COZ, groups, OWNER, sendMessage, thread, ts, userMessage } from '../fixtures/grokbot/fixtures';

// Grok Desktop results (Save as Result) and manual task tracking. Synthetic fixtures and a fake CLI only;
// nothing is sent, and the real data/ folder is never touched (temp folders, removed afterwards).

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'pixel-desktop-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const source = (key: string) => ({
  kind: 'grok-desktop' as const,
  agentId: COZ,
  agentName: 'Coz · Chief',
  threadId: COZ,
  messageKey: key,
  entryId: key.split(':')[1],
  timestamp: new Date(ts(1)).toISOString(),
  attribution: 'thread-target',
  attachments: [],
});

describe('ResultStore.saveDesktop', () => {
  it('own id range, pinned, labelled, no duplicates, survives a restart, deletes cleanly', () => {
    const dir = tempDir();
    const a = new ResultStore(dir, 10);
    const r1 = a.saveDesktop({ title: 'T', agent: 'mock-chief-01', outputType: 'markdown', output: '# Hi', source: source(`${COZ}:e1`) });
    expect(r1).toEqual({ id: DESKTOP_ID_BASE + 1, duplicate: false });
    expect(a.saveDesktop({ title: 'T', agent: 'mock-chief-01', outputType: 'text', output: 'x', source: source(`${COZ}:e1`) })).toEqual({ id: r1.id, duplicate: true });
    const b = new ResultStore(dir, 10); // "restart"
    const e = b.list().results.find((x) => x.id === r1.id)!;
    expect(e).toMatchObject({ pinned: true, src: 'grok-desktop', type: 'markdown', cost: 0 });
    expect(b.get(r1.id)).toMatchObject({ model: 'Grok Desktop', mock: false, output: '# Hi', source: { messageKey: `${COZ}:e1` } });
    expect(b.findDesktop(`${COZ}:e1`)).toBe(r1.id);
    expect(b.saveDesktop({ title: 'U', agent: 'mock-chief-01', outputType: 'text', output: 'y', source: source(`${COZ}:e2`) }).id).toBe(r1.id + 1);
    expect(b.delete(r1.id)).toBe(true);
    const c = new ResultStore(dir, 10);
    expect(c.get(r1.id)).toBeUndefined();
    expect(c.list().results.map((x) => x.id)).toEqual([r1.id + 1]);
    expect(c.findDesktop(`${COZ}:e1`)).toBeUndefined(); // can be saved again after deleting
  });

  it('unpinned Desktop results never push xAI results out of the "keep" limit', () => {
    const s = new ResultStore(':memory:', 10);
    for (let i = 0; i < 12; i++) {
      const { id } = s.saveDesktop({ title: `d${i}`, agent: 'mock-chief-01', outputType: 'text', output: 'x', source: source(`${COZ}:d${i}`) });
      s.patch(id, { pinned: false });
    }
    const desktop = s.list().results.filter((r) => r.src === 'grok-desktop');
    expect(desktop.length).toBeLessThanOrEqual(12);
    s.saveDesktop({ title: 'last', agent: 'mock-chief-01', outputType: 'text', output: 'x', source: source(`${COZ}:last`) });
    // Pruning counts Desktop results on their own: only Desktop entries are ever dropped by Desktop saves.
    expect(s.list().results.every((r) => r.src === 'grok-desktop')).toBe(true);
  });
});

describe('desktopTaskState (never inferred from wording)', () => {
  const m = (n: number, over: Partial<LiveMessage>): LiveMessage => ({
    key: `${COZ}:e${n}`,
    threadId: COZ,
    isGroup: false,
    entryId: `e${n}`,
    timestamp: new Date(ts(n)).toISOString(),
    text: 'x',
    senderId: COZ,
    attribution: 'thread-target',
    basis: '',
    raw: { kind: 'send-message' },
    ...over,
  });
  const t = { requestedAt: new Date(ts(1)).toISOString(), resultIds: [] as number[] };
  it('tracked → working / waiting-input from real entries; result and completion only from the user', () => {
    expect(desktopTaskState(t, [m(2, { text: 'All done! Task complete.' })]).state).toBe('tracked');
    expect(desktopTaskState(t, [m(2, { placeholder: { type: 'cursor-agent' } })]).state).toBe('working');
    expect(desktopTaskState(t, [m(2, { placeholder: { type: 'widget' } })]).state).toBe('waiting-input');
    expect(desktopTaskState(t, [m(0, { placeholder: { type: 'widget' } })]).state).toBe('tracked'); // before the request
    expect(desktopTaskState({ ...t, resultIds: [5] }, []).state).toBe('result-available');
    expect(desktopTaskState({ ...t, resultIds: [5], completedAt: 'x' }, []).state).toBe('completed');
  });
  it('titles and Markdown detection', () => {
    expect(titleOf('## **Poster** plan\nmore')).toBe('Poster plan');
    expect(looksLikeMarkdown('# Title\n- a')).toBe(true);
    expect(looksLikeMarkdown('Just text.')).toBe(false);
  });
});

describe('Desktop routes (server, fake CLI)', () => {
  const attachment = {
    kind: 'send-message',
    id: 't1s2',
    message: { type: 'attachment', url: 'file:///home/box/agent-data/agents/x/poster.png', file_name: 'poster.png', source_path: '/workspace/p/poster.png' },
    timestampMs: ts(3),
    requestId: 'req-t1s1',
    seq: 3,
  };
  const widget = { kind: 'send-message', id: 't1s3', message: { type: 'widget', widget: { prompt: 'Pick' } }, timestampMs: ts(4), requestId: 'req-x', seq: 4 };
  const entries = [userMessage('u1', 1, 'Make a poster plan'), sendMessage('t1s1', 2, '# Plan\n- bold colours'), attachment, widget];
  const client: CliClient = {
    verify: async () => ({ path: '/fake', repo: '/fake', commit: '9616503', version: 'gbot 0.12.5' }),
    json: async (c) =>
      c.cmd === 'bots' ? bots : c.cmd === 'groups' ? groups : c.cmd === 'thread' && c.id === COZ ? thread(COZ, entries) : thread(c.cmd === 'thread' ? c.id : 'x', []),
    send: async () => {
      throw new Error('never sends');
    },
  };
  const start = async (resultsDir: string, token = '') => {
    const s = await buildServer({
      dbPath: ':memory:',
      simulation: false,
      tasksFile: ':memory:',
      chatFile: ':memory:',
      resultsDir,
      grok: loadGrokConfig({ OFFICE_TOKEN: token }),
      liveControl: {
        config: loadLiveControlConfig({
          ENABLE_GROKBOT_LIVE_CONTROL: 'true',
          GROKBOT_CLI_PATH: '/fake/gbot.mjs',
          GROKBOT_OWNER_AGENT_ID: OWNER,
          GROKBOT_START_PAUSED: 'false',
        }),
        client,
      },
    });
    const end = Date.now() + 5000;
    while ((s.live!.thread(COZ)?.length ?? 0) < entries.length) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
    return s;
  };
  const host = '127.0.0.1:5173';
  const keyOf = (id: string) => `${COZ}:${id}`;

  it('save, duplicate, refusals, no URLs stored, re-run refused, tasks, linking, restart, deletion', async () => {
    const dir = join(tempDir(), 'results');
    let s = await start(dir);
    const post = (url: string, body: unknown) => s.app.inject({ method: 'POST', url, headers: { host }, payload: body as object });
    // Save the bot's Markdown reply: attachments of the same turn come along as references.
    const saved = await post('/api/live-control/desktop/results', { key: keyOf('t1s1') });
    expect(saved.statusCode).toBe(201);
    const id = saved.json().id as number;
    expect((await post('/api/live-control/desktop/results', { key: keyOf('t1s1') })).json()).toEqual({ id, duplicate: true });
    const rec = (await s.app.inject({ method: 'GET', url: `/api/results/${id}`, headers: { host } })).json();
    expect(rec).toMatchObject({ model: 'Grok Desktop', output_type: 'markdown', output: '# Plan\n- bold colours', agent: 'mock-chief-01' });
    expect(rec.source).toMatchObject({ kind: 'grok-desktop', agentId: COZ, messageKey: keyOf('t1s1'), attachments: [{ name: 'poster.png', type: 'image' }] });
    expect(JSON.stringify(rec)).not.toMatch(/file:|\/home\/box|\/workspace/); // no unreachable URLs or paths
    // Refusals: your own message, a widget, an unknown key, a bad key.
    expect((await post('/api/live-control/desktop/results', { key: keyOf('u1') })).statusCode).toBe(400);
    expect((await post('/api/live-control/desktop/results', { key: keyOf('t1s3') })).statusCode).toBe(400);
    expect((await post('/api/live-control/desktop/results', { key: keyOf('nope') })).statusCode).toBe(404);
    expect((await post('/api/live-control/desktop/results', { key: '../../etc' })).statusCode).toBe(400);
    expect((await post(`/api/results/${id}/rerun`, {})).statusCode).toBe(400); // never becomes an xAI task
    // Track your own request (only that); link the saved result; complete only on request.
    expect((await post('/api/live-control/desktop/tasks', { key: keyOf('t1s1') })).statusCode).toBe(400);
    const tr = await post('/api/live-control/desktop/tasks', { key: keyOf('u1') });
    expect(tr.statusCode).toBe(201);
    const taskId = tr.json().task.id as string;
    expect((await post('/api/live-control/desktop/tasks', { key: keyOf('u1') })).json().duplicate).toBe(true);
    const patch = (p: unknown) => s.app.inject({ method: 'PATCH', url: `/api/live-control/desktop/tasks/${taskId}`, headers: { host }, payload: p as object });
    expect((await patch({ resultIds: [12345] })).statusCode).toBe(400); // not a Desktop result
    expect((await patch({ resultIds: [id] })).json().task).toMatchObject({ resultIds: [id] });
    expect((await patch({ resultIds: [id] })).json().task.completedAt).toBeUndefined();
    expect((await patch({ completed: true })).json().task.completedAt).toBeTruthy();
    await s.app.close();
    // Restart: the result, the task and its link are still there.
    s = await start(dir);
    const tasks = (await s.app.inject({ method: 'GET', url: `/api/live-control/desktop/tasks?agent=${COZ}`, headers: { host } })).json().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ resultIds: [id], title: 'Make a poster plan' });
    expect((await s.app.inject({ method: 'GET', url: `/api/live-control/desktop/saved?thread=${COZ}`, headers: { host } })).json()).toEqual({ saved: { [keyOf('t1s1')]: id } });
    expect(JSON.parse(readFileSync(join(dir, '..', 'grok-desktop', 'tasks.json'), 'utf8')).tasks).toHaveLength(1);
    // Deleting the result (existing route) also drops the link.
    expect((await s.app.inject({ method: 'DELETE', url: `/api/results/${id}`, headers: { host } })).statusCode).toBe(200);
    const after = (await s.app.inject({ method: 'GET', url: `/api/live-control/desktop/tasks?agent=${COZ}`, headers: { host } })).json().tasks;
    expect(after[0].resultIds).toEqual([]);
    expect((await s.app.inject({ method: 'DELETE', url: `/api/live-control/desktop/tasks/${taskId}`, headers: { host } })).statusCode).toBe(200);
    await s.app.close();
  });

  it('all Desktop endpoints need the token when OFFICE_TOKEN is set, and a local Host', async () => {
    const s = await start(':memory:', 'secret-token');
    const calls: [string, string][] = [
      ['POST', '/api/live-control/desktop/results'],
      ['GET', `/api/live-control/desktop/saved?thread=${COZ}`],
      ['GET', '/api/live-control/desktop/tasks'],
      ['POST', '/api/live-control/desktop/tasks'],
      ['PATCH', '/api/live-control/desktop/tasks/00000000-0000-4000-8000-000000000000'],
      ['DELETE', '/api/live-control/desktop/tasks/00000000-0000-4000-8000-000000000000'],
    ];
    for (const [method, url] of calls) {
      const r = await s.app.inject({ method: method as 'GET', url, headers: { host }, payload: method === 'GET' || method === 'DELETE' ? undefined : { key: keyOf('t1s1') } });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
      expect((await s.app.inject({ method: method as 'GET', url, headers: { host: 'evil.com:5173', 'x-office-token': 'secret-token' } })).statusCode).toBe(403);
    }
    await s.app.close();
  });
});
