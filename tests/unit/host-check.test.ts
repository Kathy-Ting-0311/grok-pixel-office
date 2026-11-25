import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import { buildServer } from '../../backend/src/index';
import { isLocalHost } from '../../backend/src/hostCheck';

// DNS-rebinding guard on /api/stream and /api/live-control/*. Live Control stays off here (vitest.config pins it),
// so /api/live-control/* is 404 once the Host check passes and 403 when it does not.

const rejected = [
  'evil.com:5173',
  '127.0.0.1.evil.com:5173',
  'LOCALHOST.evil.com:5173',
  '127.0.0.1:5173.evil.com',
  '[::1]:5173',
  '127.0.0.1',
  'localhost',
  '',
];

describe('isLocalHost', () => {
  it('accepts 127.0.0.1:<digits> and localhost:<digits> (case-insensitive)', () => {
    for (const h of ['127.0.0.1:5173', '127.0.0.1:4319', 'localhost:5173', 'LocalHost:80', 'LOCALHOST:4319'])
      expect(isLocalHost(h), h).toBe(true);
  });
  it('rejects everything else', () => {
    for (const h of [...rejected, undefined]) expect(isLocalHost(h), String(h)).toBe(false);
  });
});

describe('Host check on the server', () => {
  let s: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    s = await buildServer({ dbPath: ':memory:', simulation: false, tasksFile: ':memory:', chatFile: ':memory:', resultsDir: ':memory:' });
  });
  afterAll(async () => {
    await s.app.close();
  });

  it('a fake Host gets 403 on /api/stream and /api/live-control/*', async () => {
    // inject() replaces an empty Host with localhost:80, so '' is sent over a raw socket below.
    for (const host of rejected.filter(Boolean))
      for (const url of ['/api/stream', '/api/live-control/status']) {
        const r = await s.app.inject({ method: 'GET', url, headers: { host } });
        expect(r.statusCode, `${host} ${url}`).toBe(403);
        expect(r.json()).toEqual({ error: 'Forbidden host.' });
      }
  });

  it('an empty Host header over real HTTP gets 403 on /api/stream', async () => {
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = s.app.server.address() as AddressInfo;
    const head = await new Promise<string>((resolve, reject) => {
      const c = connect(port, '127.0.0.1', () => c.write('GET /api/stream HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n'));
      let d = '';
      c.on('data', (b) => (d += b)).on('end', () => resolve(d)).on('error', reject);
    });
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
  });

  it('local Hosts pass the check; other routes are not affected', async () => {
    for (const host of ['127.0.0.1:5173', 'localhost:5173', 'LOCALHOST:5173'])
      expect((await s.app.inject({ method: 'GET', url: '/api/live-control/status', headers: { host } })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.com:5173' } })).statusCode).not.toBe(403);
  });
});
