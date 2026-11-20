import { createRng, type Rng } from './rng';
import type { Bot, BotEvent } from './types';

/**
 * Provider B — Simulation. Generates clearly labelled, fictional activity for the roster.
 * Every event it emits has source "simulated". It never claims to be real Grok Bot work.
 */

const taskTitles: Record<string, string[]> = {
  'mock-chief-01': ['Plan weekly campaign brief', 'Review team priorities', 'Consolidate status report', 'Coordinate release handoff'],
  'mock-review-06': ['Review caption draft', 'Check visual consistency', 'QA campaign checklist', 'Audit handoff notes'],
  'mock-execution-04': ['Write three-part caption set', 'Draft artist story', 'Edit newsletter copy', 'Schedule social posts'],
  'mock-visual-05': ['Sketch cover concept', 'Design artist card', 'Prepare story frame', 'Refine colour palette'],
  'mock-research-02': ['Collect fictional release notes', 'Summarise listener trends', 'Compile reference board', 'Tag discovery playlist'],
  'mock-strategy-03': ['Outline 7-day content mix', 'Map audience segments', 'Plan community prompts', 'Draft channel strategy'],
};

const workLines = [
  'Making progress on this one.',
  'Checking the notes again…',
  'Almost there!',
  'Hmm, let me rethink this part.',
  'Drafting the next section.',
  'Comparing two options.',
];
const doneLines = ['Done! ✨', 'Finished — handing it off.', 'All wrapped up.', 'Shipped the draft.'];
const failLines = ['Hit a snag, flagging it.', 'This needs another pass.'];
const meetingTitles = ['Daily stand-up', 'Campaign sync', 'Design review', 'Planning huddle', 'Retro (demo)'];
const meetingLines = [
  'Quick update from my side.',
  'I can take that action item.',
  'Can we align on the timeline?',
  'The draft is ready for review.',
  'Let’s keep the visuals consistent.',
  'I’ll share notes after this.',
  'Sounds good to me.',
  'Any blockers?',
];

type BotSim = {
  bot: Bot;
  taskId?: string;
  title?: string;
  progress: number;
  nextAt: number;
  phase: 'idle' | 'pending' | 'working';
  endAt: number;
};

export type SimMeeting = { id: string; participants: string[]; endsAt: number; nextLineAt: number; lines: number };

export class SimulationProvider {
  private rng: Rng;
  private bots: BotSim[];
  private seq = 0;
  private meeting?: SimMeeting;
  private nextMeetingAt: number;
  constructor(
    roster: Bot[],
    private readonly options: { seed?: number; now?: number; prefix?: string; meetingEveryMs?: [number, number] } = {},
  ) {
    this.rng = createRng(options.seed ?? 42);
    const now = options.now ?? Date.now();
    this.bots = roster.map((bot) => ({ bot, progress: 0, phase: 'idle', nextAt: now + this.rng.range(2000, 15000), endAt: 0 }));
    this.nextMeetingAt = now + this.rng.range(...(options.meetingEveryMs ?? [150000, 300000]));
  }

  private ev(botId: string, type: BotEvent['type'], now: number, payload: Record<string, unknown> = {}, taskId?: string): BotEvent {
    return {
      id: `${this.options.prefix ?? 'sim'}-${now.toString(36)}-${(this.seq++).toString(36)}`,
      botId,
      taskId,
      timestamp: new Date(now).toISOString(),
      type,
      source: 'simulated',
      payload,
    };
  }

  busy(botId: string) {
    return this.bots.find((b) => b.bot.id === botId)?.phase === 'working' || !!this.meeting?.participants.includes(botId);
  }

  /** Start a simulated meeting now (user-triggered). Returns its events, or [] if one is running. */
  startMeeting(now: number, participants?: string[], title?: string): BotEvent[] {
    if (this.meeting) return [];
    const chosen = participants?.length
      ? participants
      : this.bots.filter((b) => b.bot.isChief || b.phase !== 'working').map((b) => b.bot.id);
    if (chosen.length < 2) return [];
    const id = `meeting-${now.toString(36)}-${this.seq}`;
    this.meeting = { id, participants: chosen, endsAt: now + this.rng.range(45000, 75000), nextLineAt: now + 9000, lines: 0 };
    const host = chosen.find((p) => this.bots.find((b) => b.bot.id === p)?.bot.isChief) ?? chosen[0];
    return [this.ev(host, 'meeting_started', now, { meetingId: id, title: title ?? this.rng.pick(meetingTitles), participants: chosen })];
  }

  tick(now: number): BotEvent[] {
    const out: BotEvent[] = [];
    if (!this.meeting && now >= this.nextMeetingAt) {
      out.push(...this.startMeeting(now));
      this.nextMeetingAt = now + this.rng.range(...(this.options.meetingEveryMs ?? [150000, 300000]));
    }
    if (this.meeting) {
      const m = this.meeting;
      if (now >= m.endsAt) {
        out.push(this.ev(m.participants[0], 'meeting_ended', now, { meetingId: m.id }));
        this.meeting = undefined;
      } else if (now >= m.nextLineAt) {
        out.push(this.ev(this.rng.pick(m.participants), 'message', now, { meetingId: m.id, text: this.rng.pick(meetingLines) }));
        m.nextLineAt = now + this.rng.range(4000, 7000);
        m.lines++;
      }
    }
    for (const s of this.bots) {
      if (this.meeting?.participants.includes(s.bot.id) && s.phase !== 'working') continue;
      if (now < s.nextAt) continue;
      const id = s.bot.id;
      if (s.phase === 'idle') {
        s.taskId = `sim-task-${now.toString(36)}-${(this.seq++).toString(36)}`;
        s.title = this.rng.pick(taskTitles[id] ?? ['Demo task']);
        s.progress = 0;
        s.phase = 'pending';
        out.push(this.ev(id, 'task_created', now, { title: s.title }, s.taskId));
        s.nextAt = now + this.rng.range(1500, 5000);
      } else if (s.phase === 'pending') {
        s.phase = 'working';
        s.endAt = now + this.rng.range(35000, 110000);
        out.push(this.ev(id, 'task_started', now, { title: s.title, progress: 0, summary: s.title }, s.taskId));
        s.nextAt = now + this.rng.range(6000, 12000);
      } else if (now >= s.endAt) {
        const failed = this.rng.chance(0.07);
        out.push(this.ev(id, 'message', now, { text: this.rng.pick(failed ? failLines : doneLines), kind: 'task' }, s.taskId));
        out.push(this.ev(id, failed ? 'task_failed' : 'task_completed', now, { title: s.title }, s.taskId));
        s.phase = 'idle';
        s.taskId = undefined;
        s.nextAt = now + this.rng.range(20000, 70000);
      } else {
        s.progress = Math.min(0.95, s.progress + this.rng.range(0.1, 0.3));
        out.push(this.ev(id, 'task_updated', now, { progress: Number(s.progress.toFixed(2)) }, s.taskId));
        if (this.rng.chance(0.35)) out.push(this.ev(id, 'message', now, { text: this.rng.pick(workLines), kind: 'task' }, s.taskId));
        s.nextAt = Math.min(s.endAt, now + this.rng.range(7000, 14000));
      }
    }
    return out;
  }

  /** Generate a complete fictional history (for the simulated replay demo). */
  static demoHistory(roster: Bot[], start: number, durationMs: number, seed = 7): BotEvent[] {
    const sim = new SimulationProvider(roster, { seed, now: start, prefix: 'demo', meetingEveryMs: [120000, 200000] });
    const out: BotEvent[] = [];
    for (let t = start; t <= start + durationMs; t += 1000) out.push(...sim.tick(t));
    return out;
  }
}
