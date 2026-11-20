import { allPoints, buildNavGrid, reachable, roomAt, tileIndex, type WorldPoint } from './layout';
import type { OfficeLayout } from './types';

/** Seats inside rooms of type 'meeting' that are reachable from the entrance. */
export function meetingSeats(layout: OfficeLayout, roomId?: string): WorldPoint[] {
  const seen = reachable(buildNavGrid(layout), layout.entrance);
  return allPoints(layout).filter((p) => {
    const room = roomAt(layout, p.tx, p.tz);
    return (
      p.pose === 'sit' &&
      p.kind !== 'desk' &&
      room?.type === 'meeting' &&
      (!roomId || room.id === roomId) &&
      seen[tileIndex(layout, p.tx, p.tz)] === 1
    );
  });
}

export type SeatAllocation = { seats: Record<string, string>; standing: string[] };

/**
 * Allocate meeting seats deterministically. Seats already reserved by someone else are skipped;
 * participants keep a seat they already hold. Participants beyond capacity are returned as `standing`.
 * `from` gives each participant's current tile for nearest-seat preference.
 */
export function allocateSeats(
  participants: string[],
  seats: WorldPoint[],
  reserved: Record<string, string> = {},
  from: Record<string, { x: number; z: number }> = {},
): SeatAllocation {
  const result: Record<string, string> = {};
  const taken = new Set(Object.entries(reserved).filter(([, bot]) => !participants.includes(bot)).map(([seat]) => seat));
  const unique = [...new Set(participants)];
  for (const bot of unique) {
    const held = Object.entries(reserved).find(([seat, b]) => b === bot && seats.some((s) => s.id === seat));
    if (held) {
      result[bot] = held[0];
      taken.add(held[0]);
    }
  }
  const standing: string[] = [];
  for (const bot of unique) {
    if (result[bot]) continue;
    const pos = from[bot];
    const free = seats
      .filter((s) => !taken.has(s.id))
      .sort((a, b) => (pos ? Math.hypot(a.tx - pos.x, a.tz - pos.z) - Math.hypot(b.tx - pos.x, b.tz - pos.z) : 0) || (a.id < b.id ? -1 : 1));
    if (!free.length) {
      standing.push(bot);
      continue;
    }
    result[bot] = free[0].id;
    taken.add(free[0].id);
  }
  return { seats: result, standing };
}
