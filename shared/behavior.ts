import { allPoints, buildNavGrid, canStep, cellAt, reachable, roomAt, tileIndex, type NavGrid, type WorldPoint } from './layout';
import { findPath, nearestFree, type Tile } from './pathfinding';
import { createRng, type Rng } from './rng';
import type { OfficeLayout, Trait } from './types';

/** Visual behaviour state. Independent from real task status: walking never implies work. */
export const visualStates = [
  'IDLE',
  'WANDERING',
  'WALKING_TO_DESK',
  'WORKING',
  'THINKING',
  'TALKING',
  'MEETING',
  'BREAK',
  'COMPLETED',
  'ERROR',
  'OFFLINE',
] as const;
export type VisualState = (typeof visualStates)[number];

/** What the task layer asks of a Bot. Derived only from verified task/meeting state. */
export type Directive =
  | { mode: 'idle' }
  | { mode: 'work'; taskId: string }
  | { mode: 'meeting'; meetingId: string; seatId?: string }
  | { mode: 'offline' };

export type Pose = 'stand' | 'walk' | 'sit';

type Goal = {
  tile: Tile;
  facing?: number;
  pose: 'sit' | 'stand';
  pointId?: string;
  purpose: 'desk' | 'meeting' | 'break' | 'look' | 'wander' | 'chat' | 'guest' | 'deskIdle';
};

export const traitParams: Record<Trait, { speed: number; wait: [number, number]; social: number; wander: number; brk: number }> = {
  energetic: { speed: 2.7, wait: [2, 5], social: 0.3, wander: 0.35, brk: 0.2 },
  calm: { speed: 1.7, wait: [6, 12], social: 0.15, wander: 0.15, brk: 0.35 },
  curious: { speed: 2.2, wait: [3, 7], social: 0.2, wander: 0.45, brk: 0.2 },
  sociable: { speed: 2.2, wait: [3, 7], social: 0.5, wander: 0.15, brk: 0.25 },
  focused: { speed: 2.0, wait: [7, 14], social: 0.1, wander: 0.1, brk: 0.25 },
};

export class AgentBrain {
  x: number;
  z: number;
  facing = 0;
  pose: Pose = 'stand';
  state: VisualState = 'IDLE';
  path: Tile[] = [];
  pathIndex = 0;
  goal?: Goal;
  /** Seconds remaining in the current activity. */
  timer = 0;
  flash?: { state: 'COMPLETED' | 'ERROR'; t: number };
  partner?: string;
  directiveKey = 'idle';
  blockedFor = 0;
  thinkTimer = 10;
  /** Animation phase helpers for the renderer. */
  moving = false;
  speed: number;
  /** Last navigation version this brain planned against. */
  navSeen = -1;

  constructor(
    readonly id: string,
    readonly trait: Trait,
    start: Tile,
    readonly isChief = false,
  ) {
    this.x = start.x + 0.5;
    this.z = start.z + 0.5;
    this.speed = traitParams[trait].speed;
  }

  get tile(): Tile {
    return { x: Math.floor(this.x), z: Math.floor(this.z) };
  }

  /** Called when a verified completion / failure arrives. */
  notify(kind: 'completed' | 'failed') {
    this.flash = { state: kind === 'completed' ? 'COMPLETED' : 'ERROR', t: 2.8 };
  }

  atGoal() {
    return !!this.goal && this.pathIndex >= this.path.length && Math.floor(this.x) === this.goal.tile.x && Math.floor(this.z) === this.goal.tile.z;
  }
}

export type SocialEvent = { kind: 'chat'; a: string; b: string } | { kind: 'arrive'; botId: string; purpose: Goal['purpose']; pointId?: string };

/** Owns navigation data, reservations and all brains; advanced once per frame. */
export class OfficeWorld {
  grid!: NavGrid;
  points: WorldPoint[] = [];
  pointById = new Map<string, WorldPoint>();
  reachableMask!: Uint8Array;
  navVersion = 0;
  layout!: OfficeLayout;
  brains = new Map<string, AgentBrain>();
  reservations = new Map<string, string>();
  directives = new Map<string, Directive>();
  paused = false;
  rng: Rng;
  listeners: ((e: SocialEvent) => void)[] = [];

  constructor(layout: OfficeLayout, seed = 1) {
    this.rng = createRng(seed);
    this.setLayout(layout);
  }

  on(fn: (e: SocialEvent) => void) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }
  private emit(e: SocialEvent) {
    for (const l of this.listeners) l(e);
  }

  setLayout(layout: OfficeLayout) {
    this.layout = layout;
    this.grid = buildNavGrid(layout);
    this.points = allPoints(layout);
    this.pointById = new Map(this.points.map((p) => [p.id, p]));
    this.reachableMask = reachable(this.grid, layout.entrance);
    this.navVersion++;
    for (const [pid] of this.reservations) if (!this.pointById.has(pid)) this.reservations.delete(pid);
  }

  addBot(id: string, trait: Trait, isChief = false) {
    const desk = this.deskOf(id);
    const start = desk ? { x: desk.tx, z: desk.tz } : nearestFree(this.grid, this.layout.entrance.x, this.layout.entrance.z) ?? this.layout.entrance;
    const b = new AgentBrain(id, trait, start, isChief);
    b.timer = this.rng.range(0.5, 3);
    if (desk) {
      b.pose = 'sit';
      b.facing = desk.worldFacing;
      b.goal = { tile: start, facing: desk.worldFacing, pose: 'sit', pointId: desk.id, purpose: 'deskIdle' };
      this.reservations.set(desk.id, id);
    }
    this.brains.set(id, b);
    return b;
  }

  deskOf(botId: string) {
    const uid = this.layout.deskAssignments[botId];
    return uid ? this.points.find((p) => p.uid === uid && p.kind === 'desk') : undefined;
  }

  isReachable(t: Tile) {
    return t.x >= 0 && t.z >= 0 && t.x < this.grid.width && t.z < this.grid.depth && this.reachableMask[tileIndex(this.grid, t.x, t.z)] === 1;
  }

  setDirective(botId: string, d: Directive) {
    this.directives.set(botId, d);
  }

  private release(b: AgentBrain) {
    for (const [pid, owner] of this.reservations) if (owner === b.id && pid !== b.goal?.pointId) this.reservations.delete(pid);
  }

  private penalty = (self: AgentBrain) => (i: number) => {
    let p = 0;
    for (const o of this.brains.values()) {
      if (o === self) continue;
      const oi = Math.floor(o.z) * this.grid.width + Math.floor(o.x);
      if (oi === i) p += o.moving ? 1.5 : 8;
    }
    return p;
  };

  /** Route a brain to a goal; returns false if unreachable. */
  goTo(b: AgentBrain, goal: Goal): boolean {
    if (goal.pointId) {
      const owner = this.reservations.get(goal.pointId);
      if (owner && owner !== b.id) return false;
    }
    let from = b.tile;
    if (cellAt(this.grid, from.x, from.z) === 2) {
      const free = nearestFree(this.grid, from.x, from.z);
      if (!free) return false;
      b.x = free.x + 0.5;
      b.z = free.z + 0.5;
      from = free;
    }
    const path = findPath(this.grid, from, goal.tile, { penalty: this.penalty(b) });
    if (!path) return false;
    if (b.goal?.pointId && b.goal.pointId !== goal.pointId && this.reservations.get(b.goal.pointId) === b.id) this.reservations.delete(b.goal.pointId);
    if (goal.pointId) this.reservations.set(goal.pointId, b.id);
    b.goal = goal;
    b.path = path.slice(1);
    b.pathIndex = 0;
    b.pose = b.path.length ? 'walk' : goal.pose;
    if (!b.path.length && goal.facing !== undefined) b.facing = goal.facing;
    b.blockedFor = 0;
    return true;
  }

  private pointGoal(p: WorldPoint, purpose: Goal['purpose']): Goal {
    return { tile: { x: p.tx, z: p.tz }, facing: p.worldFacing, pose: p.pose, pointId: p.id, purpose };
  }

  update(dt: number) {
    if (this.paused) return;
    dt = Math.min(dt, 0.1);
    for (const b of this.brains.values()) this.think(b, dt);
    for (const b of this.brains.values()) this.move(b, dt);
  }

  private think(b: AgentBrain, dt: number) {
    const d = this.directives.get(b.id) ?? { mode: 'idle' };
    const key = d.mode === 'work' ? `work:${d.taskId}` : d.mode === 'meeting' ? `meeting:${d.meetingId}:${d.seatId ?? ''}` : d.mode;
    const changed = key !== b.directiveKey;
    const modeChanged = changed && key.split(':')[0] !== b.directiveKey.split(':')[0];
    b.directiveKey = key;
    if (b.flash) {
      b.flash.t -= dt;
      if (b.flash.t <= 0) b.flash = undefined;
    }
    if (this.repathNeeded(b)) this.repath(b);

    if (d.mode === 'offline') {
      b.state = 'OFFLINE';
      return;
    }
    if (d.mode === 'meeting') {
      this.endChat(b);
      const seat = d.seatId ? this.pointById.get(d.seatId) : undefined;
      if (changed || !b.goal || (b.goal.purpose !== 'meeting' && !b.path.length)) {
        if (seat) this.goTo(b, this.pointGoal(seat, 'meeting'));
        else {
          // No seat left: stand near the meeting room entrance.
          const tile = this.standingSpot(d.meetingId);
          if (tile) this.goTo(b, { tile, pose: 'stand', purpose: 'meeting' });
        }
      }
      b.state = 'MEETING';
      return;
    }
    if (b.flash && d.mode !== 'work') {
      b.state = b.flash.state;
      return;
    }
    if (d.mode === 'work') {
      this.endChat(b);
      const desk = this.deskOf(b.id);
      if (desk && b.goal?.pointId !== desk.id) this.goTo(b, this.pointGoal(desk, 'desk'));
      else if (desk && b.goal) b.goal.purpose = 'desk';
      if (b.path.length > b.pathIndex) {
        b.state = 'WALKING_TO_DESK';
        return;
      }
      b.thinkTimer -= dt;
      if (b.state === 'THINKING') {
        if (b.thinkTimer <= 0) {
          b.state = 'WORKING';
          b.thinkTimer = this.rng.range(8, 18);
        }
      } else {
        b.state = 'WORKING';
        if (b.thinkTimer <= 0) {
          b.state = 'THINKING';
          b.thinkTimer = this.rng.range(2, 4);
        }
      }
      if (b.flash) b.state = b.flash.state;
      return;
    }
    // idle
    if (modeChanged) {
      b.timer = this.rng.range(1, 3);
      if (b.goal?.purpose === 'desk') b.goal.purpose = 'deskIdle';
    }
    this.idle(b, dt);
  }

  private repathNeeded(b: AgentBrain) {
    return b.navSeen !== this.navVersion;
  }
  private repath(b: AgentBrain) {
    b.navSeen = this.navVersion;
    if (!b.goal) return;
    const pointOk = !b.goal.pointId || this.pointById.has(b.goal.pointId);
    if (b.goal.pointId && pointOk) {
      const p = this.pointById.get(b.goal.pointId)!;
      b.goal.tile = { x: p.tx, z: p.tz };
      b.goal.facing = p.worldFacing;
    }
    if (!pointOk || !this.goTo(b, b.goal)) {
      if (b.goal.pointId && this.reservations.get(b.goal.pointId) === b.id) this.reservations.delete(b.goal.pointId);
      b.goal = undefined;
      b.path = [];
      b.pose = 'stand';
      if (cellAt(this.grid, b.tile.x, b.tile.z) === 2) {
        const free = nearestFree(this.grid, b.tile.x, b.tile.z);
        if (free) {
          b.x = free.x + 0.5;
          b.z = free.z + 0.5;
        }
      }
    }
  }

  private standingSpot(meetingId: string): Tile | undefined {
    void meetingId;
    const room = this.layout.rooms.find((r) => r.type === 'meeting');
    if (!room) return undefined;
    const candidates: Tile[] = [];
    for (let z = 0; z < this.grid.depth; z++)
      for (let x = 0; x < this.grid.width; x++)
        if (this.layout.tiles[tileIndex(this.layout, x, z)].roomId === room.id && this.grid.cells[tileIndex(this.grid, x, z)] === 0 && this.isReachable({ x, z }))
          candidates.push({ x, z });
    const taken = new Set([...this.brains.values()].map((o) => `${o.goal?.tile.x},${o.goal?.tile.z}`));
    return candidates.find((t) => !taken.has(`${t.x},${t.z}`)) ?? candidates[0];
  }

  private endChat(b: AgentBrain) {
    if (!b.partner) return;
    const p = this.brains.get(b.partner);
    b.partner = undefined;
    if (p && p.partner === b.id) {
      p.partner = undefined;
      p.timer = this.rng.range(2, 5);
      if (p.state === 'TALKING') p.state = 'IDLE';
    }
  }

  private idleBusy(b: AgentBrain) {
    const d = this.directives.get(b.id);
    return (d && d.mode !== 'idle') || !!b.flash || !!b.partner;
  }

  private idle(b: AgentBrain, dt: number) {
    const walking = b.path.length > b.pathIndex;
    if (b.partner) {
      const p = this.brains.get(b.partner);
      if (!p || p.partner !== b.id) {
        b.partner = undefined;
      } else {
        if (!walking) {
          b.facing = Math.atan2(p.x - b.x, p.z - b.z);
          if (!p.path.length || p.pathIndex >= p.path.length) b.timer -= dt;
        }
        b.state = 'TALKING';
        if (b.timer <= 0) this.endChat(b);
        return;
      }
    }
    if (walking) {
      b.state = 'WANDERING';
      return;
    }
    const purpose = b.goal?.purpose;
    b.state = purpose === 'break' ? 'BREAK' : purpose === 'look' || purpose === 'wander' ? 'WANDERING' : 'IDLE';
    b.timer -= dt;
    if (b.timer > 0) return;
    this.chooseActivity(b);
  }

  private chooseActivity(b: AgentBrain) {
    const tp = traitParams[b.trait];
    const r = this.rng.next();
    const free = (p: WorldPoint) => !this.reservations.has(p.id) && this.isReachable({ x: p.tx, z: p.tz });
    const pickPoint = (filter: (p: WorldPoint) => boolean) => {
      const list = this.points.filter((p) => filter(p) && free(p));
      return list.length ? this.rng.pick(list) : undefined;
    };
    let ok = false;
    let wait = this.rng.range(...tp.wait);
    if (r < tp.social) ok = this.startChat(b);
    if (!ok && r < tp.social + tp.brk) {
      const p = pickPoint((p) => !!p.tags?.includes('break'));
      if (p) ok = this.goTo(b, this.pointGoal(p, 'break'));
      wait += this.rng.range(4, 9);
    }
    if (!ok && !b.isChief && r < tp.social + tp.brk + 0.08) {
      const chief = [...this.brains.values()].find((o) => o.isChief);
      const chiefRoom = chief?.goal?.pointId ? roomAt(this.layout, chief.tile.x, chief.tile.z) : undefined;
      if (chief && chiefRoom?.type === 'executive') {
        const p = pickPoint((p) => !!p.tags?.includes('guest') && roomAt(this.layout, p.tx, p.tz)?.id === chiefRoom.id);
        if (p) ok = this.goTo(b, this.pointGoal(p, 'guest'));
      }
    }
    if (!ok && r < tp.social + tp.brk + tp.wander) {
      const look = this.rng.chance(0.6) ? pickPoint((p) => !!p.tags?.includes('look')) : undefined;
      if (look) ok = this.goTo(b, this.pointGoal(look, 'look'));
      else {
        const tile = this.randomFloorTile(b);
        if (tile) ok = this.goTo(b, { tile, pose: 'stand', purpose: 'wander' });
      }
    }
    if (!ok) {
      const desk = this.deskOf(b.id);
      if (desk && b.goal?.pointId !== desk.id) this.goTo(b, this.pointGoal(desk, 'deskIdle'));
      wait += 4;
    }
    b.timer = wait;
  }

  private randomFloorTile(b: AgentBrain): Tile | undefined {
    for (let i = 0; i < 30; i++) {
      const x = this.rng.int(0, this.grid.width - 1);
      const z = this.rng.int(0, this.grid.depth - 1);
      if (this.grid.cells[tileIndex(this.grid, x, z)] !== 0 || !this.isReachable({ x, z })) continue;
      const room = roomAt(this.layout, x, z);
      if (room?.type === 'executive' && !b.isChief) continue;
      if (room?.type === 'meeting') continue;
      if ([...this.brains.values()].some((o) => o !== b && o.goal && o.goal.tile.x === x && o.goal.tile.z === z)) continue;
      return { x, z };
    }
    return undefined;
  }

  private startChat(b: AgentBrain) {
    const candidates = [...this.brains.values()].filter(
      (o) => o !== b && !this.idleBusy(o) && !(o.path.length > o.pathIndex) && o.state !== 'OFFLINE' && !o.isChief,
    );
    if (!candidates.length) return false;
    const p = this.rng.pick(candidates);
    // Walk to a free tile next to the partner.
    const spots: Tile[] = [];
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const t = { x: p.tile.x + dx, z: p.tile.z + dz };
      if (cellAt(this.grid, t.x, t.z) === 0 && canStep(this.grid, p.tile.x, p.tile.z, t.x, t.z) && this.isReachable(t)) spots.push(t);
    }
    spots.sort((s1, s2) => Math.hypot(s1.x - b.x, s1.z - b.z) - Math.hypot(s2.x - b.x, s2.z - b.z));
    for (const s of spots) {
      if (this.goTo(b, { tile: s, pose: 'stand', purpose: 'chat' })) {
        b.partner = p.id;
        p.partner = b.id;
        const t = this.rng.range(5, 9);
        b.timer = t;
        p.timer = t;
        p.state = 'TALKING';
        this.emit({ kind: 'chat', a: b.id, b: p.id });
        return true;
      }
    }
    return false;
  }

  private move(b: AgentBrain, dt: number) {
    b.moving = false;
    if (b.state === 'OFFLINE') return;
    if (b.pathIndex >= b.path.length) {
      if (b.goal && b.path.length) {
        // Arrived.
        b.path = [];
        b.pathIndex = 0;
        b.pose = b.goal.pose;
        if (b.goal.facing !== undefined) b.facing = b.goal.facing;
        this.emit({ kind: 'arrive', botId: b.id, purpose: b.goal.purpose, pointId: b.goal.pointId });
      }
      return;
    }
    const next = b.path[b.pathIndex];
    const tx = next.x + 0.5;
    const tz = next.z + 0.5;
    const dx = tx - b.x;
    const dz = tz - b.z;
    const dist = Math.hypot(dx, dz);
    // Local avoidance: yield to a stationary character standing on the next tile.
    const blocker = [...this.brains.values()].find(
      (o) => o !== b && !o.moving && o.pose !== 'sit' && Math.floor(o.x) === next.x && Math.floor(o.z) === next.z && b.pathIndex < b.path.length - 1,
    );
    if (blocker && dist < 0.9) {
      b.blockedFor += dt;
      if (b.blockedFor > 0.7 && b.goal) {
        b.blockedFor = 0;
        this.goTo(b, b.goal);
      }
      return;
    }
    const step = b.speed * dt;
    b.moving = true;
    b.pose = 'walk';
    b.facing = Math.atan2(dx, dz);
    if (dist <= step) {
      b.x = tx;
      b.z = tz;
      b.pathIndex++;
    } else {
      b.x += (dx / dist) * step;
      b.z += (dz / dist) * step;
    }
  }
}
