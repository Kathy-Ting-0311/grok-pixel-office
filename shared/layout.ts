import { getCatalog, type CatalogItem, type InteractionPoint } from './catalog';
import type { FloorType, FurnitureItem, OfficeLayout, Room, Rotation, TileData, Wall, WallKind } from './types';

export const MIN_SIZE = 8;
export const MAX_SIZE = 40;

export const tileIndex = (layout: { width: number }, x: number, z: number) => z * layout.width + x;
export const inBounds = (layout: { width: number; depth: number }, x: number, z: number) =>
  x >= 0 && z >= 0 && x < layout.width && z < layout.depth;

export function rotatedSize(item: CatalogItem, rot: Rotation) {
  return rot % 2 === 0 ? { w: item.w, d: item.d } : { w: item.d, d: item.w };
}

/** Map a local tile (lx,lz) of a footprint to its world tile for an item placed at (x,z) with rotation rot. */
export function localToWorld(item: CatalogItem, x: number, z: number, rot: Rotation, lx: number, lz: number) {
  const rx = lx + 0.5 - item.w / 2;
  const rz = lz + 0.5 - item.d / 2;
  let ox = rx;
  let oz = rz;
  if (rot === 1) [ox, oz] = [-rz, rx];
  else if (rot === 2) [ox, oz] = [-rx, -rz];
  else if (rot === 3) [ox, oz] = [rz, -rx];
  const size = rotatedSize(item, rot);
  return { x: Math.round(x + size.w / 2 + ox - 0.5), z: Math.round(z + size.d / 2 + oz - 0.5) };
}

/** World-space centre of an item footprint (tile units; tile (0,0) spans [0,1]). */
export function itemCenter(f: FurnitureItem) {
  const size = rotatedSize(getCatalog(f.catalogId), f.rot);
  return { x: f.x + size.w / 2, z: f.z + size.d / 2 };
}

export const rotationY = (rot: Rotation) => (-rot * Math.PI) / 2;

export type Cell = { x: number; z: number; kind: 'B' | 'S' | 'F' };
export function itemCells(f: FurnitureItem): Cell[] {
  const item = getCatalog(f.catalogId);
  const out: Cell[] = [];
  item.mask.forEach((row, lz) =>
    [...row].forEach((ch, lx) => {
      if (ch === 'B' || ch === 'S' || ch === 'F') out.push({ ...localToWorld(item, f.x, f.z, f.rot, lx, lz), kind: ch });
    }),
  );
  return out;
}

export type WorldPoint = InteractionPoint & {
  id: string;
  uid: string;
  catalogId: string;
  tx: number;
  tz: number;
  worldFacing: number;
};

export function itemPoints(f: FurnitureItem): WorldPoint[] {
  const item = getCatalog(f.catalogId);
  return item.points.map((p, i) => {
    const t = localToWorld(item, f.x, f.z, f.rot, p.x, p.z);
    return { ...p, id: `${f.uid}#${i}`, uid: f.uid, catalogId: f.catalogId, tx: t.x, tz: t.z, worldFacing: p.facing + rotationY(f.rot) };
  });
}

export const allPoints = (layout: OfficeLayout) => layout.furniture.flatMap(itemPoints);

export const edgeKey = (x: number, z: number, side: 'n' | 'w') => `${x},${z},${side}`;

/** Navigation grid derived from a layout. 0 = free, 1 = seat (walkable, costly), 2 = blocked. */
export type NavGrid = {
  width: number;
  depth: number;
  cells: Uint8Array;
  walls: Map<string, WallKind>;
};

export function buildNavGrid(layout: OfficeLayout): NavGrid {
  const cells = new Uint8Array(layout.width * layout.depth);
  for (const f of layout.furniture) {
    for (const c of itemCells(f)) {
      if (!inBounds(layout, c.x, c.z)) continue;
      const i = tileIndex(layout, c.x, c.z);
      const v = c.kind === 'B' ? 2 : c.kind === 'S' ? 1 : 0;
      cells[i] = Math.max(cells[i], v);
    }
  }
  const walls = new Map<string, WallKind>();
  for (const w of layout.walls) walls.set(edgeKey(w.x, w.z, w.side), w.kind);
  return { width: layout.width, depth: layout.depth, cells, walls };
}

const edgeBlocks = (grid: NavGrid, key: string) => {
  const kind = grid.walls.get(key);
  return kind !== undefined && kind !== 'door';
};

/** Whether a single orthogonal step crosses a blocking wall. */
export function wallBetween(grid: NavGrid, ax: number, az: number, bx: number, bz: number) {
  if (bx === ax + 1 && bz === az) return edgeBlocks(grid, edgeKey(bx, bz, 'w'));
  if (bx === ax - 1 && bz === az) return edgeBlocks(grid, edgeKey(ax, az, 'w'));
  if (bz === az + 1 && bx === ax) return edgeBlocks(grid, edgeKey(bx, bz, 'n'));
  if (bz === az - 1 && bx === ax) return edgeBlocks(grid, edgeKey(ax, az, 'n'));
  return false;
}

export const cellAt = (grid: NavGrid, x: number, z: number) =>
  x < 0 || z < 0 || x >= grid.width || z >= grid.depth ? 2 : grid.cells[z * grid.width + x];

/** Can a character move from a to an adjacent tile b (8-neighbourhood, no corner cutting)? */
export function canStep(grid: NavGrid, ax: number, az: number, bx: number, bz: number) {
  if (cellAt(grid, bx, bz) === 2) return false;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) + Math.abs(dz) === 1) return !wallBetween(grid, ax, az, bx, bz);
  if (Math.abs(dx) !== 1 || Math.abs(dz) !== 1) return false;
  // Diagonal: both orthogonal routes must be open and free (no squeezing past desks or seats).
  const viaX = cellAt(grid, bx, az) === 0 && !wallBetween(grid, ax, az, bx, az) && !wallBetween(grid, bx, az, bx, bz);
  const viaZ = cellAt(grid, ax, bz) === 0 && !wallBetween(grid, ax, az, ax, bz) && !wallBetween(grid, ax, bz, bx, bz);
  return viaX && viaZ;
}

/** Tiles reachable from the entrance. */
export function reachable(grid: NavGrid, start: { x: number; z: number }) {
  const seen = new Uint8Array(grid.width * grid.depth);
  if (cellAt(grid, start.x, start.z) === 2) return seen;
  const queue = [start.z * grid.width + start.x];
  seen[queue[0]] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % grid.width;
    const z = (i - x) / grid.width;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= grid.width || nz >= grid.depth) continue;
        const ni = nz * grid.width + nx;
        if (!seen[ni] && canStep(grid, x, z, nx, nz)) {
          seen[ni] = 1;
          queue.push(ni);
        }
      }
  }
  return seen;
}

export type ValidationResult = { ok: true; warnings: string[] } | { ok: false; reason: string };

/** Essential destinations: assigned desks, at least one meeting seat per meeting room, every room. */
export function checkEssentialRoutes(layout: OfficeLayout): ValidationResult {
  const grid = buildNavGrid(layout);
  const { x, z } = layout.entrance;
  if (!inBounds(layout, x, z) || cellAt(grid, x, z) === 2) return { ok: false, reason: 'The entrance tile must stay clear.' };
  const seen = reachable(grid, layout.entrance);
  const ok = (tx: number, tz: number) => inBounds(layout, tx, tz) && seen[tileIndex(layout, tx, tz)] === 1;
  const points = allPoints(layout);
  for (const [botId, uid] of Object.entries(layout.deskAssignments)) {
    const desk = points.find((p) => p.uid === uid && p.kind === 'desk');
    if (desk && !ok(desk.tx, desk.tz)) return { ok: false, reason: `That would block the route to an assigned desk (${botId}).` };
  }
  for (const room of layout.rooms) {
    const tiles = layout.tiles.map((t, i) => (t.roomId === room.id ? i : -1)).filter((i) => i >= 0);
    if (!tiles.length) continue;
    if (!tiles.some((i) => seen[i])) return { ok: false, reason: `${room.name} would become unreachable.` };
    if (room.type === 'meeting') {
      const seats = points.filter((p) => p.pose === 'sit' && roomAt(layout, p.tx, p.tz)?.id === room.id);
      if (seats.length && !seats.some((p) => ok(p.tx, p.tz))) return { ok: false, reason: `Every seat in ${room.name} would be blocked.` };
    }
  }
  const warnings = points.filter((p) => !ok(p.tx, p.tz)).map((p) => `${getCatalog(p.catalogId).name} has an unreachable spot.`);
  return { ok: true, warnings: [...new Set(warnings)] };
}

export function roomAt(layout: OfficeLayout, x: number, z: number): Room | undefined {
  if (!inBounds(layout, x, z)) return undefined;
  const id = layout.tiles[tileIndex(layout, x, z)].roomId;
  return id ? layout.rooms.find((r) => r.id === id) : undefined;
}

/** Validate placing (or moving, via ignoreUid) a furniture item. */
export function validatePlacement(layout: OfficeLayout, f: FurnitureItem, ignoreUid = f.uid): ValidationResult {
  const cells = itemCells(f);
  for (const c of cells) if (!inBounds(layout, c.x, c.z)) return { ok: false, reason: 'Outside the office.' };
  const others = layout.furniture.filter((o) => o.uid !== ignoreUid);
  const occupied = new Map<string, Cell['kind']>();
  for (const o of others) for (const c of itemCells(o)) {
    const key = `${c.x},${c.z}`;
    const prev = occupied.get(key);
    if (prev !== 'B' && prev !== 'S') occupied.set(key, c.kind);
  }
  for (const c of cells) {
    const other = occupied.get(`${c.x},${c.z}`);
    if (!other) continue;
    const rugOverlap = c.kind === 'F' ? other !== 'F' : other === 'F';
    if (!rugOverlap) return { ok: false, reason: 'Overlaps other furniture.' };
  }
  if (cells.some((c) => c.kind !== 'F' && c.x === layout.entrance.x && c.z === layout.entrance.z))
    return { ok: false, reason: 'The entrance must stay clear.' };
  // Blocking cells may not cut through a wall-less footprint split by walls: check walls inside footprint.
  const grid = buildNavGrid({ ...layout, furniture: [] });
  for (const a of cells)
    for (const b of cells)
      if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1 && wallBetween(grid, a.x, a.z, b.x, b.z))
        return { ok: false, reason: 'Furniture cannot straddle a wall.' };
  for (const p of itemPoints(f)) {
    if (!inBounds(layout, p.tx, p.tz)) return { ok: false, reason: 'Its usable side faces outside the office.' };
    if (p.kind === 'stand' && occupied.get(`${p.tx},${p.tz}`) === 'B') return { ok: false, reason: 'Its usable side is blocked.' };
  }
  return checkEssentialRoutes({ ...layout, furniture: [...others, f] });
}

export function validateWalls(layout: OfficeLayout, walls: Wall[]) {
  return checkEssentialRoutes({ ...layout, walls });
}

let uidCounter = 0;
export const newUid = (prefix = 'f') => `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;

/** Resize the office, keeping content anchored at the top-left (x/z origin), optionally shifting. */
export function resizeLayout(layout: OfficeLayout, side: 'north' | 'south' | 'east' | 'west', delta: 1 | -1): OfficeLayout | string {
  const horizontal = side === 'east' || side === 'west';
  const width = layout.width + (horizontal ? delta : 0);
  const depth = layout.depth + (horizontal ? 0 : delta);
  if (width < MIN_SIZE || depth < MIN_SIZE || width > MAX_SIZE || depth > MAX_SIZE) return `Office size must stay between ${MIN_SIZE} and ${MAX_SIZE} tiles.`;
  const sx = side === 'west' ? delta : 0;
  const sz = side === 'north' ? delta : 0;
  const tiles: TileData[] = [];
  for (let z = 0; z < depth; z++)
    for (let x = 0; x < width; x++) {
      const ox = x - sx;
      const oz = z - sz;
      const nx = Math.min(Math.max(ox, 0), layout.width - 1);
      const nz = Math.min(Math.max(oz, 0), layout.depth - 1);
      const src = layout.tiles[tileIndex(layout, nx, nz)];
      tiles.push(inBounds(layout, ox, oz) ? { ...src } : { floor: src.floor, roomId: src.roomId });
    }
  const furniture = layout.furniture.map((f) => ({ ...f, x: f.x + sx, z: f.z + sz }));
  const shifted = { ...layout, width, depth, tiles, furniture, entrance: { x: layout.entrance.x + sx, z: layout.entrance.z + sz } };
  for (const f of furniture) if (itemCells(f).some((c) => !inBounds(shifted, c.x, c.z))) return 'Move furniture away from that edge first.';
  if (!inBounds(shifted, shifted.entrance.x, shifted.entrance.z)) return 'The entrance is on that edge.';
  // Move walls; rebuild the perimeter so the outer shell stays closed.
  const isPerimeter = (w: Wall) =>
    (w.side === 'n' && (w.z === 0 || w.z === layout.depth)) || (w.side === 'w' && (w.x === 0 || w.x === layout.width));
  const interior = layout.walls
    .filter((w) => !isPerimeter(w))
    .map((w) => ({ ...w, x: w.x + sx, z: w.z + sz }))
    .filter((w) => (w.side === 'n' ? w.z > 0 && w.z < depth && w.x >= 0 && w.x < width : w.x > 0 && w.x < width && w.z >= 0 && w.z < depth));
  const oldPerimeter = new Map(layout.walls.filter(isPerimeter).map((w) => [perimeterSlot(layout, w), w.kind]));
  const walls = [...interior, ...perimeterWalls(width, depth, (slot) => remapSlot(oldPerimeter, slot, side, delta))];
  const result = { ...shifted, walls };
  const check = checkEssentialRoutes(result);
  return check.ok ? result : check.reason;
}

type Slot = { edge: 'north' | 'south' | 'east' | 'west'; i: number };
function perimeterSlot(layout: { width: number; depth: number }, w: Wall): string {
  if (w.side === 'n') return `${w.z === 0 ? 'north' : 'south'}:${w.x}`;
  return `${w.x === 0 ? 'west' : 'east'}:${w.z}`;
}
function remapSlot(old: Map<string, WallKind>, slot: Slot, side: string, delta: number): WallKind {
  const shift = (side === 'west' && (slot.edge === 'north' || slot.edge === 'south')) || (side === 'north' && (slot.edge === 'east' || slot.edge === 'west')) ? delta : 0;
  return old.get(`${slot.edge}:${slot.i - shift}`) ?? 'wall';
}
export function perimeterWalls(width: number, depth: number, kindOf: (slot: Slot) => WallKind): Wall[] {
  const out: Wall[] = [];
  for (let x = 0; x < width; x++) {
    out.push({ x, z: 0, side: 'n', kind: kindOf({ edge: 'north', i: x }) });
    out.push({ x, z: depth, side: 'n', kind: kindOf({ edge: 'south', i: x }) });
  }
  for (let z = 0; z < depth; z++) {
    out.push({ x: 0, z, side: 'w', kind: kindOf({ edge: 'west', i: z }) });
    out.push({ x: width, z, side: 'w', kind: kindOf({ edge: 'east', i: z }) });
  }
  return out;
}

export const isPerimeterWall = (layout: { width: number; depth: number }, w: Pick<Wall, 'x' | 'z' | 'side'>) =>
  (w.side === 'n' && (w.z === 0 || w.z === layout.depth)) || (w.side === 'w' && (w.x === 0 || w.x === layout.width));

// ---------------------------------------------------------------------------------------------
// Default office (16 × 12)
// ---------------------------------------------------------------------------------------------

export const defaultRooms: Room[] = [
  { id: 'room-work', name: 'Main Work Area', type: 'work' },
  { id: 'room-chief', name: "Chief's Office", type: 'executive' },
  { id: 'room-meeting', name: 'Meeting Room', type: 'meeting' },
  { id: 'room-common', name: 'Common Area', type: 'common' },
];

export function createDefaultLayout(): OfficeLayout {
  const width = 16;
  const depth = 12;
  const tiles: TileData[] = [];
  const rect = (x: number, z: number, x0: number, z0: number, x1: number, z1: number) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  for (let z = 0; z < depth; z++)
    for (let x = 0; x < width; x++) {
      let floor: FloorType = 'tile';
      let roomId = 'room-work';
      if (rect(x, z, 0, 0, 4, 4)) [floor, roomId] = ['wood', 'room-chief'];
      else if (rect(x, z, 11, 0, 15, 4)) [floor, roomId] = ['carpetBlue', 'room-meeting'];
      else if (rect(x, z, 11, 7, 15, 11)) [floor, roomId] = ['woodLight', 'room-common'];
      tiles.push({ floor, roomId });
    }
  const windows = { north: [1, 3, 6, 8, 9, 12, 14], west: [2, 6, 9], south: [3, 11, 14], east: [2, 9] };
  const walls: Wall[] = perimeterWalls(width, depth, ({ edge, i }) => {
    if (edge === 'south' && i === 7) return 'door';
    return windows[edge].includes(i) ? 'window' : 'wall';
  });
  for (let z = 0; z <= 4; z++) walls.push({ x: 5, z, side: 'w', kind: z === 3 ? 'door' : 'glass' });
  for (let x = 0; x <= 4; x++) walls.push({ x, z: 5, side: 'n', kind: 'glass' });
  for (let z = 0; z <= 4; z++) walls.push({ x: 11, z, side: 'w', kind: z === 3 ? 'door' : 'glass' });
  for (let x = 11; x <= 15; x++) walls.push({ x, z: 5, side: 'n', kind: 'glass' });
  for (let z = 9; z <= 11; z++) walls.push({ x: 11, z, side: 'w', kind: 'partition' });

  const furniture: FurnitureItem[] = [];
  const add = (uid: string, catalogId: string, x: number, z: number, rot: Rotation = 0) => furniture.push({ uid, catalogId, x, z, rot });
  // Chief's office
  add('chief-desk', 'exec_desk', 1, 0, 2);
  add('chief-guest-1', 'chair_guest', 1, 2);
  add('chief-guest-2', 'chair_guest', 2, 2);
  add('chief-shelf', 'bookshelf', 3, 0);
  add('chief-plant', 'plant_big', 4, 4);
  add('chief-plant-2', 'plant_small', 0, 4);
  add('chief-lamp', 'lamp_floor', 4, 2);
  // Meeting room
  add('meet-table', 'conference_table', 12, 0);
  add('meet-screen', 'screen_present', 13, 4, 2);
  add('meet-plant', 'plant_small', 15, 4);
  // Common area
  add('lounge-sofa', 'sofa', 12, 7);
  add('lounge-rug', 'rug', 12, 8);
  add('lounge-table', 'table_coffee', 12, 8);
  add('lounge-armchair', 'armchair', 14, 9, 1);
  add('lounge-coffee', 'coffee_machine', 15, 10, 1);
  add('lounge-water', 'water_dispenser', 15, 11, 1);
  add('lounge-vending', 'vending_machine', 15, 7, 1);
  add('lounge-plant', 'plant_big', 11, 11);
  add('lounge-palm', 'plant_palm', 15, 8);
  // Work area
  const desks = ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5'];
  desks.forEach((uid, i) => add(uid, 'workstation', 1 + i * 2, 7));
  add('work-printer', 'printer', 6, 0);
  add('work-server', 'server_rack', 5, 0);
  add('work-cabinet', 'cabinet_file', 7, 0);
  add('work-cabinet-2', 'cabinet_file', 8, 0);
  add('work-shelf', 'bookshelf', 9, 0);
  add('work-board', 'whiteboard', 6, 4);
  add('work-plant', 'plant_big', 0, 11);
  add('work-plant-2', 'plant_small', 0, 7);
  add('work-palm', 'plant_palm', 10, 11);
  add('work-lamp', 'lamp_floor', 0, 9);
  add('work-plant-3', 'plant_small', 10, 5);

  return {
    version: 1,
    name: 'Pixel Office',
    width,
    depth,
    tiles,
    rooms: defaultRooms.map((r) => ({ ...r })),
    walls,
    furniture,
    deskAssignments: {
      'mock-chief-01': 'chief-desk',
      'mock-review-06': 'desk-1',
      'mock-research-02': 'desk-2',
      'mock-strategy-03': 'desk-3',
      'mock-execution-04': 'desk-4',
      'mock-visual-05': 'desk-5',
    },
    entrance: { x: 7, z: 11 },
  };
}
