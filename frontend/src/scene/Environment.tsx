import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createRng } from '../../../shared/rng';
import { useStore, type Season } from '../store';
import { unitBox } from './materials';

export function resolveSeason(setting: 'auto' | Season, date = new Date()): Season {
  if (setting !== 'auto') return setting;
  const m = date.getMonth();
  return m >= 2 && m <= 4
    ? 'spring'
    : m >= 5 && m <= 7
      ? 'summer'
      : m >= 8 && m <= 10
        ? 'autumn'
        : 'winter';
}

export type Weather = 'clear' | 'rain' | 'snow' | 'clouds' | 'leaves' | 'petals';
/** 'auto' picks a seasonal ambience effect. It is decoration, NOT live weather. */
export function resolveWeather(setting: string, season: Season): Weather {
  if (setting !== 'auto') return setting as Weather;
  return { spring: 'petals', summer: 'clouds', autumn: 'leaves', winter: 'snow' }[
    season
  ] as Weather;
}

/** 0 = midnight, 0.5 = noon. */
export function dayPhase(mode: 'off' | 'clock' | 'fast', now = new Date()) {
  if (mode === 'off') return 0.6;
  if (mode === 'clock')
    return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  return (now.getTime() / (12 * 60 * 1000)) % 1;
}

const palettes: Record<
  Season,
  { grass: string; sky: string; sun: string; trees: string[]; canopy: number }
> = {
  spring: {
    grass: '#8FCB6B',
    sky: '#BFE3F7',
    sun: '#FFF3DE',
    trees: ['#F7A8C8', '#9FD47A', '#F4C2D7', '#86C766'],
    canopy: 1,
  },
  summer: {
    grass: '#6CBB4E',
    sky: '#A6D8F5',
    sun: '#FFF8E8',
    trees: ['#3F9E4A', '#4FB35A', '#2F8A3F', '#5CBF62'],
    canopy: 1.1,
  },
  autumn: {
    grass: '#B9A456',
    sky: '#F0DDB8',
    sun: '#FFD6A0',
    trees: ['#E07A2F', '#D9502B', '#E9B33A', '#B5651D'],
    canopy: 0.95,
  },
  winter: {
    grass: '#EDF2F6',
    sky: '#D3E2EC',
    sun: '#E4EEFF',
    trees: ['#F8FAFC', '#E2EAF2', '#FFFFFF', '#DCE6EF'],
    canopy: 0.55,
  },
};

const night = { sky: new THREE.Color('#1E2440'), sun: new THREE.Color('#8EA0D8') };

export function Environment() {
  const layout = useStore((s) => s.layout);
  const settings = useStore((s) => s.settings);
  const season = resolveSeason(settings.season);
  const weather = resolveWeather(settings.weather, season);
  const { scene, gl } = useThree();
  // Static scene shadows: re-render the shadow map only when something that casts them changes.
  const shadowDirty = useRef(true);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    shadowDirty.current = true;
  }, [gl, layout, season, settings.quality, settings.walls]);
  const shadowTimer = useRef(0);
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const ambient = useRef<THREE.AmbientLight>(null);
  // Created once; the season colour is updated in place below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groundMat = useMemo(() => new THREE.MeshLambertMaterial({ color: palettes[season].grass }), []);
  const sky = useMemo(() => new THREE.Color(palettes[season].sky), []); // eslint-disable-line react-hooks/exhaustive-deps
  const sunColor = useMemo(() => new THREE.Color(palettes[season].sun), []); // eslint-disable-line react-hooks/exhaustive-deps
  const canopyScale = useRef(palettes[season].canopy);
  const shadows = settings.quality !== 'low';
  const shadowSize = settings.quality === 'high' ? 2048 : 1024;

  // Trees around the office, deterministic.
  const trees = useMemo(() => {
    const rng = createRng(11);
    const out: { x: number; z: number; s: number }[] = [];
    let guard = 0;
    while (out.length < 46 && guard++ < 2000) {
      const x = rng.range(-9, layout.width + 9);
      const z = rng.range(-9, layout.depth + 9);
      const inside = x > -2 && x < layout.width + 2 && z > -2 && z < layout.depth + 2;
      const path = Math.abs(x - (layout.entrance.x + 0.5)) < 1.6 && z > layout.depth;
      if (inside || path || out.some((t) => Math.hypot(t.x - x, t.z - z) < 1.6)) continue;
      out.push({ x, z, s: rng.range(0.8, 1.35) });
    }
    return out;
  }, [layout.width, layout.depth, layout.entrance.x]);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const canopies = useRef<THREE.InstancedMesh>(null);
  const canopyTops = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const layoutTrees = (scale: number) => {
    trees.forEach((t, i) => {
      dummy.position.set(t.x, 0.5 * t.s, t.z);
      dummy.scale.set(0.25 * t.s, 1 * t.s, 0.25 * t.s);
      dummy.updateMatrix();
      trunks.current?.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, (1.1 + 0.45 * scale) * t.s, t.z);
      dummy.scale.set(1.3 * t.s * scale, 0.9 * t.s * scale, 1.3 * t.s * scale);
      dummy.updateMatrix();
      canopies.current?.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, (1.1 + 1.1 * scale) * t.s, t.z);
      dummy.scale.set(0.8 * t.s * scale, 0.5 * t.s * scale, 0.8 * t.s * scale);
      dummy.updateMatrix();
      canopyTops.current?.setMatrixAt(i, dummy.matrix);
    });
    for (const m of [trunks.current, canopies.current, canopyTops.current])
      if (m) m.instanceMatrix.needsUpdate = true;
  };

  useEffect(() => {
    const p = palettes[season];
    const c = new THREE.Color();
    trees.forEach((_, i) => {
      canopies.current?.setColorAt(i, c.set(p.trees[i % p.trees.length]));
      canopyTops.current?.setColorAt(
        i,
        c.set(p.trees[(i + 1) % p.trees.length]).offsetHSL(0, 0, 0.04),
      );
    });
    for (const m of [canopies.current, canopyTops.current])
      if (m?.instanceColor) m.instanceColor.needsUpdate = true;
    layoutTrees(canopyScale.current);
  }, [season, trees]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, dt) => {
    shadowTimer.current += dt;
    // Moving sun (day/night) or settling canopy: refresh at most ~4 Hz.
    if (shadowDirty.current || (settings.dayNight !== 'off' && shadowTimer.current > 0.25)) {
      gl.shadowMap.needsUpdate = true;
      shadowDirty.current = false;
      shadowTimer.current = 0;
    }
    const p = palettes[season];
    const phase = dayPhase(settings.dayNight);
    // daylight 0..1 from a smooth sunrise (6h) / sunset (18h)
    const daylight = THREE.MathUtils.smoothstep(
      Math.sin((phase - 0.25) * Math.PI * 2),
      -0.15,
      0.35,
    );
    const k = Math.min(1, dt * 1.5);
    const targetSky = new THREE.Color(p.sky).lerp(night.sky, 1 - daylight);
    sky.lerp(targetSky, k);
    scene.background = sky;
    groundMat.color.lerp(new THREE.Color(p.grass).lerp(night.sky, (1 - daylight) * 0.55), k);
    sunColor.lerp(new THREE.Color(p.sun).lerp(night.sun, 1 - daylight), k);
    const target = canopyScale.current + (p.canopy - canopyScale.current) * k;
    if (Math.abs(target - canopyScale.current) > 0.001) {
      canopyScale.current = target;
      layoutTrees(target);
      shadowDirty.current = true;
    }
    if (sun.current) {
      const ang = (phase - 0.25) * Math.PI * 2;
      const cx = layout.width / 2;
      const cz = layout.depth / 2;
      const elev = settings.dayNight === 'off' ? 0.9 : 0.35 + 0.65 * Math.max(0.1, Math.sin(ang));
      sun.current.position.set(cx + Math.cos(ang) * 14 + 6, 18 * elev + 4, cz + 12);
      sun.current.target.position.set(cx, 0, cz);
      sun.current.target.updateMatrixWorld();
      sun.current.color.copy(sunColor);
      sun.current.intensity = 0.35 + 1.25 * daylight;
    }
    if (hemi.current) hemi.current.intensity = 0.45 + 0.6 * daylight;
    if (ambient.current) ambient.current.intensity = 0.55 + 0.2 * (1 - daylight); // indoor lights at night
  });

  const half = Math.max(layout.width, layout.depth) / 2 + 4;
  return (
    <group>
      <hemisphereLight ref={hemi} args={['#FFF7E8', '#8A7A60', 0.9]} />
      <ambientLight ref={ambient} color="#FFE9C9" intensity={0.6} />
      <directionalLight
        ref={sun}
        castShadow={shadows}
        intensity={1.4}
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-bias={-0.0008}
        shadow-normalBias={0.02}
      />
      <mesh
        rotation-x={-Math.PI / 2}
        position={[layout.width / 2, -0.31, layout.depth / 2]}
        material={groundMat}
        receiveShadow
      >
        <planeGeometry args={[layout.width + 40, layout.depth + 40]} />
      </mesh>
      {/* Path from the entrance */}
      <mesh rotation-x={-Math.PI / 2} position={[layout.entrance.x + 0.5, -0.3, layout.depth + 5]}>
        <planeGeometry args={[1.6, 10]} />
        <meshLambertMaterial color="#C9B48E" />
      </mesh>
      <instancedMesh
        ref={trunks}
        args={[unitBox, undefined, trees.length]}
        castShadow={shadows}
        position-y={-0.3}
      >
        <meshLambertMaterial color="#7B5434" />
      </instancedMesh>
      <instancedMesh
        ref={canopies}
        args={[unitBox, undefined, trees.length]}
        castShadow={shadows}
        position-y={-0.3}
      >
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh
        ref={canopyTops}
        args={[unitBox, undefined, trees.length]}
        castShadow={shadows}
        position-y={-0.3}
      >
        <meshLambertMaterial />
      </instancedMesh>
      <Particles
        weather={weather}
        width={layout.width}
        depth={layout.depth}
        count={settings.quality === 'low' ? 150 : settings.quality === 'medium' ? 400 : 800}
      />
      {(weather === 'clouds' || weather === 'rain' || weather === 'snow') && (
        <Clouds width={layout.width} depth={layout.depth} dark={weather === 'rain'} />
      )}
    </group>
  );
}

function Clouds({ width, depth, dark }: { width: number; depth: number; dark: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const clouds = useMemo(() => {
    const rng = createRng(5);
    return Array.from({ length: 7 }, () => ({
      x: rng.range(-10, width + 10),
      z: rng.range(-12, depth),
      s: rng.range(1.5, 3),
    }));
  }, [width, depth]);
  useFrame((_, dt) => {
    ref.current?.children.forEach((c) => {
      c.position.x += dt * 0.4;
      if (c.position.x > width + 14) c.position.x = -14;
    });
  });
  return (
    <group ref={ref}>
      {clouds.map((c, i) => (
        <group key={i} position={[c.x, 9 + (i % 3), c.z]}>
          <mesh geometry={unitBox} scale={[c.s * 1.6, 0.5, c.s]}>
            <meshBasicMaterial color={dark ? '#C7CDD6' : '#FFFFFF'} transparent opacity={0.85} />
          </mesh>
          <mesh geometry={unitBox} position={[0.3, 0.35, 0]} scale={[c.s, 0.5, c.s * 0.7]}>
            <meshBasicMaterial color={dark ? '#D5DAE1' : '#FFFFFF'} transparent opacity={0.85} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const particleStyle: Record<
  Weather,
  { color: string; size: number; fall: number; drift: number } | null
> = {
  clear: null,
  clouds: null,
  rain: { color: '#9EC5E8', size: 3, fall: 7, drift: 0.2 },
  snow: { color: '#FFFFFF', size: 4, fall: 0.8, drift: 0.5 },
  leaves: { color: '#E07A2F', size: 5, fall: 0.9, drift: 1.2 },
  petals: { color: '#F9B4CF', size: 4, fall: 0.6, drift: 1.0 },
};

function Particles({
  weather,
  width,
  depth,
  count,
}: {
  weather: Weather;
  width: number;
  depth: number;
  count: number;
}) {
  const style = particleStyle[weather];
  const ref = useRef<THREE.Points>(null);
  const { positions, seeds } = useMemo(() => {
    const rng = createRng(3);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions.set(
        [rng.range(-10, width + 10), rng.range(0, 10), rng.range(-10, depth + 10)],
        i * 3,
      );
      seeds[i] = rng.next() * 10;
    }
    return { positions, seeds };
  }, [count, width, depth]);
  useFrame((state, dt) => {
    if (!style || !ref.current) return;
    const p = ref.current.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < count; i++) {
      let x = arr[i * 3];
      let y = arr[i * 3 + 1];
      let z = arr[i * 3 + 2];
      y -= style.fall * dt * (0.7 + (seeds[i] % 1) * 0.6);
      x += Math.sin(t * 0.8 + seeds[i]) * style.drift * dt;
      z += Math.cos(t * 0.6 + seeds[i]) * style.drift * dt * 0.5;
      // Recycle at the ground, and before entering the office footprint (conceptually it has a roof).
      // Keep the sky above the office clear so particles never read as being indoors.
      const inside = x > -1 && x < width + 1 && z > -1 && z < depth + 1;
      if (y < -0.3 || inside) {
        y = 10;
        x = -10 + ((seeds[i] * 977 + t * 13) % (width + 20));
        z = -10 + ((seeds[i] * 619 + t * 7) % (depth + 20));
      }
      arr[i * 3] = x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = z;
    }
    p.needsUpdate = true;
  });
  if (!style) return null;
  return (
    <points ref={ref} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={style.color}
        size={style.size}
        sizeAttenuation={false}
        transparent
        opacity={0.9}
        depthWrite={false}
      />
    </points>
  );
}
