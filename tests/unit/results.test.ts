import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadGrokConfig } from '../../backend/src/config';
import type { AgentOutput, AgentResult } from '../../backend/src/grok';
import { buildServer } from '../../backend/src/index';
import { cleanSvg, crc32, ResultStore, safeName } from '../../backend/src/results';
import type { PlacedTask } from '../../backend/src/tasks';
import type { BotEvent } from '../../shared/types';
import { Markdown } from '../../frontend/src/ui/Markdown';

const mock = loadGrokConfig({});
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'office-results-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const task = (id: number, p: Partial<PlacedTask> = {}): PlacedTask => ({
  id,
  title: `Task ${id}`,
  details: '',
  agent: 'mock-execution-04',
  requestedAgent: 'mock-execution-04',
  priority: 'normal',
  maxCostUsd: 1,
  status: 'done',
  attempt: 1,
  mock: true,
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  summary: 'ok',
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0,
  ...p,
});
const out = (p: Partial<AgentOutput> = {}): AgentOutput => ({
  type: 'markdown',
  text: '# Hi',
  files: [],
  ...p,
});
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('result store', () => {
  it('saves records, index and files atomically and reloads them after a restart', () => {
    const dir = tmp();
    const a = new ResultStore(dir);
    a.save(
      task(1),
      mock,
      out({
        type: 'image',
        text: 'a prompt',
        svg: '<svg><script>x()</script><rect onclick="x()"/></svg>',
      }),
    );
    a.save(task(2, { status: 'failed', error: 'boom', summary: undefined }), mock, undefined);
    expect(readdirSync(dir).sort()).toEqual(['1.json', '2.json', 'files', 'index.json']);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    const svg = readFileSync(join(dir, 'files/1/drawing.svg'), 'utf8');
    expect(svg).not.toMatch(/script|onclick/);
    const b = new ResultStore(dir);
    expect(b.list().results.map((r) => [r.id, r.status, r.type])).toEqual([
      [2, 'failed', 'text'],
      [1, 'done', 'image'],
    ]);
    expect(b.get(2)).toMatchObject({ status: 'failed', error: 'boom', output: 'boom' });
    expect(b.file(1, 'drawing.svg')?.length).toBeGreaterThan(0);
    expect(b.file(1, '../2.json')).toBeUndefined();
  });

  it('retention keeps the newest results and never deletes pinned ones', () => {
    const s = new ResultStore(':memory:', 10);
    for (let i = 1; i <= 12; i++) {
      s.save(task(i), mock, out());
      if (i === 1) s.patch(1, { pinned: true });
    }
    const ids = s.list().results.map((r) => r.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    expect(ids.filter((i) => i !== 1)).toHaveLength(10);
    s.setKeep(10);
    s.patch(1, { pinned: false });
    expect(s.delete(1)).toBe(true);
    expect(s.get(1)).toBeUndefined();
  });

  it('limits file size and count, and cleans file names', () => {
    const s = new ResultStore(':memory:');
    const big = 'x'.repeat(250_000);
    const files = [
      { name: '../../etc/passwd', content: 'a' },
      { name: 'big.txt', content: big },
      { name: 'run.exe', content: 'b' },
      ...Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.md`, content: 'c' })),
    ];
    const rec = s.save(task(1), mock, out({ files }));
    expect(rec.files.map((f) => f.name)).toEqual([
      'passwd.txt',
      'run.exe.txt',
      'f0.md',
      'f1.md',
      'f2.md',
    ]);
    expect(safeName('a b/c?.SVG')).toBe('c_.SVG');
    expect(cleanSvg('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('exports all results as markdown and as a valid zip', () => {
    const s = new ResultStore(':memory:');
    s.save(
      task(1, { title: 'Code it' }),
      mock,
      out({ type: 'code', text: 'print(1)', language: 'python' }),
    );
    expect(s.exportMarkdown()).toContain('```python\nprint(1)\n```');
    const z = s.exportZip();
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(z.readUInt32LE(end)).toBe(0x06054b50);
    expect(z.readUInt16LE(end + 10)).toBe(3); // results.md, index.json, 1.json
    const md = Buffer.from(s.exportMarkdown().split('Exported')[0]);
    expect(crc32(md)).toBe(crc32(Buffer.from(md))); // deterministic
  });
});

describe('results through the server (MOCK_MODE)', () => {
  it('/task from chat runs, saves a record and tags task_completed with result_id; history survives a restart', async () => {
    const dir = tmp();
    const files = {
      tasksFile: join(dir, 'tasks.json'),
      chatFile: join(dir, 'chats.json'),
      resultsDir: join(dir, 'results'),
    };
    process.env.MOCK_DELAY_MS = '5';
    const a = await buildServer({ dbPath: ':memory:', simulation: false, grok: mock, ...files });
    const events: BotEvent[] = [];
    a.providers.subscribe((e) => events.push(e));
    for (const text of [
      '/task Make a picture of the office',
      '/task Write a code script',
      '/task Weekly notes\nThree bullets',
    ])
      expect(
        (
          await a.app.inject({
            method: 'POST',
            url: '/api/chat/mock-visual-05/task',
            payload: { text },
          })
        ).statusCode,
      ).toBe(200);
    await until(() => events.filter((e) => e.type === 'task_completed').length === 3);
    const done = events.filter((e) => e.type === 'task_completed');
    expect(done.map((e) => e.payload.output_type).sort()).toEqual(['code', 'image', 'markdown']);
    expect(done.every((e) => typeof e.payload.result_id === 'number')).toBe(true);
    const third = (await a.app.inject({ url: '/api/results/3' })).json();
    expect(third).toMatchObject({
      title: 'Weekly notes',
      details: 'Three bullets',
      agent: 'mock-visual-05',
      status: 'done',
    });
    const chat = (await a.app.inject({ url: '/api/chat/mock-visual-05' })).json().messages;
    expect(
      chat.filter((m: { taskId?: number }) => m.taskId).map((m: { taskId: number }) => m.taskId),
    ).toEqual([1, 2, 3]);
    await a.app.close();

    const b = await buildServer({ dbPath: ':memory:', simulation: false, grok: mock, ...files });
    const list = (await b.app.inject({ url: '/api/results' })).json();
    expect(list.results.map((r: { id: number }) => r.id)).toEqual([3, 2, 1]);
    // file served safely
    const svg = await b.app.inject({ url: '/api/results/1/files/drawing.svg' });
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(String(svg.headers['content-security-policy'])).toContain('sandbox');
    expect((await b.app.inject({ url: '/api/results/1/files/..%2F1.json' })).statusCode).toBe(404);
    const dl = await b.app.inject({ url: '/api/results/2/download' });
    expect(dl.headers['content-disposition']).toContain('result-2.py');
    // re-run, pin, delete, retention setting
    const rerun = (await b.app.inject({ method: 'POST', url: '/api/results/3/rerun' })).json();
    expect(rerun).toMatchObject({
      id: 4,
      title: 'Weekly notes',
      details: 'Three bullets',
      agent: 'mock-visual-05',
    });
    expect(
      (
        await b.app.inject({ method: 'PATCH', url: '/api/results/1', payload: { pinned: true } })
      ).json().pinned,
    ).toBe(true);
    expect((await b.app.inject({ method: 'DELETE', url: '/api/results/2' })).statusCode).toBe(200);
    expect((await b.app.inject({ url: '/api/results/2' })).statusCode).toBe(404);
    expect(
      (await b.app.inject({ method: 'PUT', url: '/api/results/settings', payload: { keep: 3 } }))
        .statusCode,
    ).toBe(400);
    const zip = await b.app.inject({ url: '/api/results/export.zip' });
    expect(zip.headers['content-type']).toBe('application/zip');
    await b.app.close();
  });

  it('a failed task saves a record with its error', async () => {
    const s = await buildServer({
      dbPath: ':memory:',
      simulation: false,
      tasksFile: ':memory:',
      resultsDir: ':memory:',
      chatFile: ':memory:',
      grok: mock,
      runAgent: async () => ({
        ok: false,
        reason: 'api_error',
        error: 'xAI API 500',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: 'm',
      }),
    });
    await s.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Will fail', agent: 'mock-review-06' },
    });
    let rec: { status: string; error: string } | undefined;
    await until(() => {
      void s.app
        .inject({ url: '/api/results/1' })
        .then((r) => (rec = r.statusCode === 200 ? r.json() : undefined));
      return !!rec;
    });
    expect(rec).toMatchObject({ status: 'failed', error: 'xAI API 500' });
    await s.app.close();
  });

  it('real image generation is opt-in, charged to the budget, and saved as a file', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/images/generations'))
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
          status: 200,
        });
      throw new Error('unexpected');
    }) as typeof fetch;
    const live = loadGrokConfig({ XAI_API_KEY: 'xai-test', MOCK_MODE: 'false', IMAGE_API: 'true' });
    const runAgent = async (): Promise<AgentResult> => ({
      ok: true,
      summary: 'drew it',
      output: out({ type: 'image', text: 'a cat at a desk' }),
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.0003,
      model: 'grok-4.3',
    });
    const s = await buildServer({
      dbPath: ':memory:',
      simulation: false,
      tasksFile: ':memory:',
      resultsDir: ':memory:',
      chatFile: ':memory:',
      grok: live,
      runAgent,
      fetchImpl,
    });
    await s.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Picture', agent: 'mock-visual-05' },
    });
    let rec: { files: { name: string }[]; cost_usd: number } | undefined;
    await until(() => {
      void s.app
        .inject({ url: '/api/results/1' })
        .then((r) => (rec = r.statusCode === 200 ? r.json() : undefined));
      return !!rec;
    });
    expect(calls).toEqual(['https://api.x.ai/v1/images/generations']);
    expect(rec!.files.map((f) => f.name)).toEqual(['image.png']);
    expect(rec!.cost_usd).toBeCloseTo(0.0403, 4);
    expect((await s.app.inject({ url: '/api/tasks' })).json().budget.spentUsd).toBeCloseTo(0.04, 4);
    await s.app.close();
    // Without IMAGE_API the endpoint is never called.
    calls.length = 0;
    const off = await buildServer({
      dbPath: ':memory:',
      simulation: false,
      tasksFile: ':memory:',
      resultsDir: ':memory:',
      chatFile: ':memory:',
      grok: { ...live, imageApi: false },
      runAgent,
      fetchImpl,
    });
    await off.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Picture', agent: 'mock-visual-05' },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toEqual([]);
    await off.app.close();
  });
});

describe('markdown rendering is sanitized', () => {
  it('never turns model text into HTML or javascript: links', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text: '# Title\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1)) [ok](https://x.ai)\n\n```html\n<b>hi</b>\n```',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://x.ai"');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });
});
