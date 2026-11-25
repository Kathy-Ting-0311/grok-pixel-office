import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SEND_BLOCKED_REASON } from '../../shared/liveControl';
import type { CliClient, CliCommand } from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { buildServer } from '../../backend/src/index';
import { bots, COZ, groups, KRYSTAL, OWNER, sendMessage, thread } from '../fixtures/grokbot/fixtures';

// Phase 4 (read-only UI): start paused, the separate send flag, the send route refusal, and the SSE
// snapshot marker the UI uses to decide whether to show the tab. Fake CLI only; nothing is sent.

const base = {
  dbPath: ':memory:',
  simulation: false,
  tasksFile: ':memory:',
  chatFile: ':memory:',
  resultsDir: ':memory:',
};
const cfg = (over: Record<string, string> = {}) =>
  loadLiveControlConfig({
    ENABLE_GROKBOT_LIVE_CONTROL: 'true',
    GROKBOT_CLI_PATH: '/fake/gbot.mjs',
    GROKBOT_OWNER_AGENT_ID: OWNER,
    ...over,
  });

const fakeClient = () => {
  const calls: CliCommand['cmd'][] = [];
  let sends = 0;
  const client: CliClient = {
    verify: async () => ({ path: '/fake', repo: '/fake', commit: '9616503', version: 'gbot 0.12.5' }),
    json: async (c) => {
      calls.push(c.cmd);
      if (c.cmd === 'bots') return bots;
      if (c.cmd === 'groups') return groups;
      if (c.cmd === 'thread') return thread(c.id, [sendMessage(c.id, 1, 'hello from the bot')]);
      throw new Error('unexpected');
    },
    send: async () => {
      sends++;
      throw new Error('the CLI must not be called');
    },
  };
  return { client, calls, sends: () => sends };
};

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Reads the first SSE `snapshot` event from a real listening server. */
async function snapshotOf(s: Awaited<ReturnType<typeof buildServer>>) {
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = s.app.server.address() as AddressInfo;
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctl.signal });
  const reader = res.body!.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  const line = text.split('\n').find((l) => l.startsWith('data: '))!;
  return JSON.parse(line.slice(6)) as Record<string, unknown>;
}

describe('Phase 4 config', () => {
  it('starts paused and keeps sending off by default', () => {
    const c = loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: 'true' });
    expect(c.startPaused).toBe(true);
    expect(c.sendEnabled).toBe(false);
    for (const v of ['', 'false', '1', 'yes'])
      expect(loadLiveControlConfig({ GROKBOT_LIVE_SEND_ENABLED: v }).sendEnabled, v).toBe(false);
    expect(loadLiveControlConfig({ GROKBOT_LIVE_SEND_ENABLED: 'true' }).sendEnabled).toBe(true);
  });
});

describe('Phase 4 server', () => {
  it('every start begins paused: verify only, no discovery until resumed', async () => {
    const f = fakeClient();
    const s = await buildServer({ ...base, liveControl: { config: cfg(), client: f.client } });
    await until(() => s.live!.status().state === 'paused');
    await new Promise((r) => setTimeout(r, 300));
    expect(f.calls).toEqual([]);
    const r = (await s.app.inject({ method: 'POST', url: '/api/live-control/resume' })).json();
    expect(r.paused).toBe(false);
    await until(() => f.calls.includes('bots'));
    await s.app.inject({ method: 'POST', url: '/api/live-control/pause' });
    expect(s.live!.status()).toMatchObject({ paused: true, state: 'paused' });
    await s.app.close();
  });

  it('send flag off: POST /send is refused (403) before the CLI is called', async () => {
    const f = fakeClient();
    const s = await buildServer({ ...base, liveControl: { config: cfg(), client: f.client } });
    await until(() => s.live!.status().state === 'paused');
    const st = (await s.app.inject({ url: '/api/live-control/status' })).json();
    expect(st.send).toEqual({ enabled: false, reason: SEND_BLOCKED_REASON });
    for (const payload of [
      { id: KRYSTAL, text: 'hi', confirm: true },
      { id: COZ, text: 'Live Control test from Pixel Office - please reply OK', confirm: true },
      {},
    ]) {
      const r = await s.app.inject({ method: 'POST', url: '/api/live-control/send', payload });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ ok: false, delivery: 'refused', error: SEND_BLOCKED_REASON });
    }
    // The adapter path refuses too, without the CLI.
    expect(await s.live!.send(KRYSTAL, 'hi')).toMatchObject({ ok: false, delivery: 'refused' });
    expect(f.sends()).toBe(0);
    await s.app.close();
  });

  it('send flag on still needs confirm: true and a discovered 1:1 bot (fake CLI, nothing sent)', async () => {
    const f = fakeClient();
    const s = await buildServer({
      ...base,
      liveControl: {
        config: cfg({ GROKBOT_LIVE_SEND_ENABLED: 'true', GROKBOT_START_PAUSED: 'false' }),
        client: f.client,
      },
    });
    await until(() => s.live!.status().agents.length > 0);
    const post = (payload: Record<string, unknown>) =>
      s.app.inject({ method: 'POST', url: '/api/live-control/send', payload });
    expect((await post({ id: KRYSTAL, text: 'hi' })).statusCode).toBe(400);
    for (const id of [OWNER, '99999999-9999-4999-8999-999999999999', 'not-an-id'])
      expect((await post({ id, text: 'hi', confirm: true })).statusCode, id).toBe(400);
    expect(f.sends()).toBe(0);
    await s.app.close();
  });

  it('SSE snapshot marks Live Control only when the flag is on', async () => {
    const off = await buildServer({
      ...base,
      liveControl: { config: loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: 'false' }) },
    });
    const a = await snapshotOf(off);
    expect(Object.keys(a).sort()).toEqual(['events', 'sources']);
    await off.app.close();

    const f = fakeClient();
    const on = await buildServer({ ...base, liveControl: { config: cfg(), client: f.client } });
    const b = await snapshotOf(on);
    expect(b.liveControl).toBe(true);
    await on.app.close();
  });
});
