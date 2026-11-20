import { compareEvents } from './events';
import type { BotEvent, EventSource } from './types';

export type ReplaySession = { id: string; start: string; end: string; count: number; sources: EventSource[] };
export type Gap = { start: number; end: number };

export const SESSION_GAP_MS = 15 * 60 * 1000;
export const DATA_GAP_MS = 3 * 60 * 1000;

/** Group events into sessions separated by more than SESSION_GAP_MS of silence. */
export function splitSessions(events: BotEvent[], gapMs = SESSION_GAP_MS): ReplaySession[] {
  const sorted = [...events].sort(compareEvents);
  const out: ReplaySession[] = [];
  let cur: BotEvent[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      id: `session-${cur[0].timestamp}`,
      start: cur[0].timestamp,
      end: cur[cur.length - 1].timestamp,
      count: cur.length,
      sources: [...new Set(cur.map((e) => e.source))],
    });
    cur = [];
  };
  for (const e of sorted) {
    if (cur.length && Date.parse(e.timestamp) - Date.parse(cur[cur.length - 1].timestamp) > gapMs) flush();
    cur.push(e);
  }
  flush();
  return out;
}

/** Periods without any events, shown as gaps instead of inventing activity. */
export function findGaps(events: BotEvent[], gapMs = DATA_GAP_MS): Gap[] {
  const ts = events.map((e) => Date.parse(e.timestamp)).sort((a, b) => a - b);
  const gaps: Gap[] = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > gapMs) gaps.push({ start: ts[i - 1], end: ts[i] });
  return gaps;
}

/** Re-label historical events as REPLAYED, keeping the original classification. */
export const asReplayed = (e: BotEvent): BotEvent => ({
  ...e,
  id: `replay:${e.id}`,
  source: 'replayed',
  payload: { ...e.payload, originalSource: e.source },
});

export const replaySpeeds = [0.5, 1, 2, 4] as const;

/** Cursor over a sorted event list in source time. */
export class ReplayEngine {
  readonly events: BotEvent[];
  readonly start: number;
  readonly end: number;
  time: number;
  private cursor = 0;
  constructor(events: BotEvent[]) {
    this.events = [...events].sort(compareEvents);
    this.start = this.events.length ? Date.parse(this.events[0].timestamp) : 0;
    this.end = this.events.length ? Date.parse(this.events[this.events.length - 1].timestamp) : 0;
    this.time = this.start;
  }
  get done() {
    return this.cursor >= this.events.length;
  }
  /** Advance by wall-clock ms × speed; returns events whose timestamp has been reached, in order. */
  advance(ms: number, speed: number): BotEvent[] {
    this.time = Math.min(this.end, this.time + ms * speed);
    return this.takeUntil(this.time);
  }
  /** Jump to a timestamp; returns every event up to it so callers can rebuild state from scratch. */
  seek(t: number): BotEvent[] {
    this.time = Math.max(this.start, Math.min(this.end, t));
    this.cursor = 0;
    return this.takeUntil(this.time);
  }
  private takeUntil(t: number) {
    const out: BotEvent[] = [];
    while (this.cursor < this.events.length && Date.parse(this.events[this.cursor].timestamp) <= t) out.push(this.events[this.cursor++]);
    return out;
  }
}
