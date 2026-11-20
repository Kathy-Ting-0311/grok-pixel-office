import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Appearance, Bot } from '../../../shared/types';
import { world } from '../systems/world';
import { useStore } from '../store';
import { faceTexture } from './textures';
import { glowMat, mat, unitBox } from './materials';

/** Screen-anchor registry read by the DOM overlay. */
export const headAnchors = new Map<string, THREE.Vector3>();

type Part = { pos: [number, number, number]; size: [number, number, number]; color: string };

function hairParts(a: Appearance): Part[] {
  const c = a.hairColor;
  switch (a.hairStyle) {
    case 'bald':
      return [];
    case 'short':
      return [
        { pos: [0, 0.235, 0], size: [0.47, 0.08, 0.47], color: c },
        { pos: [0, 0.1, -0.2], size: [0.47, 0.28, 0.08], color: c },
        { pos: [0, 0.19, 0.2], size: [0.47, 0.07, 0.08], color: c },
      ];
    case 'spiky':
      return [
        { pos: [0, 0.24, 0], size: [0.47, 0.08, 0.47], color: c },
        { pos: [-0.12, 0.31, 0.05], size: [0.1, 0.1, 0.1], color: c },
        { pos: [0.1, 0.32, -0.05], size: [0.1, 0.12, 0.1], color: c },
        { pos: [0, 0.3, 0.14], size: [0.1, 0.08, 0.1], color: c },
        { pos: [0, 0.1, -0.2], size: [0.47, 0.28, 0.08], color: c },
        { pos: [0, 0.19, 0.2], size: [0.47, 0.07, 0.08], color: c },
      ];
    case 'bob':
      return [
        { pos: [0, 0.24, 0], size: [0.49, 0.09, 0.49], color: c },
        { pos: [0, 0.02, -0.2], size: [0.5, 0.42, 0.1], color: c },
        { pos: [-0.23, 0.02, 0], size: [0.06, 0.42, 0.48], color: c },
        { pos: [0.23, 0.02, 0], size: [0.06, 0.42, 0.48], color: c },
        { pos: [0, 0.18, 0.21], size: [0.49, 0.1, 0.06], color: c },
      ];
    case 'long':
      return [
        { pos: [0, 0.24, 0], size: [0.49, 0.09, 0.49], color: c },
        { pos: [0, -0.08, -0.21], size: [0.5, 0.62, 0.1], color: c },
        { pos: [-0.23, 0.0, -0.02], size: [0.06, 0.48, 0.44], color: c },
        { pos: [0.23, 0.0, -0.02], size: [0.06, 0.48, 0.44], color: c },
        { pos: [0, 0.18, 0.21], size: [0.49, 0.1, 0.06], color: c },
      ];
    case 'bun':
      return [
        { pos: [0, 0.24, 0], size: [0.48, 0.08, 0.48], color: c },
        { pos: [0, 0.36, -0.1], size: [0.2, 0.18, 0.2], color: c },
        { pos: [0, 0.1, -0.2], size: [0.48, 0.28, 0.08], color: c },
        { pos: [0, 0.19, 0.2], size: [0.48, 0.07, 0.08], color: c },
      ];
  }
}

function hatParts(a: Appearance, botColor: string): Part[] {
  switch (a.hat) {
    case 'cap':
      return [
        { pos: [0, 0.29, 0], size: [0.5, 0.1, 0.5], color: botColor },
        { pos: [0, 0.25, 0.3], size: [0.4, 0.04, 0.18], color: botColor },
      ];
    case 'beanie':
      return [
        { pos: [0, 0.28, 0], size: [0.5, 0.14, 0.5], color: '#7C3AED' },
        { pos: [0, 0.2, 0], size: [0.52, 0.06, 0.52], color: '#6D28D9' },
        { pos: [0, 0.38, 0], size: [0.1, 0.08, 0.1], color: '#F3EEE4' },
      ];
    case 'crown':
      return [
        { pos: [0, 0.31, 0], size: [0.36, 0.1, 0.36], color: '#F6C945' },
        { pos: [-0.14, 0.39, 0.14], size: [0.07, 0.08, 0.07], color: '#F6C945' },
        { pos: [0.14, 0.39, 0.14], size: [0.07, 0.08, 0.07], color: '#F6C945' },
        { pos: [0, 0.39, 0.14], size: [0.06, 0.1, 0.06], color: '#E11D48' },
      ];
    case 'headphones':
      return [
        { pos: [0, 0.3, 0], size: [0.52, 0.05, 0.1], color: '#1F2937' },
        { pos: [-0.26, 0.05, 0], size: [0.07, 0.16, 0.16], color: '#EF4444' },
        { pos: [0.26, 0.05, 0], size: [0.07, 0.16, 0.16], color: '#EF4444' },
      ];
    default:
      return [];
  }
}

function bodyExtras(a: Appearance): Part[] {
  const out: Part[] = [];
  if (a.top === 'suit') {
    out.push({ pos: [0, 0.03, 0.125], size: [0.12, 0.28, 0.02], color: '#F3EEE4' });
  }
  if (a.top === 'hoodie')
    out.push({ pos: [0, 0.15, -0.14], size: [0.3, 0.12, 0.06], color: a.topColor });
  if (a.top === 'dress')
    out.push({ pos: [0, -0.16, 0], size: [0.44, 0.12, 0.3], color: a.topColor });
  if (a.accessory === 'tie')
    out.push({ pos: [0, 0.02, 0.135], size: [0.06, 0.22, 0.02], color: '#B91C1C' });
  if (a.accessory === 'scarf')
    out.push({ pos: [0, 0.16, 0], size: [0.4, 0.07, 0.3], color: '#F59E0B' });
  if (a.accessory === 'badge')
    out.push({ pos: [0.1, 0.08, 0.13], size: [0.07, 0.09, 0.02], color: '#FDE68A' });
  if (a.accessory === 'backpack')
    out.push({ pos: [0, 0.0, -0.18], size: [0.3, 0.3, 0.12], color: '#2563EB' });
  return out;
}

function Box({ p }: { p: Part }) {
  return <mesh geometry={unitBox} material={mat(p.color)} position={p.pos} scale={p.size} />;
}

const tmp = new THREE.Vector3();
const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export const Character = memo(function Character({
  bot,
  appearance,
}: {
  bot: Bot;
  appearance: Appearance;
}) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const faceMesh = useRef<THREE.Mesh>(null);
  const phase = useRef(Math.random() * 10);
  const blink = useRef(0);

  const headMaterials = useMemo(() => {
    const skin = mat(appearance.skin);
    const face = new THREE.MeshLambertMaterial({ map: faceTexture(appearance) });
    return [skin, skin, skin, skin, face, skin];
  }, [appearance]);
  const blinkTex = useMemo(() => faceTexture(appearance, true), [appearance]);
  const openTex = useMemo(() => faceTexture(appearance, false), [appearance]);

  const hair = useMemo(() => hairParts(appearance), [appearance]);
  const hat = useMemo(() => hatParts(appearance, bot.color), [appearance, bot.color]);
  const extras = useMemo(() => bodyExtras(appearance), [appearance]);
  useEffect(() => () => void headAnchors.delete(bot.id), [bot.id]);

  useFrame((state, dt) => {
    const b = world.brains.get(bot.id);
    if (!b || !root.current) return;
    const t = (phase.current += dt);
    const r = root.current;
    const seated = b.pose === 'sit' && !b.moving;
    // Seat offset: lean slightly into the desk/table.
    const fx = Math.sin(b.facing);
    const fz = Math.cos(b.facing);
    const sitOffset = seated ? 0.12 : 0;
    r.position.x = THREE.MathUtils.damp(r.position.x, b.x + fx * sitOffset, 18, dt);
    r.position.z = THREE.MathUtils.damp(r.position.z, b.z + fz * sitOffset, 18, dt);
    r.rotation.y = lerpAngle(r.rotation.y, b.facing, Math.min(1, dt * 12));

    const walk = b.moving ? Math.sin(t * b.speed * 5.5) : 0;
    let y = seated ? 0.18 : 0;
    let legRot = 0;
    let armLRot = 0;
    let armRRot = 0;
    let headYaw = 0;
    let headPitch = 0;
    let bodyRoll = 0;
    if (b.moving) {
      legRot = walk * 0.7;
      armLRot = -walk * 0.6;
      armRRot = walk * 0.6;
      y += Math.abs(Math.cos(t * b.speed * 5.5)) * 0.04;
    } else if (seated) {
      legRot = -Math.PI / 2;
      if (b.state === 'WORKING') {
        armLRot = -1.15 + Math.sin(t * 22) * 0.08;
        armRRot = -1.15 + Math.sin(t * 22 + 1.7) * 0.08;
        headPitch = 0.12;
      } else if (b.state === 'THINKING') {
        armRRot = -2.2;
        headYaw = Math.sin(t * 0.8) * 0.3;
        headPitch = -0.15;
      } else if (b.state === 'MEETING') {
        armLRot = -0.4;
        armRRot = -0.4;
        headPitch = Math.sin(t * 1.3) * 0.08;
        headYaw = Math.sin(t * 0.5) * 0.4;
      } else {
        armLRot = -0.3;
        armRRot = -0.3;
        headYaw = Math.sin(t * 0.4) * 0.25;
      }
    } else {
      switch (b.state) {
        case 'TALKING':
          headPitch = Math.sin(t * 6) * 0.07;
          armRRot = -0.5 + Math.sin(t * 3) * 0.4;
          break;
        case 'COMPLETED':
          y += Math.max(0, Math.sin(t * 9)) * 0.22;
          armLRot = -2.8;
          armRRot = -2.8;
          break;
        case 'ERROR':
          headYaw = Math.sin(t * 14) * 0.35;
          armLRot = -0.3;
          armRRot = -0.3;
          break;
        case 'BREAK':
          armRRot = -1.3;
          headPitch = Math.sin(t * 0.8) * 0.05;
          break;
        default: {
          const idle = appearance.idle;
          if (idle === 'sway') bodyRoll = Math.sin(t * 1.6) * 0.05;
          if (idle === 'bounce') y += Math.abs(Math.sin(t * 3)) * 0.03;
          if (idle === 'look') headYaw = Math.sin(t * 0.7) * 0.6;
          if (idle === 'stretch' && Math.sin(t * 0.5) > 0.85) {
            armLRot = -2.9;
            armRRot = -2.9;
          }
        }
      }
    }
    r.position.y = THREE.MathUtils.damp(r.position.y, y, 20, dt);
    const k = Math.min(1, dt * 14);
    legL.current!.rotation.x = THREE.MathUtils.lerp(
      legL.current!.rotation.x,
      seated ? legRot : legRot,
      k,
    );
    legR.current!.rotation.x = THREE.MathUtils.lerp(
      legR.current!.rotation.x,
      seated ? legRot : -legRot,
      k,
    );
    armL.current!.rotation.x = THREE.MathUtils.lerp(armL.current!.rotation.x, armLRot, k);
    armR.current!.rotation.x = THREE.MathUtils.lerp(armR.current!.rotation.x, armRRot, k);
    head.current!.rotation.y = THREE.MathUtils.lerp(head.current!.rotation.y, headYaw, k);
    head.current!.rotation.x = THREE.MathUtils.lerp(head.current!.rotation.x, headPitch, k);
    body.current!.rotation.z = THREE.MathUtils.lerp(body.current!.rotation.z, bodyRoll, k);
    r.visible = true;

    // Blink every few seconds.
    blink.current -= dt;
    const fm = (faceMesh.current?.material as THREE.Material[] | undefined)?.[4] as
      THREE.MeshLambertMaterial | undefined;
    if (fm) {
      const closed = blink.current < 0.12 || b.state === 'OFFLINE';
      const want = closed ? blinkTex : openTex;
      if (fm.map !== want) {
        fm.map = want;
        fm.needsUpdate = true;
      }
      if (blink.current < 0) blink.current = 2.5 + Math.random() * 3;
    }
    const sel = useStore.getState().selection;
    if (ring.current) ring.current.visible = sel?.kind === 'bot' && sel.id === bot.id;
    let anchor = headAnchors.get(bot.id);
    if (!anchor) headAnchors.set(bot.id, (anchor = new THREE.Vector3()));
    anchor.set(r.position.x, r.position.y + 1.22, r.position.z);
    void state;
    void tmp;
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const s = useStore.getState();
    if (s.mode === 'build') return;
    s.select({ kind: 'bot', id: bot.id });
  };
  const onDouble = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const s = useStore.getState();
    s.select({ kind: 'bot', id: bot.id });
    s.focus({ kind: 'bot', id: bot.id });
    s.setFollow(bot.id);
  };

  const shoe = mat(appearance.shoes);
  const pants = mat(appearance.bottomColor);
  const top = mat(appearance.topColor);
  const skin = mat(appearance.skin);
  return (
    <group ref={root} onClick={onClick} onDoubleClick={onDouble} name={`bot-${bot.id}`}>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.02, 0]} visible={false}>
        <ringGeometry args={[0.32, 0.4, 24]} />
        <primitive object={glowMat('#FBBF24')} attach="material" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.011, 0]}>
        <circleGeometry args={[0.24, 16]} />
        <primitive object={glowMat('#000000', 0.18)} attach="material" />
      </mesh>
      <group ref={body}>
        {/* legs pivot at hips */}
        <group ref={legL} position={[-0.085, 0.28, 0]}>
          <mesh
            geometry={unitBox}
            material={pants}
            position={[0, -0.13, 0]}
            scale={[0.13, 0.26, 0.14]}
          />
          <mesh
            geometry={unitBox}
            material={shoe}
            position={[0, -0.255, 0.025]}
            scale={[0.14, 0.05, 0.19]}
          />
        </group>
        <group ref={legR} position={[0.085, 0.28, 0]}>
          <mesh
            geometry={unitBox}
            material={pants}
            position={[0, -0.13, 0]}
            scale={[0.13, 0.26, 0.14]}
          />
          <mesh
            geometry={unitBox}
            material={shoe}
            position={[0, -0.255, 0.025]}
            scale={[0.14, 0.05, 0.19]}
          />
        </group>
        <group position={[0, 0.45, 0]}>
          <mesh geometry={unitBox} material={top} scale={[0.36, 0.34, 0.24]} />
          {extras.map((p, i) => (
            <Box key={i} p={p} />
          ))}
        </group>
        <group ref={armL} position={[-0.235, 0.6, 0]}>
          <mesh
            geometry={unitBox}
            material={top}
            position={[0, -0.12, 0]}
            scale={[0.1, 0.26, 0.12]}
          />
          <mesh
            geometry={unitBox}
            material={skin}
            position={[0, -0.28, 0]}
            scale={[0.09, 0.07, 0.1]}
          />
        </group>
        <group ref={armR} position={[0.235, 0.6, 0]}>
          <mesh
            geometry={unitBox}
            material={top}
            position={[0, -0.12, 0]}
            scale={[0.1, 0.26, 0.12]}
          />
          <mesh
            geometry={unitBox}
            material={skin}
            position={[0, -0.28, 0]}
            scale={[0.09, 0.07, 0.1]}
          />
        </group>
        <group ref={head} position={[0, 0.84, 0]}>
          <mesh
            ref={faceMesh}
            geometry={unitBox}
            material={headMaterials}
            scale={[0.44, 0.42, 0.42]}
          />
          {hair.map((p, i) => (
            <Box key={`h${i}`} p={p} />
          ))}
          {hat.map((p, i) => (
            <Box key={`t${i}`} p={p} />
          ))}
        </group>
      </group>
    </group>
  );
});

/** Standalone preview used by the customisation panel (no brain; idles in place). */
export function PreviewCharacter({ bot, appearance }: { bot: Bot; appearance: Appearance }) {
  const group = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.6;
  });
  const hair = hairParts(appearance);
  const hat = hatParts(appearance, bot.color);
  const extras = bodyExtras(appearance);
  const face = useMemo(
    () => new THREE.MeshLambertMaterial({ map: faceTexture(appearance) }),
    [appearance],
  );
  const skin = mat(appearance.skin);
  const headMats = [skin, skin, skin, skin, face, skin];
  return (
    <group ref={group} position={[0, -0.55, 0]}>
      {[-0.085, 0.085].map((x) => (
        <group key={x} position={[x, 0.28, 0]}>
          <mesh
            geometry={unitBox}
            material={mat(appearance.bottomColor)}
            position={[0, -0.13, 0]}
            scale={[0.13, 0.26, 0.14]}
          />
          <mesh
            geometry={unitBox}
            material={mat(appearance.shoes)}
            position={[0, -0.255, 0.025]}
            scale={[0.14, 0.05, 0.19]}
          />
        </group>
      ))}
      <group position={[0, 0.45, 0]}>
        <mesh geometry={unitBox} material={mat(appearance.topColor)} scale={[0.36, 0.34, 0.24]} />
        {extras.map((p, i) => (
          <Box key={i} p={p} />
        ))}
      </group>
      {[-0.235, 0.235].map((x) => (
        <group key={x} position={[x, 0.6, 0]}>
          <mesh
            geometry={unitBox}
            material={mat(appearance.topColor)}
            position={[0, -0.12, 0]}
            scale={[0.1, 0.26, 0.12]}
          />
          <mesh
            geometry={unitBox}
            material={skin}
            position={[0, -0.28, 0]}
            scale={[0.09, 0.07, 0.1]}
          />
        </group>
      ))}
      <group position={[0, 0.84, 0]}>
        <mesh geometry={unitBox} material={headMats} scale={[0.44, 0.42, 0.42]} />
        {hair.map((p, i) => (
          <Box key={`h${i}`} p={p} />
        ))}
        {hat.map((p, i) => (
          <Box key={`t${i}`} p={p} />
        ))}
      </group>
    </group>
  );
}
