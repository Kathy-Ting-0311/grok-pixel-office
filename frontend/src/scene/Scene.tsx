import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { roster } from '../../../shared/roster';
import { useStore } from '../store';
import { stepReplay, world } from '../systems/world';
import { audio } from '../systems/audio';
import { CameraRig, cameraApi } from './CameraRig';
import { Character } from './Character';
import { Environment } from './Environment';
import { Floor } from './Floor';
import { FurnitureLayer } from './Furniture';
import { Walls } from './Walls';
import { BuildLayer, placeCatalogItem } from './BuildLayer';
import { HeadLabels, OverlaySync } from './Overlay';

/** Live renderer statistics for the performance overlay. */
export const perf = {
  fps: 0,
  calls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  characters: 0,
  programs: 0,
};

function Simulation() {
  useFrame((_, dt) => {
    world.update(dt);
    stepReplay(dt * 1000);
  });
  return null;
}

function PerfProbe() {
  const { gl } = useThree();
  const frames = useRef(0);
  const t = useRef(0);
  useFrame((_, dt) => {
    frames.current++;
    t.current += dt;
    if (t.current >= 0.5) {
      perf.fps = Math.round(frames.current / t.current);
      frames.current = 0;
      t.current = 0;
      perf.calls = gl.info.render.calls;
      perf.triangles = gl.info.render.triangles;
      perf.geometries = gl.info.memory.geometries;
      perf.textures = gl.info.memory.textures;
      perf.programs = gl.info.programs?.length ?? 0;
      perf.characters = world.brains.size;
    }
  }, 1);
  // Priority 1 means we render ourselves.
  useFrame(({ gl, scene, camera }) => gl.render(scene, camera), 2);
  return null;
}

function AudioDirector() {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const acc = useRef(0);
  const prevPose = useRef(new Map<string, string>());
  const v = useRef(new THREE.Vector3());
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.1 || !audio.ready) return;
    acc.current = 0;
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    const target = controls?.target;
    const anyMeeting = [...world.brains.values()].some(
      (b) => b.state === 'MEETING' && b.pose === 'sit',
    );
    for (const b of world.brains.values()) {
      v.current.set(b.x, 0.5, b.z).project(camera);
      const pan = THREE.MathUtils.clamp(v.current.x, -1, 1) * 0.7;
      const onScreen = Math.abs(v.current.x) < 1.2 && Math.abs(v.current.y) < 1.2;
      const dist = target ? Math.hypot(b.x - target.x, b.z - target.z) : 5;
      const vol = onScreen
        ? THREE.MathUtils.clamp(1.2 - dist / 14, 0.15, 1) *
          THREE.MathUtils.clamp(zoom / 60, 0.4, 1.3)
        : 0.08;
      if (b.state === 'WORKING' && b.pose === 'sit') audio.typing(b.id, pan, vol);
      if (b.moving) audio.footstep(b.id, pan, vol);
      const prev = prevPose.current.get(b.id);
      const now = `${b.pose}:${b.goal?.pointId ?? ''}`;
      if (prev && prev !== now && b.pose === 'sit') audio.chair(pan, vol);
      if (prev && prev !== now && b.pose === 'stand' && b.goal?.pointId) {
        const p = world.pointById.get(b.goal.pointId);
        if (p?.tags?.includes('drink')) audio.coffee(pan, vol);
        if (p?.tags?.includes('print')) audio.printer(pan, vol);
      }
      prevPose.current.set(b.id, now);
      if (b.state === 'TALKING' && Math.random() < 0.3) audio.murmur(pan, vol * 0.8);
    }
    if (anyMeeting && Math.random() < 0.4) audio.murmur(0, 0.5);
    void size;
  });
  return null;
}

function Characters() {
  const appearances = useStore((s) => s.appearances);
  return (
    <group>
      {roster.map((b) => (
        <Character key={b.id} bot={b} appearance={appearances[b.id]} />
      ))}
    </group>
  );
}

const dprFor = (q: string, pixel: boolean) => {
  const native = Math.min(window.devicePixelRatio || 1, 2);
  if (!pixel) return q === 'low' ? Math.min(1, native) : native;
  const base = q === 'low' ? 0.42 : q === 'medium' ? 0.55 : 0.7;
  // Phones have far fewer CSS pixels: keep the pixel grid fine enough to read, without going past native resolution.
  return window.innerWidth < 640 ? Math.min(native, base * 1.7) : base;
};

export function Scene() {
  const quality = useStore((s) => s.settings.quality);
  const pixel = useStore((s) => s.settings.pixelArt);
  const wrap = useRef<HTMLDivElement>(null);

  // Native HTML drag-and-drop from the furniture catalog onto the floor.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('application/x-furniture')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      const id = e.dataTransfer?.getData('application/x-furniture');
      if (!id) return;
      e.preventDefault();
      const t = cameraApi.pickTile?.(e.clientX, e.clientY);
      if (t) placeCatalogItem(id, t.x, t.z);
    };
    el.addEventListener('dragover', over);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragover', over);
      el.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div ref={wrap} className="absolute inset-0" data-testid="office-canvas">
      <Canvas
        shadows={quality === 'low' ? false : 'percentage'}
        dpr={dprFor(quality, pixel)}
        flat
        gl={{
          antialias: !pixel,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: false,
        }}
        style={{ imageRendering: pixel ? 'pixelated' : 'auto' }}
        onPointerMissed={() => {
          const s = useStore.getState();
          if (s.mode !== 'build') s.select(null);
        }}
      >
        <CameraRig />
        <Environment />
        <Floor />
        <Walls />
        <FurnitureLayer />
        <Characters />
        <BuildLayer />
        <Simulation />
        <OverlaySync />
        <AudioDirector />
        <PerfProbe />
      </Canvas>
      <HeadLabels />
    </div>
  );
}
