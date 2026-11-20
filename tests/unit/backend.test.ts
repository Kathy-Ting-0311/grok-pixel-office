import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { LocalCacheProvider, refusedDirectory } from '../../backend/src/localCache';
import { buildServer } from '../../backend/src/index';
import type { BotEvent } from '../../shared/types';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const line = (o: Record<string, unknown>) => JSON.stringify({ botId: 'mock-chief-01', timestamp: '2026-11-20T01:00:00Z', type: 'task_started', taskId: 't1', ...o }) + '\n';

describe('local cache provider', () => {
  it('reads incrementally, classifies sources, dedupes, survives rotation', async () => {
    const dir = temp();
    const got: BotEvent[] = [];
    const seen = new Set<string>();
    const p = new LocalCacheProvider(new Set(['mock-chief-01']), (e) => (seen.has(e.id) ? false : (seen.add(e.id), got.push(e), true)), 60000);
    writeFileSync(join(dir, 'events.jsonl'), line({ id: 'a', source: 'real' }) + line({ id: 'b' }) + 'not json\n' + line({ id: 'c', botId: 'someone-else' }));
    writeFileSync(join(dir, 'api-token.jsonl'), line({ id: 'secret', source: 'real' }));
    writeFileSync(join(dir, 'notes.txt'), line({ id: 'txt' }));
    await p.start(dir, new Date().toISOString());
    expect(got.map((e) => [e.id, e.source])).toEqual([
      ['local:a', 'real'],
      ['local:b', 'unknown'],
    ]);
    expect(p.status).toMatchObject({ rejected: 1, unmatchedBots: 1, files: 1 });
    // Partial line is held until completed.
    appendFileSync(join(dir, 'events.jsonl'), line({ id: 'd', source: 'simulated' }).slice(0, 20));
    await p.scan();
    expect(got).toHaveLength(2);
    appendFileSync(join(dir, 'events.jsonl'), line({ id: 'd', source: 'simulated' }).slice(20));
    await p.scan();
    expect(got.at(-1)).toMatchObject({ id: 'local:d', source: 'simulated' });
    // Rotation: file replaced with a new inode containing old + new lines → only new ones emitted.
    renameSync(join(dir, 'events.jsonl'), join(dir, 'events.old'));
    writeFileSync(join(dir, 'events.jsonl'), line({ id: 'a', source: 'real' }) + line({ id: 'e', source: 'real', type: 'task_completed' }));
    await p.scan();
    expect(got.map((e) => e.id)).toEqual(['local:a', 'local:b', 'local:d', 'local:e']);
    expect(p.status.duplicates).toBe(1);
    p.stop();
  });

  it('refuses credential stores and broad folders', async () => {
    expect(refusedDirectory(join(homedir(), '.grokbot'))).toBeDefined();
    expect(refusedDirectory(join(homedir(), '.ssh', 'x'))).toBeDefined();
    expect(refusedDirectory(homedir())).toBeDefined();
    expect(refusedDirectory(temp())).toBeUndefined();
    const p = new LocalCacheProvider(new Set(), () => true);
    await expect(p.start('relative/path', '')).rejects.toThrow();
    await expect(p.start(join(temp(), 'missing'), '')).rejects.toThrow();
  });
});

describe('API', () => {
  it('requires explicit authorisation, persists state and streams', async () => {
    const { app } = await buildServer({ dbPath: ':memory:', simulation: false });
    const dir = temp();
    expect((await app.inject({ method: 'POST', url: '/api/sources/local', payload: { dir } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/sources/local', payload: { dir, authorize: true } });
    expect(ok.json().localCache.state).toBe('watching');
    expect((await app.inject({ method: 'POST', url: '/api/sources/local', payload: { dir: join(homedir(), '.grokbot'), authorize: true } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/state/layout', payload: { value: { a: 1 } } });
    expect((await app.inject({ url: '/api/state/layout' })).json().value).toEqual({ a: 1 });
    expect((await app.inject({ method: 'PUT', url: '/api/state/source:local', payload: { value: 1 } })).statusCode).toBe(400);
    const sources = (await app.inject({ url: '/api/sources' })).json();
    expect(sources.officialApi.available).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/simulate/meeting', payload: {} })).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: '/api/sources/simulation', payload: { enabled: true } });
    expect((await app.inject({ method: 'POST', url: '/api/simulate/meeting', payload: {} })).statusCode).toBe(200);
    const evs = (await app.inject({ url: '/api/events' })).json().events as BotEvent[];
    expect(evs.some((e) => e.type === 'meeting_started' && e.source === 'simulated')).toBe(true);
    await app.close();
  });
});
