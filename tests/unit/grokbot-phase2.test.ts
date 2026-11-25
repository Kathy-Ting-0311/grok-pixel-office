import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../backend/src/index';
import { officeEligible } from '../../backend/src/grokbot/bridge';
import { createCliClient, type CliClient, type ExecFn } from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { mapAgents, parseAgentMap } from '../../backend/src/grokbot/mapping';
import { entrySchema } from '../../backend/src/grokbot/schemas';
import { toLiveMessage } from '../../backend/src/grokbot/transcript';
import { roster } from '../../shared/roster';
import type { BotEvent } from '../../shared/types';
import type { LiveAgent } from '../../shared/liveControl';
import real from '../fixtures/grokbot/real-samples.json';
import { COZ, GROUP, KRYSTAL, OWNER, thread } from '../fixtures/grokbot/fixtures';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'gbot-p2-'));
  dirs.push(d);
  return d;
};

type Sample = { name: string; thread: string; isGroup: boolean; entry: Record<string, unknown> };
const samples = real.samples as Sample[];
const sample = (name: string) => {
  const s = samples.find((x) => x.name === name);
  if (!s) throw new Error(`no sample ${name}`);
  return s;
};
const live = (name: string) => {
  const s = sample(name);
  const e = entrySchema.parse(s.entry);
  return toLiveMessage(e, e.id ?? `seq${e.seq}`, {
    threadId: s.thread,
    isGroup: s.isGroup,
    ownerId: OWNER,
  });
};

describe('real transcript samples (sanitised)', () => {
  it('my user message is mine', () => {
    const m = live('1:1 owner user message');
    expect(m).toMatchObject({
      attribution: 'owner',
      basis: 'role:user',
      raw: { kind: 'message', role: 'user' },
    });
    expect(m.placeholder).toBeUndefined();
    expect(officeEligible(m)).toBe(false);
  });

  it('a 1:1 bot reply with no author is the thread bot (thread-target)', () => {
    const m = live('1:1 bot reply, send-message, no author');
    expect(m).toMatchObject({
      attribution: 'thread-target',
      senderId: COZ,
      basis: '1:1 send-message, no author',
      raw: { kind: 'send-message', messageType: 'text' },
    });
    expect(m.raw.authorId).toBeUndefined();
    expect(m.raw.role).toBeUndefined();
    expect(officeEligible(m)).toBe(true);
  });

  it('a message with an author is verified by author.id', () => {
    const m = live('group bot message with author');
    expect(m.attribution).toBe('verified');
    expect(m.senderId).toBe(m.raw.authorId);
    expect(m.raw.authorName).toBe('[redacted]');
    expect(officeEligible(m)).toBe(true);
    expect(live('group owner user message').attribution).toBe('owner');
  });

  it('kinds and roles outside the rules are unknown and stay out of the office', () => {
    for (const name of [
      '1:1 message role assistant (no rule matches)',
      'unknown kind: feedback',
      'unknown kind: event',
    ]) {
      const m = live(name);
      expect(m.attribution, name).toBe('unknown');
      expect(officeEligible(m), name).toBe(false);
    }
    expect(live('unknown kind: feedback')).toMatchObject({
      text: '[feedback]',
      placeholder: { type: 'feedback' },
    });
  });

  it('forms, widgets and other non-text entries become placeholders, never bubbles', () => {
    const form = live('1:1 user-form');
    expect(form).toMatchObject({
      text: '[form: Sample form title]',
      placeholder: { type: 'user-form' },
      raw: { messageType: 'user-form' },
    });
    expect(live('1:1 widget')).toMatchObject({ text: '[widget]', placeholder: { type: 'widget' } });
    expect(live('1:1 local-tool-permission').text).toBe('[local-tool-permission]');
    const att = live('group attachment with author');
    expect(att).toMatchObject({ attribution: 'verified', text: '[attachment]' });
    for (const m of [form, live('1:1 widget'), att]) expect(officeEligible(m)).toBe(false);
  });

  it("the owner's own thread is always the owner", () => {
    expect(live("owner's own thread send-message").attribution).toBe('owner');
  });
});

const agent = (id: string, name: string, owner = false): LiveAgent => ({ id, name, owner });

describe('mapping real agents to existing characters', () => {
  it('maps by base name, never the owner, lists the rest as unmapped', () => {
    const m = mapAgents(
      [
        agent(COZ, 'Coz · Chief'),
        agent(KRYSTAL, 'Krystal · Research'),
        agent('33333333-3333-4333-8333-333333333333', 'Social Media Manager'),
        agent(OWNER, 'Kat', true),
      ],
      roster,
    );
    expect(m.map((x) => [x.name, x.rosterId])).toEqual([
      ['Coz · Chief', 'mock-chief-01'],
      ['Krystal · Research', 'mock-research-02'],
      ['Social Media Manager', undefined],
      ['Kat', undefined],
    ]);
    expect(m[3].reason).toMatch(/owner/);
    expect(m[2].reason).toMatch(/no office character named "Social Media Manager"/);
  });

  it('honours GROKBOT_AGENT_MAP, refuses unknown characters and ambiguous matches', () => {
    const helper = '33333333-3333-4333-8333-333333333333';
    const o = parseAgentMap(` ${helper}:mock-visual-05 , bad:pair, ${KRYSTAL}:nobody `);
    expect([...o]).toEqual([
      [helper, 'mock-visual-05'],
      [KRYSTAL, 'nobody'],
    ]);
    const m = mapAgents([agent(helper, 'Helper'), agent(KRYSTAL, 'Krystal · Research')], roster, o);
    expect(m[0].rosterId).toBe('mock-visual-05');
    expect(m[1].rosterId).toBeUndefined();
    expect(m[1].reason).toMatch(/unknown character nobody/);
    const amb = mapAgents([agent(COZ, 'Coz · Chief'), agent(KRYSTAL, 'Coz · Second')], roster);
    expect(amb.every((x) => !x.rosterId && /ambiguous/.test(x.reason))).toBe(true);
    // The owner cannot be mapped even by override.
    expect(
      mapAgents([agent(OWNER, 'Kat', true)], roster, new Map([[OWNER, 'mock-chief-01']]))[0]
        .rosterId,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------- integration

const base = {
  dbPath: ':memory:',
  tasksFile: ':memory:',
  chatFile: ':memory:',
  resultsDir: ':memory:',
};
const liveCfg = (over: Record<string, string> = {}) =>
  loadLiveControlConfig({
    ENABLE_GROKBOT_LIVE_CONTROL: 'true',
    GROKBOT_CLI_PATH: '/fake/gbot.mjs',
    GROKBOT_OWNER_AGENT_ID: OWNER,
    GROKBOT_START_PAUSED: 'false', // these tests need polling from the start
    ...over,
  });
/** The group sample's real author: a bot with no office character unless GROKBOT_AGENT_MAP maps it. */
const GROUP_AUTHOR = '55555555-5555-4555-8555-000000000004';
const realBots = [
  { id: COZ, name: 'Coz · Chief', kind: 'bot' },
  { id: GROUP_AUTHOR, name: 'Some Bot · Role', kind: 'bot' },
  { id: KRYSTAL, name: 'Krystal · Research', kind: 'bot' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Social Media Manager', kind: 'bot' },
  { id: OWNER, name: 'Kat', kind: 'bot' },
];
const realGroups = [{ id: GROUP, name: 'Team', kind: 'group', members: [COZ, KRYSTAL] }];

/** Fake CLI that serves the sanitised real samples as thread output. */
const sampleClient = (calls: string[] = []): CliClient => ({
  verify: async () => ({ path: '/fake', repo: '/fake', commit: '9616503', version: 'gbot 0.12.5' }),
  json: async (c) => {
    calls.push(c.cmd);
    if (c.cmd === 'bots') return realBots;
    if (c.cmd === 'groups') return realGroups;
    if (c.cmd === 'thread') {
      const now = Date.now();
      const entries = samples
        .filter((s) => s.thread === c.id)
        .map((s) => ({ ...s.entry, timestampMs: now }));
      return thread(c.id, entries, { isGroup: c.id === GROUP });
    }
    throw new Error('unexpected');
  },
  send: async () => {
    throw new Error('Phase 2 never sends');
  },
});

const fakeRepo = () => {
  const repo = join(temp(), 'grok-bot-cli');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'grok-bot-cli' }));
  const entry = join(repo, 'dist', 'bin', 'gbot.mjs');
  writeFileSync(entry, '// fake, never executed\n');
  chmodSync(entry, 0o755);
  return entry;
};
/** Exec stub: git and --version answer; `answer` decides every CLI command. */
const execWith =
  (answer: (args: string[]) => string | Error): ExecFn =>
  async (file, args) => {
    if (file === '/usr/bin/git')
      return { stdout: '9616503aaaabbbbccccddddeeeeffff000011112\n', stderr: '' };
    if (args.includes('--version')) return { stdout: 'gbot 0.12.5\n', stderr: '' };
    const a = answer(args.slice(1));
    if (a instanceof Error) throw a;
    return { stdout: a, stderr: '' };
  };

const until = async (fn: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Monitoring (local cache reader) and replay still work. No simulated meeting or demo data is used. */
async function officeStillWorks(s: Awaited<ReturnType<typeof buildServer>>) {
  expect((await s.app.inject({ url: '/api/health' })).json().ok).toBe(true);
  // The local cache reader (monitoring) still reads.
  const dir = temp();
  writeFileSync(
    join(dir, 'events.jsonl'),
    JSON.stringify({
      id: 'm1',
      botId: 'mock-chief-01',
      timestamp: new Date().toISOString(),
      type: 'task_started',
      taskId: 't',
      source: 'real',
      payload: { title: 'x' },
    }) + '\n',
  );
  const r = await s.app.inject({
    method: 'POST',
    url: '/api/sources/local',
    payload: { dir, authorize: true },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().localCache).toMatchObject({ state: 'watching', accepted: 1 });
  // Replay endpoints answer.
  expect((await s.app.inject({ url: '/api/sessions' })).statusCode).toBe(200);
  expect((await s.app.inject({ url: '/api/events?limit=5' })).json().events.length).toBeGreaterThan(
    0,
  );
}

describe('Phase 2 integration', () => {
  it('broadcasts mapped, attributed messages over SSE only and stores nothing', async () => {
    const config = liveCfg({
      GROKBOT_AGENT_MAP: `${GROUP_AUTHOR}:mock-execution-04`,
      GROKBOT_POLL_ACTIVE_MS: '3000',
    });
    const s = await buildServer({
      ...base,
      simulation: false,
      liveControl: { config, client: sampleClient() },
    });
    const got: BotEvent[] = [];
    s.providers.subscribe((e) => got.push(e));
    const before = s.store.count();
    await until(() => s.live!.status().threads.length > 0);
    await s.app.inject({ method: 'POST', url: '/api/live-control/active', payload: { id: GROUP } });
    await until(() => got.filter((e) => e.id.startsWith('grokbot-live:')).length >= 2, 8000);
    const live = got.filter((e) => e.id.startsWith('grokbot-live:'));
    // Exactly the two eligible samples: Coz's 1:1 reply (thread-target) and the group bot message
    // (verified, mapped by GROKBOT_AGENT_MAP). The group attachment by Krystal is a placeholder: not sent.
    expect(live.map((e) => [e.botId, e.payload.attribution]).sort()).toEqual([
      ['mock-chief-01', 'thread-target'],
      ['mock-execution-04', 'verified'],
    ]);
    expect(live.every((e) => e.type === 'message' && e.source === 'real')).toBe(true);
    expect(live.every((e) => roster.some((b) => b.id === e.botId))).toBe(true);
    expect(
      live.some((e) => e.payload.attribution === 'thread-target' && e.botId === 'mock-chief-01'),
    ).toBe(true);
    expect(live.every((e) => !('meetingId' in e.payload))).toBe(true);
    // Placeholders never reach the office: only real text messages.
    expect(
      live.every((e) => (e.payload.raw as { messageType?: string }).messageType === 'text'),
    ).toBe(true);
    // Nothing written to the events table (D4).
    expect(s.store.count()).toBe(before);
    expect(
      (await s.app.inject({ url: '/api/events?limit=500' }))
        .json()
        .events.some((e: BotEvent) => e.id.startsWith('grokbot-live:')),
    ).toBe(false);
    const st = (await s.app.inject({ url: '/api/live-control/status' })).json();
    const ownerMap = st.mapping.find((m: { agentId: string }) => m.agentId === OWNER);
    expect(ownerMap.rosterId).toBeUndefined();
    expect(ownerMap.reason).toMatch(/owner/);
    expect(st.mapping.find((m: { agentId: string }) => m.agentId === COZ).rosterId).toBe(
      'mock-chief-01',
    );
    // The Live view keeps everything, including owner, unknown and placeholder messages.
    const thr = (await s.app.inject({ url: `/api/live-control/thread/${COZ}` })).json().messages;
    // Coz's thread: my message, the bot reply, a role:assistant message and a feedback entry.
    expect(thr.map((m: { attribution: string }) => m.attribution).sort()).toEqual([
      'owner',
      'thread-target',
      'unknown',
      'unknown',
    ]);
    expect(thr.find((m: { text: string }) => m.text === '[feedback]')).toBeTruthy();
    await s.app.close();
  });

  it('missing setting: GROKBOT_OWNER_AGENT_ID unset turns Live Control off before anything runs', async () => {
    const calls: string[] = [];
    let verified = 0;
    const client = {
      ...sampleClient(calls),
      verify: async () => (verified++, sampleClient().verify()),
    };
    const s = await buildServer({
      ...base,
      simulation: true,
      liveControl: { config: liveCfg({ GROKBOT_OWNER_AGENT_ID: '' }), client },
    });
    await until(() => s.live!.status().state === 'unavailable');
    expect(s.live!.status().reason).toMatch(/GROKBOT_OWNER_AGENT_ID is not set/);
    expect(verified).toBe(0);
    expect(calls).toEqual([]);
    await officeStillWorks(s);
    await s.app.close();
  });

  it('owner id not in the bots list turns Live Control off after discovery', async () => {
    const calls: string[] = [];
    const s = await buildServer({
      ...base,
      simulation: false,
      liveControl: {
        config: liveCfg({ GROKBOT_OWNER_AGENT_ID: '00000000-0000-0000-0000-000000000000' }),
        client: sampleClient(calls),
      },
    });
    await until(() => s.live!.status().state === 'unavailable');
    expect(s.live!.status().reason).toMatch(/does not appear in the bots list/);
    expect(calls).toEqual(['bots', 'groups']);
    await s.app.close();
  });

  it('CLI missing: unavailable with a clear status; the office keeps working', async () => {
    const s = await buildServer({
      ...base,
      simulation: true,
      liveControl: {
        config: liveCfg({ GROKBOT_CLI_PATH: '/nonexistent/grok-bot-cli/dist/bin/gbot.mjs' }),
      },
    });
    await until(() => s.live!.status().state === 'unavailable');
    const st = (await s.app.inject({ url: '/api/live-control/status' })).json();
    expect(st.reason).toMatch(
      /not found at GROKBOT_CLI_PATH.*Monitoring, simulation and replay keep working/,
    );
    await officeStillWorks(s);
    await s.app.close();
  });

  it('CLI timeout: turns itself off; the office keeps working', async () => {
    const cfg = liveCfg({ GROKBOT_CLI_PATH: fakeRepo(), GROKBOT_MAX_FAILURES: '1' });
    const timeout = () => Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
    const s = await buildServer({
      ...base,
      simulation: true,
      liveControl: { config: cfg, client: createCliClient(cfg, execWith(timeout)) },
    });
    await until(() => s.live!.status().state === 'off-error');
    expect(s.live!.status()).toMatchObject({
      counters: { timeouts: 1 },
      reason: expect.stringMatching(/did not answer in time/),
    });
    await officeStillWorks(s);
    await s.app.close();
  });

  it('gateway down mid-session: turns itself off after working; the office keeps working', async () => {
    const cfg = liveCfg({
      GROKBOT_CLI_PATH: fakeRepo(),
      GROKBOT_MAX_FAILURES: '1',
      GROKBOT_POLL_IDLE_MS: '5000',
    });
    let up = true;
    const exec = execWith((args) => {
      if (args[0] === 'bots') return JSON.stringify(realBots);
      if (args[0] === 'groups') return JSON.stringify(realGroups);
      if (up) return JSON.stringify(thread(args[1], []));
      return Object.assign(new Error('exit 1'), {
        code: 1,
        stdout: JSON.stringify({ error: 'Grok Bot gateway is not reachable', exitCode: 1 }),
      });
    });
    const s = await buildServer({
      ...base,
      simulation: true,
      liveControl: { config: cfg, client: createCliClient(cfg, exec) },
    });
    await until(
      () => s.live!.status().threads.some((t) => t.lastPolledAt) && s.live!.status().state === 'ok',
    );
    up = false;
    await until(() => s.live!.status().state === 'off-error', 10000);
    expect(s.live!.status().reason).toMatch(/gateway is not reachable/);
    await officeStillWorks(s);
    await s.app.close();
  }, 20000);
});
