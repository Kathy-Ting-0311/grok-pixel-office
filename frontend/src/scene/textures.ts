import * as THREE from 'three';
import type { Appearance, FloorType, OfficeLayout } from '../../../shared/types';

/** All textures are drawn on small canvases with nearest-neighbour filtering for a crisp pixel look. */
export function pixelTexture(canvas: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const TILE_PX = 16;

const floorPalette: Record<FloorType, { a: string; b: string; line: string; label: string }> = {
  tile: { a: '#E9E1D3', b: '#E2D8C7', line: '#CFC3AE', label: 'Office Tile' },
  wood: { a: '#B97F4F', b: '#AD7446', line: '#8E5C36', label: 'Walnut Wood' },
  woodLight: { a: '#DDB683', b: '#D3AA75', line: '#B98D5B', label: 'Oak Wood' },
  carpetBlue: { a: '#6E8FB5', b: '#6687AD', line: '#5A7AA0', label: 'Blue Carpet' },
  carpetGreen: { a: '#7FA57A', b: '#779C72', line: '#668A61', label: 'Green Carpet' },
  checker: { a: '#F2EFE8', b: '#3F3A45', line: '#2E2A33', label: 'Checker' },
  concrete: { a: '#B9BCC0', b: '#B1B4B8', line: '#9EA2A7', label: 'Concrete' },
};
export const floorTypes = Object.keys(floorPalette) as FloorType[];
export const floorLabel = (f: FloorType) => floorPalette[f].label;
export const floorSwatch = (f: FloorType) => floorPalette[f].a;

function drawTile(
  ctx: CanvasRenderingContext2D,
  type: FloorType,
  ox: number,
  oy: number,
  x: number,
  z: number,
) {
  const p = floorPalette[type];
  const s = TILE_PX;
  ctx.fillStyle = p.a;
  ctx.fillRect(ox, oy, s, s);
  const seed = (x * 73856093) ^ (z * 19349663);
  const r = (n: number) => Math.abs(Math.sin(seed + n * 12.9898) * 43758.5453) % 1;
  switch (type) {
    case 'tile':
    case 'concrete':
      ctx.fillStyle = (x + z) % 2 ? p.b : p.a;
      ctx.fillRect(ox, oy, s, s);
      ctx.fillStyle = p.line;
      ctx.fillRect(ox, oy + s - 1, s, 1);
      ctx.fillRect(ox + s - 1, oy, 1, s);
      if (type === 'concrete')
        for (let i = 0; i < 3; i++)
          ctx.fillRect(ox + Math.floor(r(i) * s), oy + Math.floor(r(i + 4) * s), 1, 1);
      break;
    case 'wood':
    case 'woodLight': {
      for (let row = 0; row < 4; row++) {
        ctx.fillStyle = (row + x) % 2 ? p.a : p.b;
        ctx.fillRect(ox, oy + row * 4, s, 4);
        ctx.fillStyle = p.line;
        ctx.fillRect(ox, oy + row * 4 + 3, s, 1);
        const seam = (row * 5 + x * 7 + z * 3) % s;
        ctx.fillRect(ox + seam, oy + row * 4, 1, 3);
      }
      break;
    }
    case 'carpetBlue':
    case 'carpetGreen':
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = i % 2 ? p.b : p.line;
        ctx.fillRect(ox + Math.floor(r(i) * s), oy + Math.floor(r(i + 30) * s), 1, 1);
      }
      break;
    case 'checker':
      ctx.fillStyle = (x + z) % 2 ? p.b : p.a;
      ctx.fillRect(ox, oy, s, s);
      break;
  }
}

/** One canvas for the whole floor: tiles + subtle room borders. Regenerated when the layout changes. */
export function drawFloor(layout: OfficeLayout, canvas?: HTMLCanvasElement) {
  const c = canvas ?? document.createElement('canvas');
  c.width = layout.width * TILE_PX;
  c.height = layout.depth * TILE_PX;
  const ctx = c.getContext('2d')!;
  for (let z = 0; z < layout.depth; z++)
    for (let x = 0; x < layout.width; x++)
      drawTile(ctx, layout.tiles[z * layout.width + x].floor, x * TILE_PX, z * TILE_PX, x, z);
  // Room borders: darker pixel line where room ids change.
  ctx.fillStyle = 'rgba(60,40,25,0.28)';
  for (let z = 0; z < layout.depth; z++)
    for (let x = 0; x < layout.width; x++) {
      const id = layout.tiles[z * layout.width + x].roomId;
      if (x > 0 && layout.tiles[z * layout.width + x - 1].roomId !== id)
        ctx.fillRect(x * TILE_PX, z * TILE_PX, 1, TILE_PX);
      if (z > 0 && layout.tiles[(z - 1) * layout.width + x].roomId !== id)
        ctx.fillRect(x * TILE_PX, z * TILE_PX, TILE_PX, 1);
    }
  return c;
}

export function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(43,33,24,0.85)';
  ctx.fillRect(0, 0, 16, 1);
  ctx.fillRect(0, 0, 1, 16);
  const t = pixelTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- faces
const faceCache = new Map<string, THREE.Texture>();
export function faceTexture(a: Pick<Appearance, 'skin' | 'expression' | 'glasses'>, blink = false) {
  const key = `${a.skin}|${a.expression}|${a.glasses}|${blink}`;
  const hit = faceCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 12;
  const g = c.getContext('2d')!;
  g.fillStyle = a.skin;
  g.fillRect(0, 0, 12, 12);
  const ink = '#2B2118';
  g.fillStyle = ink;
  const eye = (x: number) => {
    if (blink || a.expression === 'sleepy') g.fillRect(x, 6, 2, 1);
    else if (a.expression === 'focused') g.fillRect(x, 5, 2, 2);
    else g.fillRect(x, 5, 2, 2);
  };
  if (a.expression === 'wink' && !blink) {
    eye(3);
    g.fillRect(7, 6, 2, 1);
  } else {
    eye(3);
    eye(7);
  }
  // Mouth
  if (a.expression === 'happy' || a.expression === 'wink') {
    g.fillRect(5, 9, 2, 1);
    g.fillRect(4, 8, 1, 1);
    g.fillRect(7, 8, 1, 1);
  } else if (a.expression === 'sleepy') g.fillRect(5, 9, 2, 1);
  else g.fillRect(5, 9, 2, 1);
  // Cheeks
  g.fillStyle = 'rgba(235,110,110,0.55)';
  g.fillRect(2, 8, 1, 1);
  g.fillRect(9, 8, 1, 1);
  if (a.glasses !== 'none') {
    g.fillStyle = a.glasses === 'shades' ? '#111' : '#3B3B46';
    if (a.glasses === 'shades') {
      g.fillRect(2, 5, 4, 2);
      g.fillRect(6, 5, 4, 2);
    } else {
      const ring = (x: number) => {
        g.fillRect(x, 4, 4, 1);
        g.fillRect(x, 7, 4, 1);
        g.fillRect(x, 4, 1, 4);
        g.fillRect(x + 3, 4, 1, 4);
      };
      ring(2);
      ring(6);
    }
  }
  const t = pixelTexture(c);
  faceCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------- screens
type ScreenVariant = 'work' | 'idle' | 'off' | 'present' | 'arcade';
const screens = new Map<
  ScreenVariant,
  { canvas: HTMLCanvasElement; texture: THREE.Texture; draw: (t: number) => void }
>();

function makeScreen(variant: ScreenVariant) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 18;
  const g = c.getContext('2d')!;
  const colors = ['#7DD3FC', '#FDE68A', '#A7F3D0', '#F9A8D4', '#C4B5FD'];
  const draw = (t: number) => {
    if (variant === 'off') {
      g.fillStyle = '#1B1F2A';
      g.fillRect(0, 0, 32, 18);
      return;
    }
    if (variant === 'work') {
      g.fillStyle = '#0F172A';
      g.fillRect(0, 0, 32, 18);
      const scroll = Math.floor(t * 3);
      for (let row = 0; row < 6; row++) {
        const n = row + scroll;
        g.fillStyle = colors[n % colors.length];
        const indent = (n * 7) % 3;
        const len = 6 + ((n * 13) % 18);
        g.fillRect(2 + indent * 2, 2 + row * 3, Math.min(len, 26 - indent * 2), 1);
      }
      if (Math.floor(t * 2) % 2) {
        g.fillStyle = '#F8FAFC';
        g.fillRect(4 + (scroll % 20), 17, 2, 1);
      }
      return;
    }
    if (variant === 'idle') {
      g.fillStyle = '#12324A';
      g.fillRect(0, 0, 32, 18);
      const x = Math.floor(((Math.sin(t * 0.7) + 1) / 2) * 24);
      const y = Math.floor(((Math.cos(t * 0.53) + 1) / 2) * 12);
      g.fillStyle = '#5EEAD4';
      g.fillRect(x, y, 8, 5);
      g.fillStyle = '#12324A';
      g.fillRect(x + 2, y + 2, 4, 1);
      return;
    }
    if (variant === 'present') {
      const slide = Math.floor(t / 4) % 3;
      g.fillStyle = '#F8FAFC';
      g.fillRect(0, 0, 32, 18);
      g.fillStyle = '#1D4ED8';
      g.fillRect(2, 2, 16, 2);
      if (slide === 0) {
        [6, 9, 12].forEach((h, i) => {
          g.fillStyle = colors[i];
          g.fillRect(6 + i * 7, 16 - h, 5, h);
        });
      } else if (slide === 1) {
        g.fillStyle = '#94A3B8';
        for (let i = 0; i < 4; i++) g.fillRect(3, 6 + i * 3, 18 - i * 3, 1);
        g.fillStyle = '#F59E0B';
        g.fillRect(23, 6, 6, 6);
      } else {
        g.fillStyle = '#22C55E';
        g.beginPath();
        g.arc(16, 11, 5, 0, Math.PI * 1.3);
        g.lineTo(16, 11);
        g.fill();
        g.fillStyle = '#F43F5E';
        g.beginPath();
        g.arc(16, 11, 5, Math.PI * 1.3, Math.PI * 2);
        g.lineTo(16, 11);
        g.fill();
      }
      return;
    }
    // arcade
    g.fillStyle = '#111827';
    g.fillRect(0, 0, 32, 18);
    const p = Math.floor(t * 8) % 32;
    g.fillStyle = '#FBBF24';
    g.fillRect(p, 8, 3, 3);
    g.fillStyle = '#F472B6';
    for (let i = 0; i < 5; i++) g.fillRect((i * 7 + 3) % 32, 9, 1, 1);
    g.fillStyle = '#60A5FA';
    g.fillRect((p + 14) % 32, 7, 3, 4);
  };
  draw(0);
  const texture = pixelTexture(c);
  return { canvas: c, texture, draw };
}

export function screenTexture(variant: ScreenVariant) {
  let s = screens.get(variant);
  if (!s) {
    s = makeScreen(variant);
    screens.set(variant, s);
  }
  return s.texture;
}

/** Redraw animated screen textures (call at a low rate, ~6 Hz). */
export function animateScreens(t: number) {
  for (const [variant, s] of screens) {
    if (variant === 'off') continue;
    s.draw(t);
    s.texture.needsUpdate = true;
  }
}

const plateCache = new Map<string, THREE.Texture>();
export function nameplateTexture(initials: string, color: string) {
  const key = initials + color;
  const hit = plateCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 8;
  const g = c.getContext('2d')!;
  g.fillStyle = '#F5E6C8';
  g.fillRect(0, 0, 32, 8);
  g.fillStyle = color;
  g.fillRect(0, 0, 4, 8);
  g.fillStyle = '#2B2118';
  g.font = 'bold 7px monospace';
  g.textBaseline = 'top';
  g.fillText(initials, 7, 0);
  const t = pixelTexture(c);
  plateCache.set(key, t);
  return t;
}
