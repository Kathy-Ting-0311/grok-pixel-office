import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { buildServer } from '../../backend/src/index';
import { COZ } from '../fixtures/grokbot/fixtures';
import { makeStubCli, STUB_TEXT } from '../fixtures/grokbot/stubCli';

// Phase 5: gateway-down cases against a REAL child process (a stub CLI in a temp folder outside the
// repo; never the real CLI). Each case checks that Live Control turns itself off with a clear status,
// the server keeps answering, and monitoring (the local cache reader) and replay keep working.
// No simulated meeting or demo data is used here.

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

const base = {
  dbPath: ':memory:',
  simulation: false,
  tasksFile: ':memory:',
  chatFile: ':memory:',
  resultsDir: ':memory:',
};
const stub = (...a: Parameters<typeof makeStubCli>) => {
  const s = makeStubCli(...a);
  cleanups.push(s.cleanup);
  return s;
};
const server = async (env: Record<string, string>) => {
  const s = await buildServer({ ...base, liveControl: { config: loadLiveControlConfig(env) } });
  cleanups.push(() => void s.app.close());
  return s;
};
const until = async (ok: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Monitoring (local cache reader) and replay still work; nothing simulated is involved. */
async function monitoringStillWorks(s: Awaited<ReturnType<typeof buildServer>>) {
  expect((await s.app.inject({ url: '/api/health' })).json().ok).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'gbot-p5-cache-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'events.jsonl'),
    JSON.stringify({
      id: 'p5-1',
      botId: 'mock-chief-01',
      timestamp: new Date().toISOString(),
      type: 'task_started',
      taskId: 'p5',
      source: 'real',
      payload: { title: 'monitoring check' },
    }) + '\n',
  );
  const r = await s.app.inject({ method: 'POST', url: '/api/sources/local', payload: { dir, authorize: true } });
  expect(r.statusCode).toBe(200);
  expect(r.json().localCache).toMatchObject({ state: 'watching', accepted: 1 });
  expect((await s.app.inject({ url: '/api/sessions' })).statusCode).toBe(200);
  expect((await s.app.inject({ url: '/api/events?limit=5' })).json().events.length).toBeGreaterThan(0);
  await s.app.inject({ method: 'POST', url: '/api/sources/local', payload: { dir: '' } }).catch(() => {});
}

/** No stub process may be left behind (a hung CLI is killed). */
const stubProcesses = (root: string) => {
  try {
    return execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(root)).length;
  } catch {
    return 0;
  }
};

describe('stub CLI (real child process)', () => {
  it('works: verify, discovery and a real transcript read through execFile', async () => {
    const st = stub();
    const s = await server(st.env({ GROKBOT_START_PAUSED: 'false' }));
    await until(() => (s.live!.thread(COZ)?.length ?? 0) > 0);
    expect(s.live!.status()).toMatchObject({ state: 'ok', cli: { commit: '9616503' } });
    expect(s.live!.thread(COZ)!.map((m) => m.text)).toContain(STUB_TEXT);
    // Only allowlisted read commands reached the process; never send.
    const cmds = st.calls().map((a) => a[0]);
    expect(new Set(cmds)).toEqual(new Set(['--version', 'bots', 'groups', 'thread']));
    expect(cmds).not.toContain('send');
  });

  it('a path that does not exist: unavailable, nothing spawned, office keeps working', async () => {
    const st = stub();
    const s = await server(st.env({ GROKBOT_CLI_PATH: join(st.root, 'missing', 'gbot.mjs') }));
    await until(() => s.live!.status().state === 'unavailable');
    expect(s.live!.status().reason).toMatch(/not found at GROKBOT_CLI_PATH.*Monitoring, simulation and replay keep working/);
    expect(st.calls()).toEqual([]);
    await monitoringStillWorks(s);
  });

  it('a CLI that exits with an error: turns itself off after the failure limit', async () => {
    const st = stub({ mode: 'fail' });
    const s = await server(st.env({ GROKBOT_START_PAUSED: 'false', GROKBOT_MAX_FAILURES: '2' }));
    await until(() => s.live!.status().state === 'off-error', 20000);
    const status = s.live!.status();
    expect(status.reason).toMatch(/turned itself off after 2 failures/);
    expect(status.reason).toMatch(/Reconnect/);
    expect(JSON.stringify(status)).not.toMatch(/gbot-stub-/); // no local paths in the status
    await monitoringStillWorks(s);
  }, 30000);

  it('a CLI that hangs: killed at the timeout, turns itself off, no process left behind', async () => {
    const st = stub({ mode: 'hang' });
    const s = await server(
      st.env({ GROKBOT_START_PAUSED: 'false', GROKBOT_MAX_FAILURES: '1', GROKBOT_CLI_TIMEOUT_MS: '2000' }),
    );
    await until(() => s.live!.status().state === 'off-error', 20000);
    expect(s.live!.status().counters.timeouts).toBeGreaterThanOrEqual(1);
    expect(s.live!.status().lastError).toMatch(/did not answer in time/);
    await until(() => stubProcesses(st.root) === 0, 5000);
    await monitoringStillWorks(s);
  }, 30000);

  it('works at first, then fails mid-session: keeps what it read, turns itself off', async () => {
    // --version, bots, groups and the first thread reads succeed; every later call fails.
    const st = stub({ mode: 'ok-then-fail', okCalls: 5 });
    const s = await server(
      st.env({ GROKBOT_START_PAUSED: 'false', GROKBOT_MAX_FAILURES: '2', GROKBOT_POLL_IDLE_MS: '5000' }),
    );
    await until(() => s.live!.status().lastSuccessAt !== undefined && s.live!.status().agents.length > 0);
    await until(() => s.live!.status().state === 'off-error', 40000);
    const status = s.live!.status();
    expect(status.agents.length).toBeGreaterThan(0);
    expect(status.reason).toMatch(/turned itself off/);
    // Reconnect is the only way back; with the stub still failing it stays off and says why.
    await s.app.inject({ method: 'POST', url: '/api/live-control/reconnect', payload: {} });
    await until(() => ['off-error', 'unavailable'].includes(s.live!.status().state), 20000);
    await monitoringStillWorks(s);
  }, 60000);
});
