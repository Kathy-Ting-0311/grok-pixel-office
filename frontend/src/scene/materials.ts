import * as THREE from 'three';

/** Shared material cache: one Lambert material per colour (cheap, non-PBR, pixel-friendly). */
const lambert = new Map<string, THREE.MeshLambertMaterial>();
export function mat(color: string) {
  let m = lambert.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    lambert.set(color, m);
  }
  return m;
}

const basic = new Map<string, THREE.MeshBasicMaterial>();
export function glowMat(color: string, opacity = 1) {
  const key = `${color}|${opacity}`;
  let m = basic.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      toneMapped: false,
    });
    basic.set(key, m);
  }
  return m;
}

export const unitBox = new THREE.BoxGeometry(1, 1, 1);
export const unitPlane = new THREE.PlaneGeometry(1, 1);
