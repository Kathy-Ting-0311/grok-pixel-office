import { canStep, cellAt, type NavGrid } from './layout';

export type Tile = { x: number; z: number };

const SQRT2 = Math.SQRT2;
const SEAT_COST = 6;

/** Binary min-heap keyed by f-score. */
class Heap {
  private items: number[] = [];
  private scores: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, score: number) {
    const a = this.items;
    const s = this.scores;
    a.push(item);
    s.push(score);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (s[p] <= s[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [s[p], s[i]] = [s[i], s[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const s = this.scores;
    const top = a[0];
    const lastItem = a.pop()!;
    const lastScore = s.pop()!;
    if (a.length) {
      a[0] = lastItem;
      s[0] = lastScore;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && s[l] < s[m]) m = l;
        if (r < a.length && s[r] < s[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [s[m], s[i]] = [s[i], s[m]];
        i = m;
      }
    }
    return top;
  }
}

export type PathOptions = {
  /** Extra cost per tile index, e.g. tiles occupied by other characters. */
  penalty?: (index: number) => number;
  maxIterations?: number;
};

/**
 * Grid A* (8-neighbourhood, octile heuristic, no corner cutting, walls on edges).
 * Seat tiles are walkable but expensive, so characters use aisles and only cross chairs when needed.
 * Returns the tile sequence including start and goal, or null if unreachable.
 */
export function findPath(grid: NavGrid, start: Tile, goal: Tile, options: PathOptions = {}): Tile[] | null {
  const { width, depth } = grid;
  if (cellAt(grid, goal.x, goal.z) === 2) return null;
  if (start.x < 0 || start.z < 0 || start.x >= width || start.z >= depth) return null;
  const startI = start.z * width + start.x;
  const goalI = goal.z * width + goal.x;
  if (startI === goalI) return [{ ...start }];
  const g = new Float64Array(width * depth).fill(Infinity);
  const from = new Int32Array(width * depth).fill(-1);
  const closed = new Uint8Array(width * depth);
  const h = (x: number, z: number) => {
    const dx = Math.abs(x - goal.x);
    const dz = Math.abs(z - goal.z);
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  };
  const open = new Heap();
  g[startI] = 0;
  open.push(startI, h(start.x, start.z));
  const max = options.maxIterations ?? width * depth * 8;
  let iterations = 0;
  while (open.size && iterations++ < max) {
    const i = open.pop();
    if (closed[i]) continue;
    if (i === goalI) break;
    closed[i] = 1;
    const x = i % width;
    const z = (i - x) / width;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
        const ni = nz * width + nx;
        if (closed[ni] || !canStep(grid, x, z, nx, nz)) continue;
        let cost = dx && dz ? SQRT2 : 1;
        if (grid.cells[ni] === 1 && ni !== goalI) cost += SEAT_COST;
        if (options.penalty) cost += options.penalty(ni);
        const ng = g[i] + cost;
        if (ng < g[ni]) {
          g[ni] = ng;
          from[ni] = i;
          open.push(ni, ng + h(nx, nz));
        }
      }
  }
  if (from[goalI] === -1) return null;
  const path: Tile[] = [];
  for (let i = goalI; i !== -1; i = from[i]) {
    const x = i % width;
    path.push({ x, z: (i - x) / width });
    if (i === startI) break;
  }
  path.reverse();
  return path[0].x === start.x && path[0].z === start.z ? path : null;
}

/** Nearest walkable free tile to (x,z) by BFS ring search (used when a character ends up inside furniture). */
export function nearestFree(grid: NavGrid, x: number, z: number): Tile | null {
  for (let r = 0; r < Math.max(grid.width, grid.depth); r++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (cellAt(grid, x + dx, z + dz) === 0) return { x: x + dx, z: z + dz };
      }
  return null;
}
