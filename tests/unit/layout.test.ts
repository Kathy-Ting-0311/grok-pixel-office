import { describe, expect, it } from 'vitest';
import {
  buildNavGrid,
  checkEssentialRoutes,
  createDefaultLayout,
  itemCells,
  itemPoints,
  localToWorld,
  resizeLayout,
  validatePlacement,
  wallBetween,
} from '../../shared/layout';
import { getCatalog } from '../../shared/catalog';
import { findPath } from '../../shared/pathfinding';
import { allocateSeats, meetingSeats } from '../../shared/meetings';
import type { OfficeLayout } from '../../shared/types';

describe('default office', () => {
  const layout = createDefaultLayout();
  it('is 16x12 with the four default rooms and valid routes', () => {
    expect(layout.width).toBe(16);
    expect(layout.depth).toBe(12);
    expect(layout.rooms.map((r) => r.type)).toEqual(['work', 'executive', 'meeting', 'common']);
    const check = checkEssentialRoutes(layout);
    expect(check.ok).toBe(true);
  });
  it('every default furniture item is a valid placement', () => {
    for (const f of layout.furniture) {
      const r = validatePlacement(layout, f);
      expect(r, f.uid).toMatchObject({ ok: true });
    }
  });
  it('assigns a desk to every Bot and every desk seat is reachable', () => {
    const grid = buildNavGrid(layout);
    for (const uid of Object.values(layout.deskAssignments)) {
      const desk = layout.furniture.find((f) => f.uid === uid)!;
      const seat = itemPoints(desk).find((p) => p.kind === 'desk')!;
      expect(findPath(grid, layout.entrance, { x: seat.tx, z: seat.tz }), uid).not.toBeNull();
    }
  });
});

describe('rotation', () => {
  it('rotates footprints and interaction points consistently', () => {
    const item = getCatalog('coffee_machine');
    expect(localToWorld(item, 15, 10, 1, 0, 1)).toEqual({ x: 14, z: 10 });
    const desk = { uid: 'd', catalogId: 'exec_desk', x: 1, z: 0, rot: 2 as const };
    expect(
      itemCells(desk)
        .filter((c) => c.kind === 'B')
        .map((c) => [c.x, c.z])
        .sort(),
    ).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(itemPoints(desk)[0]).toMatchObject({ tx: 2, tz: 0 });
    expect(Math.cos(itemPoints(desk)[0].worldFacing)).toBeCloseTo(1); // faces +z (towards the camera)
  });
});

describe('furniture placement & collision', () => {
  const layout = createDefaultLayout();
  it('rejects overlap, out of bounds and the entrance tile', () => {
    expect(
      validatePlacement(layout, { uid: 'n', catalogId: 'plant_big', x: 1, z: 7, rot: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      validatePlacement(layout, { uid: 'n', catalogId: 'sofa', x: 15, z: 6, rot: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      validatePlacement(layout, { uid: 'n', catalogId: 'plant_big', x: 7, z: 11, rot: 0 }),
    ).toMatchObject({ ok: false });
  });
  it('allows a rug under furniture but not a desk over a desk', () => {
    expect(
      validatePlacement(layout, { uid: 'n', catalogId: 'rug', x: 3, z: 9, rot: 0 }),
    ).toMatchObject({ ok: true });
  });
  it('refuses placements that cut off essential routes', () => {
    // Block the only door of the chief office (tile 4,3 inside / 5,3 outside).
    const r = validatePlacement(layout, { uid: 'n', catalogId: 'plant_big', x: 5, z: 3, rot: 0 });
    expect(r).toMatchObject({ ok: false });
  });
  it('refuses furniture straddling a wall', () => {
    expect(
      validatePlacement(layout, { uid: 'n', catalogId: 'sofa', x: 4, z: 8, rot: 1 }),
    ).toMatchObject({ ok: true });
    expect(
      validatePlacement(layout, { uid: 'n', catalogId: 'bookshelf', x: 4, z: 6, rot: 0 }).ok,
    ).toBe(true);
    const across = validatePlacement(layout, {
      uid: 'n',
      catalogId: 'bookshelf',
      x: 10,
      z: 10,
      rot: 0,
    });
    expect(across).toMatchObject({ ok: false });
  });
});

describe('room creation & resizing', () => {
  it('expands the office and keeps it closed and reachable', () => {
    const layout = createDefaultLayout();
    const bigger = resizeLayout(layout, 'east', 1) as OfficeLayout;
    expect(typeof bigger).toBe('object');
    expect(bigger.width).toBe(17);
    expect(checkEssentialRoutes(bigger).ok).toBe(true);
    const grid = buildNavGrid(bigger);
    expect(wallBetween(grid, 16, 3, 17, 3)).toBe(true);
    const shifted = resizeLayout(layout, 'west', 1) as OfficeLayout;
    expect(shifted.entrance).toEqual({ x: 8, z: 11 });
    expect(shifted.furniture.find((f) => f.uid === 'desk-1')!.x).toBe(2);
    expect(checkEssentialRoutes(shifted).ok).toBe(true);
  });
  it('refuses to shrink through furniture', () => {
    expect(typeof resizeLayout(createDefaultLayout(), 'east', -1)).toBe('string');
  });
  it('creates a new room by painting tiles', () => {
    const layout = createDefaultLayout();
    const next = {
      ...layout,
      rooms: [...layout.rooms, { id: 'r-x', name: 'Server Room', type: 'server' as const }],
    };
    next.tiles = next.tiles.map((t, i) =>
      i % 16 >= 5 && i % 16 <= 6 && Math.floor(i / 16) >= 1 && Math.floor(i / 16) <= 2
        ? { ...t, roomId: 'r-x' }
        : t,
    );
    expect(checkEssentialRoutes(next).ok).toBe(true);
  });
});

describe('pathfinding', () => {
  const layout = createDefaultLayout();
  const grid = buildNavGrid(layout);
  it('never crosses walls or blocked furniture', () => {
    const path = findPath(grid, { x: 7, z: 11 }, { x: 2, z: 0 })!;
    expect(path).not.toBeNull();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      expect(grid.cells[b.z * grid.width + b.x]).not.toBe(2);
      if (a.x !== b.x && a.z !== b.z) {
        expect(wallBetween(grid, a.x, a.z, b.x, a.z) || wallBetween(grid, a.x, a.z, a.x, b.z)).toBe(
          false,
        );
      } else expect(wallBetween(grid, a.x, a.z, b.x, b.z)).toBe(false);
    }
    // Must pass through the chief office door edge (5,3)->(4,3).
    expect(path.some((t, i) => i > 0 && t.x === 4 && t.z === 3 && path[i - 1].x === 5)).toBe(true);
  });
  it('returns null for unreachable or blocked goals', () => {
    expect(findPath(grid, { x: 7, z: 11 }, { x: 1, z: 1 })).toBeNull();
    const sealed: OfficeLayout = {
      ...layout,
      walls: layout.walls.map((w) =>
        w.kind === 'door' && w.x === 5 ? { ...w, kind: 'glass' } : w,
      ),
    };
    expect(findPath(buildNavGrid(sealed), { x: 7, z: 11 }, { x: 2, z: 0 })).toBeNull();
    expect(checkEssentialRoutes(sealed).ok).toBe(false);
  });
  it('re-routes after furniture moves', () => {
    const before = findPath(grid, { x: 7, z: 10 }, { x: 7, z: 6 })!;
    const moved = {
      ...layout,
      furniture: [
        ...layout.furniture,
        { uid: 'x', catalogId: 'bookshelf', x: 6, z: 6, rot: 0 as const },
      ],
    };
    const after = findPath(buildNavGrid(moved), { x: 7, z: 10 }, { x: 7, z: 5 })!;
    expect(before.length).toBeGreaterThan(0);
    expect(after.some((t) => t.x === 7 && t.z === 6)).toBe(false);
  });
});

describe('meeting seat allocation', () => {
  const layout = createDefaultLayout();
  const seats = meetingSeats(layout);
  it('finds reachable conference seats', () => {
    expect(seats.length).toBeGreaterThanOrEqual(6);
  });
  it('allocates unique seats, keeps held seats, overflows to standing', () => {
    const a = allocateSeats(['a', 'b', 'c'], seats);
    expect(new Set(Object.values(a.seats)).size).toBe(3);
    const again = allocateSeats(['a', 'b', 'c'], seats, { [a.seats.b]: 'b' });
    expect(again.seats.b).toBe(a.seats.b);
    const crowd = allocateSeats(['1', '2', '3'], seats.slice(0, 2));
    expect(crowd.standing).toEqual(['3']);
    const reservedByOther = allocateSeats(['a'], seats.slice(0, 1), { [seats[0].id]: 'z' });
    expect(reservedByOther.standing).toEqual(['a']);
  });
});
