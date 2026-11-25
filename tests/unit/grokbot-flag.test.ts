import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliClient } from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { bots, groups, OWNER, thread } from '../fixtures/grokbot/fixtures';

// Spies: every adapter construction and every child process the server could start.
const spy = vi.hoisted(() => ({ constructed: 0, execFile: 0, spawn: 0 }));
vi.mock('node:child_process', async (orig) => {
  const m = await orig<typeof import('node:child_process')>();
  return {
    ...m,
    execFile: (...a: Parameters<typeof m.execFile>) => (spy.execFile++, m.execFile(...a)),
    spawn: (...a: Parameters<typeof m.spawn>) => (spy.spawn++, m.spawn(...a)),
  };
});
vi.mock('../../backend/src/grokbot/adapter', async (orig) => {
  const m = await orig<typeof import('../../backend/src/grokbot/adapter')>();
  class Counted extends m.GrokBotGatewayAdapter {
    constructor(...a: ConstructorParameters<typeof m.GrokBotGatewayAdapter>) {
      super(...a);
      spy.constructed++;
    }
  }
  return { ...m, GrokBotGatewayAdapter: Counted };
});

const { buildServer } = await import('../../backend/src/index');
const base = {
  dbPath: ':memory:',
  simulation: false,
  tasksFile: ':memory:',
  chatFile: ':memory:',
  resultsDir: ':memory:',
};

afterEach(() => {
  spy.constructed = 0;
  spy.execFile = 0;
  spy.spawn = 0;
  vi.useRealTimers();
});

describe('ENABLE_GROKBOT_LIVE_CONTROL', () => {
  it('is off unless exactly "true"', () => {
    expect(loadLiveControlConfig({}).enabled).toBe(false);
    for (const v of ['', 'false', '0', '1', 'yes', 'on', 'enabled'])
      expect(loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: v }).enabled, v).toBe(false);
    expect(loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: 'true' }).enabled).toBe(true);
    expect(loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: ' TRUE ' }).enabled).toBe(true);
  });

  it('off: adapter never constructed, no process spawned, no timers, no routes', async () => {
    vi.useFakeTimers();
    const config = loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: 'false' });
    const { app, live } = await buildServer({ ...base, liveControl: { config } });
    // Timers the server makes without Live Control (results prune etc.) are the baseline.
    const timers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(live).toBeUndefined();
    expect(spy.constructed).toBe(0);
    expect(spy.execFile).toBe(0);
    expect(spy.spawn).toBe(0);
    expect(vi.getTimerCount()).toBe(timers);
    for (const url of ['/api/live-control/status', '/api/live-control/thread/x'])
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/live-control/reconnect' })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('off by default from the environment the tests run with', async () => {
    const { app, live } = await buildServer(base);
    expect(live).toBeUndefined();
    expect(spy.constructed).toBe(0);
    expect((await app.inject({ url: '/api/live-control/status' })).statusCode).toBe(404);
    await app.close();
  });

  it('on (control case): the same spies do see construction and polling', async () => {
    const config = loadLiveControlConfig({
      ENABLE_GROKBOT_LIVE_CONTROL: 'true',
      GROKBOT_CLI_PATH: '/fake/gbot.mjs',
      GROKBOT_OWNER_AGENT_ID: OWNER,
      GROKBOT_START_PAUSED: 'false',
    });
    const calls: string[] = [];
    const client: CliClient = {
      verify: async () => ({
        path: '/fake',
        repo: '/fake',
        commit: '9616503',
        version: 'gbot 0.12.5',
      }),
      json: async (c) => {
        calls.push(c.cmd);
        return c.cmd === 'bots' ? bots : c.cmd === 'groups' ? groups : thread('x', []);
      },
      send: async () => {
        throw new Error('never sends');
      },
    };
    const { app, live } = await buildServer({ ...base, liveControl: { config, client } });
    expect(spy.constructed).toBe(1);
    await vi.waitFor(() => expect(calls).toEqual(['bots', 'groups']));
    const st = (await app.inject({ url: '/api/live-control/status' })).json();
    expect(st).toMatchObject({ enabled: true, state: 'ok', cli: { commit: '9616503' } });
    // Status carries no configuration secrets or paths.
    expect(JSON.stringify(st)).not.toMatch(/fake\/gbot|GROKBOT|XAI/);
    await app.close();
    expect(live!.status().state).toBe('stopped');
    // A fake client never starts a process.
    expect(spy.execFile).toBe(0);
  });
});
