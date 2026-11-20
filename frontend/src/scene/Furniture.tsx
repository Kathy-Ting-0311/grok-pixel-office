import { memo, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { itemCenter, rotationY } from '../../../shared/layout';
import { getCatalog } from '../../../shared/catalog';
import { botById } from '../../../shared/roster';
import type { FurnitureItem } from '../../../shared/types';
import { useStore } from '../store';
import { cameraApi } from './CameraRig';
import { world } from '../systems/world';
import { furnitureModel, vertexColorMaterial, type Overlay } from './voxels';
import { animateScreens, nameplateTexture, screenTexture } from './textures';
import { glowMat, unitBox, unitPlane } from './materials';

const screenMats = {
  work: new THREE.MeshBasicMaterial({ map: screenTexture('work'), toneMapped: false }),
  idle: new THREE.MeshBasicMaterial({ map: screenTexture('idle'), toneMapped: false }),
  off: new THREE.MeshBasicMaterial({ map: screenTexture('off'), toneMapped: false }),
  present: new THREE.MeshBasicMaterial({ map: screenTexture('present'), toneMapped: false }),
  arcade: new THREE.MeshBasicMaterial({ map: screenTexture('arcade'), toneMapped: false }),
};
/** Desk screens keyed by furniture uid, switched by the assigned Bot's state. */
const deskScreens = new Map<string, THREE.Mesh>();
const ledMats = ['#22C55E', '#38BDF8', '#F59E0B', '#16A34A'].map((c) => glowMat(c));
const ghostOk = new THREE.MeshBasicMaterial({
  color: '#4ADE80',
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
});
const ghostBad = new THREE.MeshBasicMaterial({
  color: '#F87171',
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
});
const highlight = new THREE.MeshBasicMaterial({
  color: '#FBBF24',
  wireframe: true,
  transparent: true,
  opacity: 0.9,
});

function OverlayMesh({ ov, uid }: { ov: Overlay; uid: string }) {
  const ref = useRef<THREE.Group>(null);
  const t0 = useMemo(() => Math.random() * 10, []);
  const deskOwner = useStore(
    (s) => Object.entries(s.layout.deskAssignments).find(([, u]) => u === uid)?.[0],
  );
  useFrame((state) => {
    const g = ref.current;
    if (!g) return;
    const t = state.clock.elapsedTime + t0;
    if (ov.kind === 'steam')
      g.children.forEach((c, i) => {
        const p = (t * 0.5 + i / 3) % 1;
        c.position.set(Math.sin(t * 2 + i) * 0.04, p * 0.45, 0);
        c.scale.setScalar(0.06 * (1 - p) + 0.02);
      });
    if (ov.kind === 'leds' && Math.floor(t * 4) % 2 === 0)
      g.children.forEach(
        (c, i) => ((c as THREE.Mesh).material = ledMats[(i + Math.floor(t * 3)) % ledMats.length]),
      );
    if (ov.kind === 'fish')
      g.children.forEach((c, i) => {
        if (ov.w === 0) {
          c.position.y = ((t * 0.3 + i * 0.33) % 1) * 0.3 - 0.1;
          return;
        }
        c.position.x = Math.sin(t * 0.6 + i * 2) * ov.w * 0.4;
        c.rotation.y = Math.cos(t * 0.6 + i * 2) > 0 ? 0 : Math.PI;
      });
  });
  switch (ov.kind) {
    case 'screen':
      return (
        <mesh
          ref={(m) => {
            if (m && ov.variant === 'desk') deskScreens.set(uid, m);
          }}
          geometry={unitPlane}
          material={ov.variant === 'desk' ? screenMats.idle : screenMats[ov.variant]}
          position={[ov.x, ov.y, ov.z]}
          rotation-y={ov.facing}
          scale={[ov.w, ov.h, 1]}
        />
      );
    case 'glow':
      return (
        <mesh
          geometry={unitBox}
          material={glowMat(ov.color)}
          position={[ov.x, ov.y, ov.z]}
          scale={[ov.w, ov.h, ov.d]}
        />
      );
    case 'leds':
      return (
        <group ref={ref} position={[ov.x, ov.y, ov.z]}>
          {Array.from({ length: 12 }, (_, i) => (
            <mesh
              key={i}
              geometry={unitBox}
              material={ledMats[i % 4]}
              position={[((i % 3) - 1) * 0.15, (Math.floor(i / 3) - 1.5) * 0.28 * (ov.h / 1.6), 0]}
              scale={[0.04, 0.03, 0.01]}
            />
          ))}
        </group>
      );
    case 'steam':
      return (
        <group ref={ref} position={[ov.x, ov.y, ov.z]}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} geometry={unitBox} material={glowMat('#FFFFFF', 0.7)} />
          ))}
        </group>
      );
    case 'fish':
      return (
        <group ref={ref} position={[ov.x, ov.y, ov.z]}>
          {(ov.w === 0 ? [0, 1, 2] : [0, 1]).map((i) => (
            <mesh
              key={i}
              geometry={unitBox}
              material={glowMat(ov.w === 0 ? '#DBEAFE' : i ? '#FB923C' : '#FDE047')}
              position={[0, i * 0.12, 0]}
              scale={ov.w === 0 ? [0.03, 0.03, 0.03] : [0.12, 0.07, 0.04]}
            />
          ))}
        </group>
      );
    case 'nameplate': {
      if (!deskOwner) return null;
      const bot = botById(deskOwner);
      if (!bot) return null;
      const initials = bot.name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 3)
        .toUpperCase();
      return (
        <mesh geometry={unitBox} position={[ov.x, ov.y + 0.03, ov.z]} scale={[0.32, 0.08, 0.03]}>
          <meshBasicMaterial map={nameplateTexture(initials, bot.color)} toneMapped={false} />
        </mesh>
      );
    }
  }
}

export const FurnitureMesh = memo(function FurnitureMesh({
  item,
  selected,
}: {
  item: FurnitureItem;
  selected: boolean;
}) {
  const model = furnitureModel(item.catalogId);
  const cat = getCatalog(item.catalogId);
  const c = itemCenter(item);
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    const s = useStore.getState();
    if (s.mode !== 'build' || e.button !== 0) return;
    e.stopPropagation();
    if (s.build.tool === 'erase') return;
    if (s.build.tool === 'select') {
      cameraApi.setEnabled?.(false);
      s.select({ kind: 'furniture', uid: item.uid });
      s.setBuild({ carrying: item.uid, rot: item.rot });
    }
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    const s = useStore.getState();
    if (s.mode === 'build') {
      e.stopPropagation();
      if (s.build.tool === 'erase') {
        const deskOwners = Object.entries(s.layout.deskAssignments).filter(
          ([, u]) => u === item.uid,
        );
        const deskAssignments = { ...s.layout.deskAssignments };
        deskOwners.forEach(([b]) => delete deskAssignments[b]);
        s.commitLayout(
          {
            ...s.layout,
            furniture: s.layout.furniture.filter((f) => f.uid !== item.uid),
            deskAssignments,
          },
          deskOwners.length ? 'Removed an assigned desk — that Bot now has no desk.' : undefined,
        );
        if (s.selection?.kind === 'furniture' && s.selection.uid === item.uid) s.select(null);
      }
      return;
    }
    if (e.delta > 4) return;
    e.stopPropagation();
    s.select({ kind: 'furniture', uid: item.uid });
  };
  const carrying = useStore((s) => s.build.carrying === item.uid);
  return (
    <group
      position={[c.x, 0, c.z]}
      rotation-y={rotationY(item.rot)}
      visible={!carrying}
      name={`f-${item.uid}`}
    >
      <mesh
        geometry={model.geometry}
        material={vertexColorMaterial}
        castShadow
        receiveShadow
        onPointerDown={onPointerDown}
        onClick={onClick}
      />
      {model.overlays.map((ov, i) => (
        <OverlayMesh key={i} ov={ov} uid={item.uid} />
      ))}
      {selected && (
        <mesh
          geometry={unitBox}
          material={highlight}
          position={[0, cat.height / 2, 0]}
          scale={[cat.w + 0.04, cat.height + 0.04, cat.d + 0.04]}
        />
      )}
    </group>
  );
});

export function Ghost({ item, ok }: { item: FurnitureItem; ok: boolean }) {
  const model = furnitureModel(item.catalogId);
  const c = itemCenter(item);
  return (
    <group position={[c.x, 0.01, c.z]} rotation-y={rotationY(item.rot)} renderOrder={10}>
      <mesh geometry={model.geometry} material={ok ? ghostOk : ghostBad} />
    </group>
  );
}

/** Switches desk screens between working / idle / off and animates screen textures (~6 Hz). */
export function ScreenController() {
  const acc = useRef(0);
  useFrame((state, dt) => {
    acc.current += dt;
    if (acc.current < 0.16) return;
    acc.current = 0;
    animateScreens(state.clock.elapsedTime);
    const layout = useStore.getState().layout;
    const owner = new Map(Object.entries(layout.deskAssignments).map(([b, u]) => [u, b]));
    for (const [uid, mesh] of deskScreens) {
      if (!mesh.parent) {
        deskScreens.delete(uid);
        continue;
      }
      const bot = owner.get(uid);
      const brain = bot ? world.brains.get(bot) : undefined;
      const atDesk = brain && brain.goal?.pointId?.startsWith(`${uid}#`) && brain.pose === 'sit';
      mesh.material = !brain
        ? screenMats.off
        : atDesk && (brain.state === 'WORKING' || brain.state === 'THINKING')
          ? screenMats.work
          : screenMats.idle;
    }
  });
  return null;
}

export function FurnitureLayer() {
  const furniture = useStore((s) => s.layout.furniture);
  const selected = useStore((s) =>
    s.selection?.kind === 'furniture' ? s.selection.uid : undefined,
  );
  return (
    <group>
      {furniture.map((f) => (
        <FurnitureMesh key={f.uid} item={f} selected={selected === f.uid} />
      ))}
      <ScreenController />
    </group>
  );
}
