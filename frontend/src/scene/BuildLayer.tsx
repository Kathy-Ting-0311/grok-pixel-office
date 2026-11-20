import { useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { cameraApi } from './CameraRig';
import { getCatalog } from '../../../shared/catalog';
import {
  edgeKey,
  inBounds,
  isPerimeterWall,
  newUid,
  rotatedSize,
  roomAt,
  tileIndex,
  validatePlacement,
  validateWalls,
  itemCells,
} from '../../../shared/layout';
import { canUse } from '../../../shared/progression';
import type { FurnitureItem, OfficeLayout, Wall } from '../../../shared/types';
import { useStore } from '../store';
import { Ghost } from './Furniture';
import { glowMat, unitBox } from './materials';

type Edge = { x: number; z: number; side: 'n' | 'w' };

/** Footprint origin so the hovered tile sits at the item's centre. */
export function originFor(catalogId: string, rot: 0 | 1 | 2 | 3, tx: number, tz: number) {
  const size = rotatedSize(getCatalog(catalogId), rot);
  return { x: tx - Math.floor((size.w - 1) / 2), z: tz - Math.floor((size.d - 1) / 2) };
}

function nearestEdge(fx: number, fz: number): Edge {
  const x = Math.floor(fx);
  const z = Math.floor(fz);
  const lx = fx - x;
  const lz = fz - z;
  const d = [
    { e: { x, z, side: 'n' as const }, v: lz },
    { e: { x, z: z + 1, side: 'n' as const }, v: 1 - lz },
    { e: { x, z, side: 'w' as const }, v: lx },
    { e: { x: x + 1, z, side: 'w' as const }, v: 1 - lx },
  ].sort((a, b) => a.v - b.v);
  return d[0].e;
}

export function tryPlace(layout: OfficeLayout, item: FurnitureItem, ignoreUid?: string) {
  return validatePlacement(layout, item, ignoreUid ?? item.uid);
}

/** Place a new catalog item at a hovered tile (used by click and HTML drag-and-drop). */
export function placeCatalogItem(catalogId: string, tx: number, tz: number) {
  const s = useStore.getState();
  if (!canUse(s.progression, catalogId)) {
    s.toast(`${getCatalog(catalogId).name} is locked — unlock it in the catalog.`, 'warn');
    return false;
  }
  const o = originFor(catalogId, s.build.rot, tx, tz);
  const item: FurnitureItem = { uid: newUid(), catalogId, x: o.x, z: o.z, rot: s.build.rot };
  const r = tryPlace(s.layout, item);
  if (!r.ok) {
    s.toast(r.reason, 'warn');
    return false;
  }
  s.commitLayout({ ...s.layout, furniture: [...s.layout.furniture, item] });
  if (r.warnings.length) s.setBuild({ warning: r.warnings[0] });
  return true;
}

export function BuildLayer() {
  const layout = useStore((s) => s.layout);
  const mode = useStore((s) => s.mode);
  const build = useStore((s) => s.build);
  const [hover, setHover] = useState<{ x: number; z: number; fx: number; fz: number } | null>(null);
  const painting = useRef<OfficeLayout | null>(null);
  const active = mode === 'build';

  const ghostItem = (() => {
    if (!active || !hover) return null;
    if (build.carrying) {
      const f = layout.furniture.find((x) => x.uid === build.carrying);
      if (!f) return null;
      const o = originFor(f.catalogId, build.rot, hover.x, hover.z);
      return { ...f, x: o.x, z: o.z, rot: build.rot };
    }
    if (build.tool === 'place' && build.catalogId) {
      const o = originFor(build.catalogId, build.rot, hover.x, hover.z);
      return { uid: '__ghost', catalogId: build.catalogId, x: o.x, z: o.z, rot: build.rot };
    }
    return null;
  })();
  const ghostValid = ghostItem
    ? tryPlace(layout, ghostItem, build.carrying ?? ghostItem.uid).ok
    : false;

  const paintTile = (base: OfficeLayout, x: number, z: number): OfficeLayout => {
    if (!inBounds(base, x, z)) return base;
    const i = tileIndex(base, x, z);
    const t = base.tiles[i];
    const s = useStore.getState().build;
    const next = s.tool === 'floor' ? { ...t, floor: s.floor } : { ...t, roomId: s.roomId ?? null };
    if (next.floor === t.floor && next.roomId === t.roomId) return base;
    const tiles = base.tiles.slice();
    tiles[i] = next;
    return { ...base, tiles };
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const x = Math.floor(e.point.x);
    const z = Math.floor(e.point.z);
    if (!hover || hover.x !== x || hover.z !== z || build.tool === 'wall')
      setHover({ x, z, fx: e.point.x, fz: e.point.z });
    if (painting.current) {
      painting.current = paintTile(painting.current, x, z);
      useStore.setState({ layout: painting.current });
    }
  };

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (!active || e.button !== 0) return;
    const s = useStore.getState();
    if (s.build.tool === 'floor' || s.build.tool === 'room') {
      if (s.build.tool === 'room' && !s.build.roomId) {
        s.toast('Choose or create a room first.', 'warn');
        return;
      }
      e.stopPropagation();
      cameraApi.setEnabled?.(false);
      const before = s.layout;
      painting.current = paintTile(before, Math.floor(e.point.x), Math.floor(e.point.z));
      useStore.setState({ layout: painting.current });
      const finish = () => {
        window.removeEventListener('pointerup', finish);
        cameraApi.setEnabled?.(true);
        const result = painting.current;
        painting.current = null;
        if (!result || result === before) return;
        useStore.setState({ layout: before });
        const check = validateWalls(result, result.walls);
        if (!check.ok) {
          s.toast(check.reason, 'warn');
          return;
        }
        useStore.getState().commitLayout(result);
      };
      window.addEventListener('pointerup', finish);
    } else if (s.build.carrying) cameraApi.setEnabled?.(false);
  };

  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const s = useStore.getState();
    if (!active || !s.build.carrying) return;
    cameraApi.setEnabled?.(true);
    e.stopPropagation();
    const f = s.layout.furniture.find((x) => x.uid === s.build.carrying);
    if (!f) return;
    const o = originFor(f.catalogId, s.build.rot, Math.floor(e.point.x), Math.floor(e.point.z));
    const moved = { ...f, x: o.x, z: o.z, rot: s.build.rot };
    s.setBuild({ carrying: undefined });
    if (moved.x === f.x && moved.z === f.z && moved.rot === f.rot) return;
    const r = tryPlace(s.layout, moved, f.uid);
    if (!r.ok) {
      s.toast(r.reason, 'warn');
      return;
    }
    s.commitLayout({
      ...s.layout,
      furniture: s.layout.furniture.map((x) => (x.uid === f.uid ? moved : x)),
    });
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    const s = useStore.getState();
    const x = Math.floor(e.point.x);
    const z = Math.floor(e.point.z);
    if (!active) {
      if (e.delta > 4) return;
      const room = roomAt(s.layout, x, z);
      s.select(room ? { kind: 'room', id: room.id } : null);
      return;
    }
    const tool = s.build.tool;
    if (tool === 'place' && s.build.catalogId) placeCatalogItem(s.build.catalogId, x, z);
    else if (tool === 'wall') applyWall(nearestEdge(e.point.x, e.point.z));
    else if (tool === 'erase') {
      const hit = s.layout.furniture.find((f) => itemCells(f).some((c) => c.x === x && c.z === z));
      if (hit) {
        const deskAssignments = Object.fromEntries(
          Object.entries(s.layout.deskAssignments).filter(([, u]) => u !== hit.uid),
        );
        s.commitLayout({
          ...s.layout,
          furniture: s.layout.furniture.filter((f) => f.uid !== hit.uid),
          deskAssignments,
        });
      }
    } else if (tool === 'select') {
      if (e.delta > 4) return;
      s.select(null);
    }
  };

  const applyWall = (edge: Edge) => {
    const s = useStore.getState();
    const L = s.layout;
    const valid =
      edge.side === 'n'
        ? edge.x >= 0 && edge.x < L.width && edge.z >= 0 && edge.z <= L.depth
        : edge.z >= 0 && edge.z < L.depth && edge.x >= 0 && edge.x <= L.width;
    if (!valid) return;
    const key = edgeKey(edge.x, edge.z, edge.side);
    const existing = L.walls.find((w) => edgeKey(w.x, w.z, w.side) === key);
    const perimeter = isPerimeterWall(L, edge);
    let walls: Wall[];
    const kind = s.build.wallKind;
    if (perimeter && (kind === 'glass' || kind === 'partition')) {
      s.toast('Outer walls can be a wall, window or door.', 'warn');
      return;
    }
    if (existing && existing.kind === kind) {
      if (perimeter) {
        s.toast('The outer shell stays closed — change it to a window or door instead.', 'warn');
        return;
      }
      walls = L.walls.filter((w) => w !== existing);
    } else if (existing) walls = L.walls.map((w) => (w === existing ? { ...w, kind } : w));
    else walls = [...L.walls, { ...edge, kind }];
    // A wall may not cut through furniture footprints.
    const crossing = L.furniture.some((f) => {
      const cells = itemCells(f);
      return cells.some((a) =>
        cells.some((b) =>
          edge.side === 'n'
            ? a.x === edge.x && b.x === edge.x && a.z === edge.z - 1 && b.z === edge.z
            : a.z === edge.z && b.z === edge.z && a.x === edge.x - 1 && b.x === edge.x,
        ),
      );
    });
    if (crossing && kind !== 'door') {
      s.toast('A wall cannot cut through furniture.', 'warn');
      return;
    }
    const check = validateWalls(L, walls);
    if (!check.ok) {
      s.toast(check.reason, 'warn');
      return;
    }
    s.commitLayout({ ...L, walls });
  };

  const edge = active && build.tool === 'wall' && hover ? nearestEdge(hover.fx, hover.fz) : null;
  const hoverValid = hover && inBounds(layout, hover.x, hover.z);
  return (
    <group>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[layout.width / 2, 0.005, layout.depth / 2]}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onClick={onClick}
        onPointerLeave={() => setHover(null)}
        name="pick-plane"
      >
        <planeGeometry args={[layout.width + 2, layout.depth + 2]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      {ghostItem && <Ghost item={ghostItem} ok={ghostValid} />}
      {active && hoverValid && !ghostItem && build.tool !== 'wall' && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[hover!.x + 0.5, 0.02, hover!.z + 0.5]}
          renderOrder={3}
        >
          <planeGeometry args={[0.96, 0.96]} />
          <primitive
            object={glowMat(build.tool === 'erase' ? '#F87171' : '#FDE68A', 0.45)}
            attach="material"
          />
        </mesh>
      )}
      {edge && (
        <mesh
          geometry={unitBox}
          material={glowMat('#FBBF24', 0.8)}
          position={edge.side === 'n' ? [edge.x + 0.5, 0.6, edge.z] : [edge.x, 0.6, edge.z + 0.5]}
          scale={edge.side === 'n' ? [1, 1.2, 0.18] : [0.18, 1.2, 1]}
        />
      )}
    </group>
  );
}
