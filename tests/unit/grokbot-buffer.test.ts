import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { LiveMessage } from '../../shared/liveControl';
import type { BotEvent } from '../../shared/types';
import type { GrokBotGatewayAdapter } from '../../backend/src/grokbot/adapter';
import { bridgeToOffice, LIVE_BUFFER_PER_THREAD } from '../../backend/src/grokbot/bridge';
import type { CliClient } from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { buildServer } from '../../backend/src/index';
import { bots, COZ, groups, KRYSTAL, OWNER, sendMessage, thread } from '../fixtures/grokbot/fixtures';

// Reload buffer: the last N live office events per thread, in memory only, added to the SSE snapshot
// only when Live Control is on. Synthetic fixtures only; nothing is sent.

const agents = bots.map((b) => ({ id: b.id, name: b.name, owner: b.id === OWNER }));
const fakeLive = () => {
  let emit: (m: LiveMessage[]) => void = () => {};
  const live = {
    status: () => ({ agents }),
    onMessages: (fn: (m: LiveMessage[]) => void) => ((emit = fn), () => (emit = () => {})),
  } as unknown as GrokBotGatewayAdapter;
  return { live, emit: (m: LiveMessage[]) => emit(m) };
};
const msg = (threadId: string, n: number, over: Partial<LiveMessage> = {}): LiveMessage => ({
  key: `${threadId}:e${n}`,
  threadId,
  isGroup: false,
  entryId: `e${n}`,
  timestamp: new Date(1795000000000 + n * 1000).toISOString(),
  text: `message ${n}`,
  senderId: threadId,
  attribution: 'thread-target',
  basis: '1:1 send-message, no author',
  raw: { kind: 'send-message' },
  ...over,
});

describe('live buffer (bridge)', () => {
  it('keeps the last N per thread, in time order, only office-eligible messages', () => {
    const f = fakeLive();
    const sent: BotEvent[] = [];
    const b = bridgeToOffice(f.live, (e) => sent.push(e), new Map());
    f.emit(Array.from({ length: LIVE_BUFFER_PER_THREAD + 20 }, (_, i) => msg(COZ, i)));
    f.emit([msg(KRYSTAL, 5), msg(KRYSTAL, 6, { attribution: 'unknown' }), msg(KRYSTAL, 7, { placeholder: { type: 'widget' }, text: '[widget]' })]);
    expect(sent).toHaveLength(LIVE_BUFFER_PER_THREAD + 21); // every eligible one is still broadcast
    expect(b.buffered()).toBe(LIVE_BUFFER_PER_THREAD + 1);
    const snap = b.snapshot([]);
    const coz = snap.filter((e) => e.payload.threadId === COZ);
    expect(coz).toHaveLength(LIVE_BUFFER_PER_THREAD);
    expect(coz[0].payload.text).toBe('message 20'); // the oldest 20 were dropped
    expect(snap.filter((e) => e.payload.threadId === KRYSTAL).map((e) => e.payload.text)).toEqual(['message 5']);
    const times = snap.map((e) => Date.parse(e.timestamp));
    expect(times).toEqual([...times].sort((a, x) => a - x));
    b.stop();
    expect(b.buffered()).toBe(0);
  });

  it('with nothing buffered the stored snapshot is returned unchanged', () => {
    const b = bridgeToOffice(fakeLive().live, () => {}, new Map());
    const stored = [{ id: 'x' }] as unknown as BotEvent[];
    expect(b.snapshot(stored)).toBe(stored);
  });
});

describe('live buffer (server)', () => {
  it('a newly connected page gets buffered live messages in its snapshot; nothing is stored', async () => {
    const client: CliClient = {
      verify: async () => ({ path: '/fake', repo: '/fake', commit: '9616503', version: 'gbot 0.12.5' }),
      json: async (c) =>
        c.cmd === 'bots' ? bots
        : c.cmd === 'groups' ? groups
        : c.cmd === 'thread' && c.id === COZ ? thread(COZ, [sendMessage('t1s0', 1, 'buffered hello')])
        : thread(c.cmd === 'thread' ? c.id : 'x', []),
      send: async () => {
        throw new Error('never sends');
      },
    };
    const s = await buildServer({
      dbPath: ':memory:',
      simulation: false,
      tasksFile: ':memory:',
      chatFile: ':memory:',
      resultsDir: ':memory:',
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
    while (!(s.live!.thread(COZ)?.length)) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = s.app.server.address() as AddressInfo;
    const ctl = new AbortController();
    const reader = (await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctl.signal })).body!.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    ctl.abort();
    const snap = JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { events: BotEvent[] };
    const liveEvents = snap.events.filter((e) => e.id.startsWith('grokbot-live:'));
    expect(liveEvents.map((e) => [e.botId, e.payload.text])).toEqual([['mock-chief-01', 'buffered hello']]);
    // Never written to the database.
    expect(s.store.recent(5000).some((e) => e.id.startsWith('grokbot-live:'))).toBe(false);
    await s.app.close();
  });
});
