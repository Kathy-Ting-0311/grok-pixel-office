import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  classifySource,
  compareEvents,
  Deduper,
  emptyTaskState,
  reduceEvents,
  taskStats,
  activeTaskFor,
  filterTasks,
  botEventSchema,
} from '../../shared/events';
import { ReplayEngine, asReplayed, findGaps, splitSessions } from '../../shared/replay';
import { SimulationProvider } from '../../shared/simProvider';
import { roster } from '../../shared/roster';
import { layoutBubbles } from '../../shared/bubbles';
import { applyGameEvent, emptyProgression } from '../../shared/progression';
import type { BotEvent } from '../../shared/types';

const ev = (
  id: string,
  type: BotEvent['type'],
  t: number,
  extra: Partial<BotEvent> = {},
): BotEvent => ({
  id,
  botId: 'b1',
  taskId: 't1',
  timestamp: new Date(t).toISOString(),
  type,
  source: 'real',
  payload: {},
  ...extra,
});

describe('task state transitions', () => {
  it('pending → active → completed with known progress', () => {
    let s = emptyTaskState();
    s = applyEvent(s, ev('1', 'task_created', 1000, { payload: { title: 'Write' } }));
    expect(s.tasks.t1.status).toBe('pending');
    s = applyEvent(s, ev('2', 'task_started', 2000));
    expect(s.tasks.t1).toMatchObject({ status: 'active', progress: null, title: 'Write' });
    s = applyEvent(s, ev('3', 'task_updated', 3000, { payload: { progress: 0.4 } }));
    expect(s.tasks.t1.progress).toBe(0.4);
    s = applyEvent(s, ev('4', 'task_completed', 4000));
    expect(s.tasks.t1).toMatchObject({ status: 'completed', progress: 1 });
  });
  it('keeps progress unknown (null) when the source never reports it', () => {
    const s = reduceEvents([
      ev('1', 'task_started', 1),
      ev('2', 'task_updated', 2),
      ev('3', 'task_completed', 3),
    ]);
    expect(s.tasks.t1.progress).toBeNull();
  });
  it('does not reopen a finished task and ignores updates for unknown tasks', () => {
    const s = reduceEvents([
      ev('1', 'task_started', 1),
      ev('2', 'task_failed', 2),
      ev('3', 'task_started', 3),
      ev('4', 'task_updated', 4, { taskId: 'zz' }),
    ]);
    expect(s.tasks.t1.status).toBe('failed');
    expect(s.tasks.zz).toBeUndefined();
  });
  it('picks the most recent active task for a bot', () => {
    const s = reduceEvents([
      ev('1', 'task_started', 1),
      ev('2', 'task_started', 5, { taskId: 't2' }),
    ]);
    expect(activeTaskFor(s, 'b1')?.id).toBe('t2');
  });
});

describe('statistics', () => {
  it('completion rate = completed / all observed tasks', () => {
    const s = reduceEvents([
      ev('1', 'task_completed', 1, { taskId: 'a' }),
      ev('2', 'task_failed', 1, { taskId: 'b' }),
      ev('3', 'task_started', 1, { taskId: 'c' }),
      ev('4', 'task_created', 1, { taskId: 'd' }),
    ]);
    const st = taskStats(Object.values(s.tasks));
    expect(st).toMatchObject({
      total: 4,
      completed: 1,
      failed: 1,
      active: 1,
      pending: 1,
      eligible: 4,
      completionRate: 25,
    });
    expect(taskStats([]).completionRate).toBeNull();
    expect(filterTasks(Object.values(s.tasks), { status: 'failed' }).map((t) => t.id)).toEqual([
      'b',
    ]);
  });
});

describe('deduplication & classification', () => {
  it('drops duplicates', () => {
    const d = new Deduper(3);
    expect(d.add('a')).toBe(true);
    expect(d.add('a')).toBe(false);
    d.add('b');
    d.add('c');
    d.add('d');
    expect(d.add('a')).toBe(true); // evicted after limit
  });
  it('never upgrades unlabelled data to real', () => {
    expect(classifySource(undefined, true)).toBe('unknown');
    expect(classifySource('real', false)).toBe('unknown');
    expect(classifySource('real', true)).toBe('real');
    expect(classifySource('simulated', true)).toBe('simulated');
    expect(classifySource('REAL!', true)).toBe('unknown');
  });
  it('validates event shape', () => {
    expect(botEventSchema.safeParse(ev('1', 'task_started', 1)).success).toBe(true);
    expect(
      botEventSchema.safeParse({ ...ev('1', 'task_started', 1), timestamp: 'nope' }).success,
    ).toBe(false);
  });
});

describe('replay', () => {
  const events = [
    ev('b', 'task_started', 2000),
    ev('a', 'task_created', 1000),
    ev('c', 'task_completed', 400000),
  ];
  it('orders by timestamp then id and replays in order', () => {
    const r = new ReplayEngine(events);
    expect(r.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(r.advance(1500, 1).map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.advance(1000, 4).map((e) => e.id)).toEqual([]);
    expect(r.seek(500000).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(r.seek(1500).map((e) => e.id)).toEqual(['a']);
  });
  it('shows gaps and splits sessions instead of inventing activity', () => {
    expect(findGaps(events)).toHaveLength(1);
    expect(splitSessions([...events, ev('d', 'message', 400000 + 20 * 60000)])).toHaveLength(2);
    expect(compareEvents(events[0], events[0])).toBe(0);
  });
  it('relabels as replayed while keeping the original source', () => {
    const r = asReplayed(events[0]);
    expect(r.source).toBe('replayed');
    expect(r.payload.originalSource).toBe('real');
  });
});

describe('simulation provider', () => {
  it('emits only simulated events with a valid lifecycle', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const history = SimulationProvider.demoHistory(roster, start, 10 * 60000);
    expect(history.length).toBeGreaterThan(50);
    expect(history.every((e) => e.source === 'simulated')).toBe(true);
    expect(history.every((e) => botEventSchema.safeParse(e).success)).toBe(true);
    const s = reduceEvents(history);
    const tasks = Object.values(s.tasks);
    expect(tasks.some((t) => t.status === 'completed')).toBe(true);
    // Each completion was preceded by a start of the same task.
    for (const t of tasks.filter((t) => t.status === 'completed'))
      expect(t.startedAt).toBeDefined();
    expect(new Set(history.map((e) => e.id)).size).toBe(history.length);
    expect(history.some((e) => e.type === 'meeting_started')).toBe(true);
  });
  it('supports user-triggered meetings', () => {
    const sim = new SimulationProvider(roster, { now: 0 });
    const evs = sim.startMeeting(1000);
    expect(evs[0]).toMatchObject({ type: 'meeting_started', source: 'simulated' });
    expect(sim.startMeeting(2000)).toEqual([]);
  });
});

describe('speech bubble layout', () => {
  const vp = { width: 800, height: 600 };
  it('does not overlap visible bubbles', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
      x: 400 + i * 5,
      y: 300,
      width: 120,
      height: 30,
      priority: i,
    }));
    const out = layoutBubbles(items, { maxVisible: 10, viewport: vp });
    const vis = out.filter((o) => o.visible);
    for (const a of vis)
      for (const b of vis)
        if (a !== b) expect(Math.abs(a.y - b.y) >= 30 || Math.abs(a.x - b.x) >= 120).toBe(true);
    expect(out.find((o) => o.id === 'b5')!.lift).toBe(0); // highest priority keeps its anchor
  });
  it('respects maxVisible, viewport and distance', () => {
    const items = [
      { id: 'a', x: 100, y: 100, width: 50, height: 20, priority: 1 },
      { id: 'b', x: 300, y: 100, width: 50, height: 20, priority: 2 },
      { id: 'off', x: -500, y: 100, width: 50, height: 20, priority: 9 },
      { id: 'far', x: 500, y: 100, width: 50, height: 20, priority: 9, distance: 2 },
    ];
    const out = layoutBubbles(items, { maxVisible: 1, viewport: vp });
    expect(out.filter((o) => o.visible).map((o) => o.id)).toEqual(['b']);
  });
});

describe('game layer separation', () => {
  it('ignores unknown and replayed events for rewards', () => {
    const p = emptyProgression();
    expect(applyGameEvent(p, ev('1', 'task_completed', 1, { source: 'unknown' }))).toBe(p);
    expect(applyGameEvent(p, ev('1', 'task_completed', 1, { source: 'replayed' }))).toBe(p);
    expect(
      applyGameEvent(p, ev('1', 'task_completed', 1, { source: 'simulated' })).coins,
    ).toBeGreaterThan(p.coins);
  });
});
