import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadGrokConfig } from '../../backend/src/config';
import { buildServer } from '../../backend/src/index';

// /api/stream with OFFICE_TOKEN set needs a one-time ticket from POST /api/stream-ticket (token in a header only).
const TOKEN = 'stream-secret-123';
const host = '127.0.0.1:5173';

const opts = { dbPath: ':memory:', simulation: false, tasksFile: ':memory:', chatFile: ':memory:', resultsDir: ':memory:' };

/** Opens the stream over real HTTP and returns the status (and the first event name on 200). */
async function openStream(port: number, path: string) {
  const ctl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctl.signal });
  let first = '';
  if (r.status === 200) first = new TextDecoder().decode((await r.body!.getReader().read()).value).split('\n')[0];
  ctl.abort();
  return { status: r.status, first };
}

describe('stream tickets with OFFICE_TOKEN set', () => {
  let s: Awaited<ReturnType<typeof buildServer>>;
  let port: number;
  const ticket = async (headers: Record<string, string> = { 'x-office-token': TOKEN }, url = '/api/stream-ticket') =>
    s.app.inject({ method: 'POST', url, headers: { host, ...headers } });
  beforeAll(async () => {
    s = await buildServer({ ...opts, grok: loadGrokConfig({ OFFICE_TOKEN: TOKEN }) });
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    port = (s.app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await s.app.close();
  });

  it('a ticket needs the token in a header; a token in the URL is not accepted', async () => {
    expect((await ticket({})).statusCode).toBe(401);
    expect((await ticket({ 'x-office-token': 'wrong' })).statusCode).toBe(401);
    expect((await ticket({}, `/api/stream-ticket?token=${TOKEN}`)).statusCode).toBe(401);
    const r = await ticket();
    expect(r.statusCode).toBe(200);
    const t = r.json().ticket as string;
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(t).not.toContain(TOKEN);
  });

  it('no ticket, a wrong ticket, or a token in the URL → 401', async () => {
    for (const path of ['/api/stream', '/api/stream?ticket=nope', `/api/stream?token=${TOKEN}`])
      expect((await openStream(port, path)).status, path).toBe(401);
  });

  it('a valid ticket opens the stream once; reusing it → 401', async () => {
    const t = (await ticket()).json().ticket as string;
    expect(await openStream(port, `/api/stream?ticket=${t}`)).toEqual({ status: 200, first: 'event: snapshot' });
    expect((await openStream(port, `/api/stream?ticket=${t}`)).status).toBe(401);
  });

  it('an expired ticket (older than 30 s) → 401', async () => {
    const t = (await ticket()).json().ticket as string;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    expect((await openStream(port, `/api/stream?ticket=${t}`)).status).toBe(401);
    vi.restoreAllMocks();
  });
});

describe('without OFFICE_TOKEN (default) the stream is unchanged', () => {
  it('opens without a ticket; tickets are still issued', async () => {
    const s = await buildServer({ ...opts, grok: loadGrokConfig({}) });
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = s.app.server.address() as AddressInfo;
    expect(await openStream(port, '/api/stream')).toEqual({ status: 200, first: 'event: snapshot' });
    expect((await s.app.inject({ method: 'POST', url: '/api/stream-ticket', headers: { host } })).statusCode).toBe(200);
    await s.app.close();
  });
});
