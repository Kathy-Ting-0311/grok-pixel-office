import { OfficeWorld } from '../../../shared/behavior';
import { activeTaskFor, applyEvent, emptyTaskState } from '../../../shared/events';
import { allocateSeats, meetingSeats } from '../../../shared/meetings';
import { asReplayed } from '../../../shared/replay';
import { createRng } from '../../../shared/rng';
import { botById, roster } from '../../../shared/roster';
import type { BotEvent } from '../../../shared/types';
import { displayState, useStore } from '../store';

/**
 * Bridges verified task/meeting state (store) to visual behaviour (OfficeWorld).
 * Directives come ONLY from task/meeting state; idle wandering never changes task data.
 */
export const world = new OfficeWorld(useStore.getState().layout, Date.now() & 0xffff);
for (const b of roster) world.addBot(b.id, b.trait, b.isChief);

const seatPlans = new Map<string, Record<string, string>>();
const rng = createRng(99);

const chatLines: [string, string][] = [
  ['Coffee break?', 'Always ☕'],
  ['Nice plant, right?', 'It’s thriving!'],
  ['How’s your day?', 'Pretty good!'],
  ['Saw the new board?', 'Love the colours.'],
  ['Lunch later?', 'Count me in 🍜'],
  ['That meeting was quick.', 'The best kind.'],
  ['Any weekend plans?', 'Board games!'],
];

world.on((e) => {
  const st = useStore.getState();
  if (e.kind === 'chat') {
    const [a, b] = rng.pick(chatLines);
    st.say({ botId: e.a, text: a, source: 'simulated', kind: 'social' });
    setTimeout(
      () => useStore.getState().say({ botId: e.b, text: b, source: 'simulated', kind: 'social' }),
      2200,
    );
    if (st.mode === 'live') st.chat(e.a, e.b);
  }
});

function syncDirectives() {
  const s = useStore.getState();
  const state = displayState(s);
  const active = Object.values(state.meetings).filter((m) => m.state === 'in_progress');
  const inMeeting = new Map<string, string>();
  for (const m of active) {
    if (!seatPlans.has(m.id)) {
      const reserved = Object.fromEntries(
        [...world.reservations].filter(([pid]) => world.pointById.get(pid)?.kind !== 'desk'),
      );
      const from = Object.fromEntries(
        m.participants.map((p) => [p, world.brains.get(p)?.tile ?? { x: 0, z: 0 }]),
      );
      seatPlans.set(
        m.id,
        allocateSeats(m.participants, meetingSeats(s.layout), reserved, from).seats,
      );
    }
    for (const p of m.participants) if (world.brains.has(p)) inMeeting.set(p, m.id);
  }
  for (const id of seatPlans.keys()) if (!active.some((m) => m.id === id)) seatPlans.delete(id);
  for (const b of roster) {
    const meetingId = inMeeting.get(b.id);
    if (meetingId) {
      world.setDirective(b.id, {
        mode: 'meeting',
        meetingId,
        seatId: seatPlans.get(meetingId)?.[b.id],
      });
      continue;
    }
    const task = activeTaskFor(state, b.id);
    if (task) world.setDirective(b.id, { mode: 'work', taskId: task.id });
    else if (state.botStatus[b.id]?.status === 'offline')
      world.setDirective(b.id, { mode: 'offline' });
    else world.setDirective(b.id, { mode: 'idle' });
  }
}

/** Fire completion/failure flourishes for newly applied events. */
function react(events: BotEvent[]) {
  for (const e of events) {
    const brain = world.brains.get(e.botId);
    if (!brain) continue;
    if (e.type === 'task_completed') brain.notify('completed');
    if (e.type === 'task_failed') brain.notify('failed');
    // A placed task's model turn: show the existing THINKING pose at the desk for a moment.
    if (
      e.type === 'status_changed' &&
      e.payload.status === 'thinking' &&
      brain.state === 'WORKING'
    ) {
      brain.state = 'THINKING';
      brain.thinkTimer = 3;
    }
  }
}

let lastEventId: string | undefined;
useStore.subscribe((s, prev) => {
  if (s.layout !== prev.layout) {
    world.setLayout(s.layout);
    seatPlans.clear();
  }
  world.paused = s.mode === 'build';
  if (s.events !== prev.events) {
    const from = lastEventId ? s.events.findIndex((e) => e.id === lastEventId) + 1 : 0;
    if (s.mode === 'live')
      react(s.events.slice(from).filter((e) => Date.now() - Date.parse(e.timestamp) < 15000));
    lastEventId = s.events.at(-1)?.id;
  }
  if (
    s.live !== prev.live ||
    s.replay?.state !== prev.replay?.state ||
    s.mode !== prev.mode ||
    s.layout !== prev.layout
  )
    syncDirectives();
});
syncDirectives();

// ------------------------------------------------------------------ replay driver
/** Advance replay by wall-clock ms; applies events in order, relabelled REPLAYED. */
export function stepReplay(ms: number) {
  const s = useStore.getState();
  const r = s.replay;
  if (!r || !r.playing) return;
  const next = Math.min(r.end, r.time + ms * r.speed);
  const due = r.events.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t > r.time && t <= next;
  });
  let state = r.state;
  for (const e of due) {
    const re = asReplayed(e);
    state = applyEvent(state, re);
    const text = typeof e.payload.text === 'string' ? e.payload.text : undefined;
    if (e.type === 'message' && text)
      s.say({
        botId: e.botId,
        text: text.length > 72 ? text.slice(0, 71) + '…' : text,
        source: 'replayed',
        kind: e.payload.meetingId ? 'meeting' : 'task',
      });
    if (e.type === 'task_started')
      s.say({
        botId: e.botId,
        text: `📝 ${String(e.payload.title ?? 'Task')}`,
        source: 'replayed',
        kind: 'task',
        duration: 3500,
      });
  }
  react(due);
  s.setReplay({ time: next, state, playing: next < r.end });
}

export function seekReplay(t: number) {
  const s = useStore.getState();
  const r = s.replay;
  if (!r) return;
  const time = Math.max(r.start, Math.min(r.end, t));
  let state = emptyTaskState();
  for (const e of r.events)
    if (Date.parse(e.timestamp) <= time) state = applyEvent(state, asReplayed(e));
  s.setReplay({ time, state });
}

export const botName = (id: string) => botById(id)?.name ?? id;
