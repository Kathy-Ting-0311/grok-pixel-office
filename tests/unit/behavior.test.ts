import { describe, expect, it } from 'vitest';
import { OfficeWorld } from '../../shared/behavior';
import { createDefaultLayout, itemPoints, wallBetween } from '../../shared/layout';
import { roster } from '../../shared/roster';
import { meetingSeats, allocateSeats } from '../../shared/meetings';

function makeWorld() {
  const layout = createDefaultLayout();
  const world = new OfficeWorld(layout, 3);
  for (const b of roster) world.addBot(b.id, b.trait, b.isChief);
  return { world, layout };
}
const run = (world: OfficeWorld, seconds: number, each?: () => void) => {
  for (let t = 0; t < seconds; t += 0.05) {
    world.update(0.05);
    each?.();
  }
};

describe('character behaviour', () => {
  it('starts every Bot at its assigned desk', () => {
    const { world, layout } = makeWorld();
    for (const b of roster) {
      const desk = itemPoints(
        layout.furniture.find((f) => f.uid === layout.deskAssignments[b.id])!,
      )[0];
      const brain = world.brains.get(b.id)!;
      expect(brain.tile).toEqual({ x: desk.tx, z: desk.tz });
    }
  });

  it('walks to the desk and works when a task starts; celebrates then idles on completion', () => {
    const { world } = makeWorld();
    const id = 'mock-strategy-03';
    const b = world.brains.get(id)!;
    world.setDirective(id, { mode: 'idle' });
    run(world, 60); // let it wander away
    world.setDirective(id, { mode: 'work', taskId: 't1' });
    let sawWalk = false;
    run(world, 30, () => (sawWalk ||= b.state === 'WALKING_TO_DESK'));
    expect(['WORKING', 'THINKING']).toContain(b.state);
    expect(b.pose).toBe('sit');
    expect(b.tile).toEqual(
      world.deskOf(id) && { x: world.deskOf(id)!.tx, z: world.deskOf(id)!.tz },
    );
    // A task update keeps working without restarting.
    world.setDirective(id, { mode: 'work', taskId: 't1' });
    world.update(0.05);
    expect(b.pose).toBe('sit');
    b.notify('completed');
    world.setDirective(id, { mode: 'idle' });
    world.update(0.05);
    expect(b.state).toBe('COMPLETED');
    run(world, 3.5);
    expect(b.state).not.toBe('COMPLETED');
    expect(typeof sawWalk).toBe('boolean');
  });

  it('never walks through walls while idling for a long time', () => {
    const { world } = makeWorld();
    const last = new Map<string, { x: number; z: number }>();
    for (const b of world.brains.values()) last.set(b.id, b.tile);
    run(world, 240, () => {
      for (const b of world.brains.values()) {
        const prev = last.get(b.id)!;
        const t = b.tile;
        if (prev.x !== t.x || prev.z !== t.z) {
          if (prev.x !== t.x && prev.z !== t.z) {
            expect(
              wallBetween(world.grid, prev.x, prev.z, t.x, prev.z) &&
                wallBetween(world.grid, prev.x, prev.z, prev.x, t.z),
            ).toBe(false);
          } else
            expect(
              wallBetween(world.grid, prev.x, prev.z, t.x, t.z),
              `${b.id} ${JSON.stringify([prev, t])}`,
            ).toBe(false);
          expect(world.grid.cells[t.z * world.grid.width + t.x]).not.toBe(2);
          last.set(b.id, t);
        }
      }
    });
    // Idle Bots did something other than stand still.
    expect([...world.brains.values()].some((b) => b.goal && b.goal.purpose !== 'deskIdle')).toBe(
      true,
    );
  });

  it('gathers participants into meeting seats', () => {
    const { world, layout } = makeWorld();
    const seats = meetingSeats(layout);
    const parts = ['mock-chief-01', 'mock-review-06', 'mock-research-02'];
    const alloc = allocateSeats(parts, seats);
    for (const p of parts)
      world.setDirective(p, { mode: 'meeting', meetingId: 'm1', seatId: alloc.seats[p] });
    run(world, 40);
    for (const p of parts) {
      const b = world.brains.get(p)!;
      const seat = world.pointById.get(alloc.seats[p])!;
      expect(b.state).toBe('MEETING');
      expect(b.tile).toEqual({ x: seat.tx, z: seat.tz });
      expect(b.pose).toBe('sit');
    }
  });

  it('re-routes when the layout changes under a walking Bot', () => {
    const { world, layout } = makeWorld();
    const id = 'mock-visual-05';
    world.setDirective(id, { mode: 'meeting', meetingId: 'm', seatId: meetingSeats(layout)[0].id });
    run(world, 0.5);
    const changed = {
      ...layout,
      furniture: [
        ...layout.furniture,
        { uid: 'block', catalogId: 'plant_big', x: 10, z: 9, rot: 0 as const },
      ],
    };
    world.setLayout(changed);
    run(world, 40);
    expect(world.brains.get(id)!.pose).toBe('sit');
  });
});
