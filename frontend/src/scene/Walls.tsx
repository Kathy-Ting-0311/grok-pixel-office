import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isPerimeterWall } from '../../../shared/layout';
import type { OfficeLayout, Wall } from '../../../shared/types';
import { useStore } from '../store';

const H = 2.2;
const LOW = 0.32;
const T = 0.14;
const WALL = '#EFE2C8';
const CAP = '#8B6B4A';
const BASE = '#B08A62';
const FRAME = '#5B4636';

type Seg = { x0: number; z0: number; x1: number; z1: number };

function boxFor(seg: Seg, y0: number, y1: number, color: string, thick = T) {
  const along = seg.x1 !== seg.x0 ? 'x' : 'z';
  const len = along === 'x' ? Math.abs(seg.x1 - seg.x0) : Math.abs(seg.z1 - seg.z0);
  const w = along === 'x' ? len : thick;
  const d = along === 'x' ? thick : len;
  const g = new THREE.BoxGeometry(w, y1 - y0, d);
  g.translate((seg.x0 + seg.x1) / 2, (y0 + y1) / 2, (seg.z0 + seg.z1) / 2);
  const c = new THREE.Color(color);
  const n = g.getAttribute('normal');
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const f = n.getY(i) > 0.5 ? 1.05 : Math.abs(n.getX(i)) > 0.5 ? 0.88 : 0.96;
    col.set([Math.min(1, c.r * f), Math.min(1, c.g * f), Math.min(1, c.b * f)], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function segOf(w: Wall): Seg {
  return w.side === 'n'
    ? { x0: w.x, z0: w.z, x1: w.x + 1, z1: w.z }
    : { x0: w.x, z0: w.z, x1: w.x, z1: w.z + 1 };
}

/** Which perimeter sides face the camera (rendered low so the interior stays visible). */
export type FrontSides = { north: boolean; south: boolean; east: boolean; west: boolean };

function buildWalls(layout: OfficeLayout, front: FrontSides, interiorHeight: number) {
  const solid: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const isFront = (w: Wall) =>
    (w.side === 'n' && w.z === 0 && front.north) ||
    (w.side === 'n' && w.z === layout.depth && front.south) ||
    (w.side === 'w' && w.x === 0 && front.west) ||
    (w.side === 'w' && w.x === layout.width && front.east);
  for (const w of layout.walls) {
    const seg = segOf(w);
    const perimeter = isPerimeterWall(layout, w);
    const low = perimeter && isFront(w);
    const top = perimeter
      ? low
        ? LOW
        : H
      : w.kind === 'partition'
        ? 0.95
        : w.kind === 'glass'
          ? Math.max(interiorHeight, 1.4)
          : interiorHeight;
    const post = (x: number, z: number, y1: number) => {
      const s =
        seg.x1 !== seg.x0
          ? { x0: x - 0.05, z0: z, x1: x + 0.05, z1: z }
          : { x0: x, z0: z - 0.05, x1: x, z1: z + 0.05 };
      solid.push(boxFor(s, 0, y1, FRAME, T + 0.02));
    };
    switch (w.kind) {
      case 'wall':
      case 'partition':
        solid.push(boxFor(seg, 0, top, w.kind === 'partition' ? '#C9B79A' : WALL));
        solid.push(boxFor(seg, top, top + 0.05, CAP, T + 0.02));
        if (top > 0.5) solid.push(boxFor(seg, 0, 0.12, BASE, T + 0.03));
        break;
      case 'window':
        if (low) {
          solid.push(boxFor(seg, 0, LOW, WALL), boxFor(seg, LOW, LOW + 0.05, CAP, T + 0.02));
        } else {
          solid.push(
            boxFor(seg, 0, 0.85, WALL),
            boxFor(seg, 0.85, 0.92, CAP, T + 0.06),
            boxFor(seg, 1.85, H, WALL),
            boxFor(seg, H, H + 0.05, CAP, T + 0.02),
          );
          solid.push(boxFor(seg, 0, 0.12, BASE, T + 0.03));
          glass.push(boxFor(seg, 0.92, 1.85, '#BFE3F2', 0.04));
          post(seg.x0 + (seg.x1 - seg.x0) / 2, seg.z0 + (seg.z1 - seg.z0) / 2, 1.85);
        }
        break;
      case 'glass':
        glass.push(boxFor(seg, 0.08, top, '#CDEBF5', 0.05));
        solid.push(boxFor(seg, 0, 0.08, FRAME, T), boxFor(seg, top, top + 0.05, FRAME, T));
        post(seg.x0, seg.z0, top);
        break;
      case 'door': {
        const y = low ? LOW : Math.min(top, 1.95);
        post(seg.x0 + (seg.x1 - seg.x0) * 0.04, seg.z0 + (seg.z1 - seg.z0) * 0.04, y);
        post(seg.x1 - (seg.x1 - seg.x0) * 0.04, seg.z1 - (seg.z1 - seg.z0) * 0.04, y);
        if (!low) {
          solid.push(
            boxFor(seg, 1.95, top, perimeter ? WALL : '#D8C8AA'),
            boxFor(seg, top, top + 0.05, CAP, T + 0.02),
          );
          solid.push(boxFor(seg, 1.92, 1.97, FRAME, T + 0.02));
        }
        // Door mat
        const mat =
          w.side === 'n'
            ? { x0: seg.x0 + 0.15, z0: seg.z0, x1: seg.x1 - 0.15, z1: seg.z0 }
            : { x0: seg.x0, z0: seg.z0 + 0.15, x1: seg.x0, z1: seg.z1 - 0.15 };
        solid.push(boxFor(mat, 0, 0.015, '#7A4E2D', 0.5));
        break;
      }
    }
  }
  // Corner posts so perimeter corners look closed.
  for (const [x, z] of [
    [0, 0],
    [layout.width, 0],
    [0, layout.depth],
    [layout.width, layout.depth],
  ]) {
    const isLow = (z === 0 ? front.north : front.south) || (x === 0 ? front.west : front.east);
    const h = isLow ? LOW : H;
    solid.push(boxFor({ x0: x - 0.08, z0: z, x1: x + 0.08, z1: z }, 0, h + 0.05, CAP, 0.16));
  }
  return {
    solid: solid.length ? mergeGeometries(solid, false) : null,
    glass: glass.length ? mergeGeometries(glass, false) : null,
  };
}

const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const glassMat = new THREE.MeshLambertMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.32,
  depthWrite: false,
});

export function Walls() {
  const layout = useStore((s) => s.layout);
  const wallsMode = useStore((s) => s.settings.walls);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const [front, setFront] = useState<FrontSides>({
    north: false,
    west: false,
    south: true,
    east: true,
  });
  const frontRef = useRef(front);
  useFrame(({ camera }) => {
    const target = controls?.target ?? new THREE.Vector3(layout.width / 2, 0, layout.depth / 2);
    const dx = camera.position.x - target.x;
    const dz = camera.position.z - target.z;
    const next = { north: dz < -0.1, south: dz > 0.1, west: dx < -0.1, east: dx > 0.1 };
    const f = frontRef.current;
    if (
      next.north !== f.north ||
      next.south !== f.south ||
      next.east !== f.east ||
      next.west !== f.west
    ) {
      frontRef.current = next;
      setFront(next);
    }
  });
  const geo = useMemo(
    () => buildWalls(layout, front, wallsMode === 'full' ? H : 1.05),
    [layout, front, wallsMode],
  );
  useEffect(
    () => () => {
      geo.solid?.dispose();
      geo.glass?.dispose();
    },
    [geo],
  );
  return (
    <group>
      {geo.solid && <mesh geometry={geo.solid} material={solidMat} castShadow receiveShadow />}
      {geo.glass && <mesh geometry={geo.glass} material={glassMat} renderOrder={2} />}
    </group>
  );
}
