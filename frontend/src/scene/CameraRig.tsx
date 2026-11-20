import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MapControls, OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import { useStore } from '../store';
import { world } from '../systems/world';

/** True isometric elevation (camera polar angle ≈ 54.7°). */
const POLAR = Math.acos(1 / Math.sqrt(3));
const DIST = 30;
export const ZOOM_MIN = 9;
export const ZOOM_MAX = 140;

/** Imperative helpers shared with DOM code (drag-and-drop picking, toolbar buttons). */
export const cameraApi: {
  pickTile?: (
    clientX: number,
    clientY: number,
  ) => { x: number; z: number; fx: number; fz: number } | null;
  rotate?: (dir: 1 | -1) => void;
  zoom?: (factor: number) => void;
  zoomLevel?: () => number;
  setEnabled?: (v: boolean) => void;
  project?: (x: number, y: number, z: number) => { x: number; y: number };
} = {};

export function CameraRig() {
  const controls = useRef<MapControlsImpl>(null);
  const { camera, size, gl } = useThree();
  const layout = useStore((s) => s.layout);
  const enableRotate = useStore((s) => s.settings.enableRotate);
  const goal = useRef<THREE.Vector3 | null>(null);
  const zoomGoal = useRef<number | null>(null);
  const azimuthGoal = useRef<number | null>(null);
  const request = useStore((s) => s.camera);

  const fitZoomFor = (w: number, h: number) =>
    Math.max(
      ZOOM_MIN,
      Math.min(
        ZOOM_MAX,
        0.9 *
          Math.min(
            w / ((layout.width + layout.depth) * 0.74 + 2),
            h / ((layout.width + layout.depth) * 0.42 + 3),
          ),
      ),
    );
  const fitZoom = () => fitZoomFor(size.width, size.height);
  // The camera below is created with this zoom, so the whole office fits on any screen from the first frame.
  const [initialZoom] = useState(() => fitZoomFor(window.innerWidth, window.innerHeight));

  // Initial placement.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const target = new THREE.Vector3(layout.width / 2, 0, layout.depth / 2);
    c.target.copy(target);
    const off = new THREE.Vector3().setFromSphericalCoords(DIST, POLAR, Math.PI / 4);
    camera.position.copy(target).add(off);
    (camera as THREE.OrthographicCamera).zoom = fitZoom();
    camera.updateProjectionMatrix();
    c.update();
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when a phone or tablet turns between portrait and landscape.
  const portrait = size.height > size.width;
  const firstOrientation = useRef(true);
  useEffect(() => {
    if (firstOrientation.current) {
      firstOrientation.current = false;
      return;
    }
    zoomGoal.current = fitZoom();
  }, [portrait]); // eslint-disable-line react-hooks/exhaustive-deps

  // Camera requests.
  useEffect(() => {
    if (!request) return;
    const s = useStore.getState();
    if (request.kind === 'reset') {
      goal.current = new THREE.Vector3(s.layout.width / 2, 0, s.layout.depth / 2);
      zoomGoal.current = fitZoom();
      azimuthGoal.current = Math.PI / 4;
      s.setFollow(undefined);
    } else if (request.kind === 'bot' && request.id) {
      const b = world.brains.get(request.id);
      if (b) goal.current = new THREE.Vector3(b.x, 0, b.z);
      zoomGoal.current = Math.max((camera as THREE.OrthographicCamera).zoom, 64);
    } else if (request.kind === 'room' && request.id) {
      let sx = 0;
      let sz = 0;
      let n = 0;
      s.layout.tiles.forEach((t, i) => {
        if (t.roomId !== request.id) return;
        sx += (i % s.layout.width) + 0.5;
        sz += Math.floor(i / s.layout.width) + 0.5;
        n++;
      });
      if (n) goal.current = new THREE.Vector3(sx / n, 0, sz / n);
      zoomGoal.current = Math.max((camera as THREE.OrthographicCamera).zoom, 52);
    } else if (request.kind === 'tile' && request.x !== undefined && request.z !== undefined) {
      goal.current = new THREE.Vector3(request.x, 0, request.z);
    }
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking + toolbar helpers.
  useEffect(() => {
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    cameraApi.pickTile = (clientX, clientY) => {
      const r = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - r.left) / r.width) * 2 - 1,
        -((clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      return { x: Math.floor(hit.x), z: Math.floor(hit.z), fx: hit.x, fz: hit.z };
    };
    cameraApi.rotate = (dir) => {
      const c = controls.current;
      if (!c) return;
      const cur = azimuthGoal.current ?? c.getAzimuthalAngle();
      azimuthGoal.current =
        Math.round((cur + (dir * Math.PI) / 2 - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) +
        Math.PI / 4;
    };
    cameraApi.zoom = (f) => {
      const cam = camera as THREE.OrthographicCamera;
      zoomGoal.current = THREE.MathUtils.clamp(
        (zoomGoal.current ?? cam.zoom) * f,
        ZOOM_MIN,
        ZOOM_MAX,
      );
    };
    cameraApi.zoomLevel = () => (camera as THREE.OrthographicCamera).zoom;
    cameraApi.project = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const r = gl.domElement.getBoundingClientRect();
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    };
    cameraApi.setEnabled = (v) => {
      if (controls.current) controls.current.enabled = v;
      if (!v)
        window.addEventListener(
          'pointerup',
          () => controls.current && (controls.current.enabled = true),
          { once: true },
        );
    };
  }, [camera, gl]);

  // Keyboard navigation.
  useEffect(() => {
    const keys = new Set<string>();
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return;
      const s = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        keys.add(k);
        e.preventDefault();
      }
      if (k === 'q') cameraApi.rotate?.(-1);
      if (k === 'e') cameraApi.rotate?.(1);
      if (k === '=' || k === '+') cameraApi.zoom?.(1.2);
      if (k === '-' || k === '_') cameraApi.zoom?.(1 / 1.2);
      if (k === '0' || k === 'home') s.focus({ kind: 'reset' });
      if (k === 'f' && s.selection?.kind === 'bot') {
        s.focus({ kind: 'bot', id: s.selection.id });
        s.setFollow(s.follow === s.selection.id ? undefined : s.selection.id);
      }
      if (k === 'b') s.setMode(s.mode === 'build' ? 'live' : 'build');
      if (k === 'r' && s.mode === 'build')
        s.setBuild({ rot: ((s.build.rot + 1) % 4) as 0 | 1 | 2 | 3 });
      if (k === 'escape') {
        if (s.build.carrying) s.setBuild({ carrying: undefined });
        else if (s.build.tool === 'place') s.setBuild({ tool: 'select', catalogId: undefined });
        else if (s.modal) s.openModal(null);
        else {
          s.select(null);
          s.setFollow(undefined);
        }
      }
      if (
        s.mode === 'build' &&
        (k === 'delete' || k === 'backspace') &&
        s.selection?.kind === 'furniture'
      ) {
        const uid = s.selection.uid;
        const deskAssignments = Object.fromEntries(
          Object.entries(s.layout.deskAssignments).filter(([, u]) => u !== uid),
        );
        s.commitLayout({
          ...s.layout,
          furniture: s.layout.furniture.filter((f) => f.uid !== uid),
          deskAssignments,
        });
        s.select(null);
      }
    };
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const blur = () => keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    (cameraApi as { keys?: Set<string> }).keys = keys;
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const cam = camera as THREE.OrthographicCamera;
    const s = useStore.getState();
    const keys = (cameraApi as { keys?: Set<string> }).keys;
    // Keyboard pan relative to the view.
    if (keys?.size) {
      const az = c.getAzimuthalAngle();
      const fwd = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az));
      const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
      const move = new THREE.Vector3();
      if (keys.has('w') || keys.has('arrowup')) move.add(fwd);
      if (keys.has('s') || keys.has('arrowdown')) move.sub(fwd);
      if (keys.has('d') || keys.has('arrowright')) move.add(right);
      if (keys.has('a') || keys.has('arrowleft')) move.sub(right);
      if (move.lengthSq()) {
        move.normalize().multiplyScalar((dt * 600) / cam.zoom);
        c.target.add(move);
        camera.position.add(move);
        goal.current = null;
        if (s.follow) s.setFollow(undefined);
      }
    }
    if (s.follow) {
      const b = world.brains.get(s.follow);
      if (b) goal.current = new THREE.Vector3(b.x, 0, b.z);
    }
    if (goal.current) {
      const delta = goal.current
        .clone()
        .sub(c.target)
        .multiplyScalar(Math.min(1, dt * 5));
      c.target.add(delta);
      camera.position.add(delta);
      if (!s.follow && goal.current.distanceTo(c.target) < 0.02) goal.current = null;
    }
    if (zoomGoal.current !== null) {
      cam.zoom = THREE.MathUtils.damp(cam.zoom, zoomGoal.current, 6, dt);
      cam.updateProjectionMatrix();
      if (Math.abs(cam.zoom - zoomGoal.current) < 0.05) zoomGoal.current = null;
    }
    if (azimuthGoal.current !== null) {
      const cur = c.getAzimuthalAngle();
      let d = azimuthGoal.current - cur;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const step = Math.abs(d) < 0.002 ? d : d * Math.min(1, dt * 7);
      const off = camera.position
        .clone()
        .sub(c.target)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
      camera.position.copy(c.target).add(off);
      if (Math.abs(d) < 0.002) azimuthGoal.current = null;
    }
    // Bounds.
    const lim = new THREE.Vector3(
      THREE.MathUtils.clamp(c.target.x, -2, s.layout.width + 2),
      0,
      THREE.MathUtils.clamp(c.target.z, -2, s.layout.depth + 2),
    );
    if (!lim.equals(c.target)) {
      const fix = lim.clone().sub(c.target);
      fix.y = -c.target.y;
      c.target.add(fix);
      camera.position.add(fix);
    }
    c.update();
  });

  return (
    <>
      <OrthographicCamera
        makeDefault
        near={-100}
        far={300}
        position={[DIST, DIST, DIST]}
        zoom={initialZoom}
      />
      <MapControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.14}
        screenSpacePanning={false}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        minPolarAngle={POLAR}
        maxPolarAngle={POLAR}
        enableRotate={enableRotate}
        zoomSpeed={1.1}
        mouseButtons={{
          LEFT: THREE.MOUSE.PAN,
          MIDDLE: THREE.MOUSE.ROTATE,
          RIGHT: THREE.MOUSE.ROTATE,
        }}
        onStart={() => {
          goal.current = null;
          zoomGoal.current = null;
          if (useStore.getState().follow) useStore.getState().setFollow(undefined);
        }}
      />
    </>
  );
}
