import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getCatalog } from '../../../shared/catalog';

/**
 * Original procedural voxel furniture. Each model is a list of coloured boxes merged into ONE
 * vertex-coloured BufferGeometry (one draw call per item, shared across instances of the same id).
 * Coordinates: x/z in tiles from the footprint's min corner (unrotated), y up. Faces get baked
 * shading (top light, sides darker) for a crisp pixel-art read under soft lighting.
 */

type Box = [x: number, y: number, z: number, w: number, h: number, d: number, color: string];
/** Emissive / animated sub-parts rendered separately. */
export type Overlay =
  | {
      kind: 'screen';
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      facing: number;
      variant: 'desk' | 'present' | 'arcade';
    }
  | {
      kind: 'glow';
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      d: number;
      color: string;
    }
  | { kind: 'leds'; x: number; y: number; z: number; w: number; h: number }
  | { kind: 'steam'; x: number; y: number; z: number }
  | { kind: 'nameplate'; x: number; y: number; z: number }
  | { kind: 'fish'; x: number; y: number; z: number; w: number };

const WOOD = '#B9814F';
const WOOD_D = '#7E5131';
const WOOD_L = '#D9A86C';
const METAL = '#6B7280';
const DARK = '#2E2A33';
const WHITE = '#F3EEE4';
const CUSHION = '#E07A5F';

function chair(x: number, z: number, facing: 'n' | 's' | 'e' | 'w', color = '#3F4A5A'): Box[] {
  // Seat centred in the tile at (x+0.5, z+0.5); back on the side opposite to where the sitter faces.
  const cx = x + 0.5;
  const cz = z + 0.5;
  const out: Box[] = [
    [cx - 0.22, 0.38, cz - 0.22, 0.44, 0.08, 0.44, color],
    [cx - 0.03, 0.08, cz - 0.03, 0.06, 0.3, 0.06, METAL],
    [cx - 0.2, 0.02, cz - 0.2, 0.4, 0.06, 0.4, '#4B5563'],
  ];
  const back: Record<typeof facing, Box> = {
    n: [cx - 0.22, 0.46, cz + 0.16, 0.44, 0.42, 0.07, color],
    s: [cx - 0.22, 0.46, cz - 0.23, 0.44, 0.42, 0.07, color],
    e: [cx - 0.23, 0.46, cz - 0.22, 0.07, 0.42, 0.44, color],
    w: [cx + 0.16, 0.46, cz - 0.22, 0.07, 0.42, 0.44, color],
  };
  out.push(back[facing]);
  return out;
}

function deskTop(x0: number, z0: number, w: number, d: number, top = WOOD, side = WOOD_D): Box[] {
  return [
    [x0 + 0.04, 0.62, z0 + 0.06, w - 0.08, 0.08, d - 0.12, top],
    [x0 + 0.07, 0, z0 + 0.1, 0.08, 0.62, d - 0.2, side],
    [x0 + w - 0.15, 0, z0 + 0.1, 0.08, 0.62, d - 0.2, side],
    [x0 + 0.15, 0.3, z0 + 0.12, w - 0.3, 0.32, 0.06, side],
  ];
}

function monitor(cx: number, z: number, wide = 0.56): { boxes: Box[]; overlay: Overlay } {
  return {
    boxes: [
      [cx - 0.05, 0.7, z + 0.02, 0.1, 0.12, 0.06, DARK],
      [cx - 0.12, 0.7, z - 0.02, 0.24, 0.02, 0.14, DARK],
      [cx - wide / 2 - 0.03, 0.8, z, wide + 0.06, 0.38, 0.05, DARK],
    ],
    overlay: {
      kind: 'screen',
      x: cx,
      y: 0.99,
      z: z + 0.052,
      w: wide - 0.02,
      h: 0.3,
      facing: 0,
      variant: 'desk',
    },
  };
}

function plantBoxes(
  cx: number,
  cz: number,
  size: number,
  pot = '#C2703D',
  leaf = '#4F9D5A',
): Box[] {
  const s = size;
  return [
    [cx - 0.16 * s, 0, cz - 0.16 * s, 0.32 * s, 0.3 * s, 0.32 * s, pot],
    [cx - 0.18 * s, 0.28 * s, cz - 0.18 * s, 0.36 * s, 0.04 * s, 0.36 * s, '#A35A2F'],
    [cx - 0.04 * s, 0.3 * s, cz - 0.04 * s, 0.08 * s, 0.4 * s, 0.08 * s, '#6B4F2A'],
    [cx - 0.28 * s, 0.55 * s, cz - 0.28 * s, 0.56 * s, 0.4 * s, 0.56 * s, leaf],
    [cx - 0.2 * s, 0.92 * s, cz - 0.2 * s, 0.4 * s, 0.3 * s, 0.4 * s, '#63B46D'],
    [cx - 0.36 * s, 0.68 * s, cz - 0.1 * s, 0.14 * s, 0.18 * s, 0.2 * s, '#3F8A4B'],
    [cx + 0.22 * s, 0.75 * s, cz - 0.05 * s, 0.14 * s, 0.16 * s, 0.18 * s, '#3F8A4B'],
  ];
}

const bookColors = [
  '#E76F51',
  '#2A9D8F',
  '#E9C46A',
  '#264653',
  '#F4A261',
  '#8E7DBE',
  '#D62828',
  '#457B9D',
];

function models(id: string): { boxes: Box[]; overlays: Overlay[] } {
  const o: Overlay[] = [];
  let b: Box[];
  switch (id) {
    case 'workstation': {
      b = deskTop(0, 0, 1, 1);
      const m = monitor(0.5, 0.22);
      b.push(...m.boxes);
      o.push(m.overlay);
      b.push(
        [0.3, 0.7, 0.55, 0.4, 0.03, 0.14, '#D9D4CC'],
        [0.76, 0.7, 0.58, 0.07, 0.03, 0.1, '#D9D4CC'],
      );
      b.push([0.1, 0.7, 0.62, 0.09, 0.11, 0.09, WHITE]); // mug
      b.push(...plantBoxes(0.86, 0.22, 0.32));
      b.push(...chair(0, 1, 'n'));
      o.push({ kind: 'nameplate', x: 0.5, y: 0.72, z: 0.86 });
      break;
    }
    case 'workstation_duo': {
      b = deskTop(0, 0, 2, 1);
      const m1 = monitor(0.5, 0.22);
      const m2 = monitor(1.1, 0.22, 0.46);
      b.push(...m1.boxes, ...m2.boxes);
      o.push(m1.overlay, m2.overlay);
      b.push(
        [0.3, 0.7, 0.55, 0.4, 0.03, 0.14, '#D9D4CC'],
        [1.5, 0.7, 0.3, 0.3, 0.14, 0.24, '#E9C46A'],
        [1.55, 0.84, 0.32, 0.22, 0.05, 0.2, '#F4A261'],
      );
      b.push(...plantBoxes(1.82, 0.25, 0.32));
      b.push(...chair(0, 1, 'n'));
      o.push({ kind: 'nameplate', x: 1.0, y: 0.72, z: 0.86 });
      break;
    }
    case 'exec_desk': {
      b = deskTop(0, 0, 2, 1, '#6E3B23', '#4A2616');
      b.push([0.12, 0.05, 0.08, 1.76, 0.57, 0.06, '#5A2E1A']); // modesty panel (visitor side)
      const m1 = monitor(0.55, 0.2, 0.7);
      b.push(...m1.boxes);
      o.push(m1.overlay);
      b.push(
        [1.2, 0.7, 0.2, 0.06, 0.32, 0.06, '#C9A227'],
        [1.12, 1.0, 0.13, 0.22, 0.12, 0.2, '#F2D16B'],
      ); // desk lamp
      o.push({
        kind: 'glow',
        x: 1.23,
        y: 0.99,
        z: 0.23,
        w: 0.16,
        h: 0.04,
        d: 0.14,
        color: '#FFE7A3',
      });
      b.push(
        [1.45, 0.7, 0.45, 0.35, 0.04, 0.28, WHITE],
        [1.48, 0.74, 0.47, 0.3, 0.03, 0.24, '#E8E1D3'],
      );
      b.push(...chair(0, 1, 'n', '#2B2118'));
      b.push([0.2, 0.46, 1.62, 0.6, 0.62, 0.1, '#2B2118']); // tall back
      o.push({ kind: 'nameplate', x: 1.0, y: 0.72, z: 0.14 });
      break;
    }
    case 'desk_plain':
      b = deskTop(0, 0, 1, 1, WOOD_L);
      b.push([0.2, 0.7, 0.3, 0.3, 0.05, 0.22, WHITE], [0.6, 0.7, 0.5, 0.2, 0.18, 0.2, '#E9C46A']);
      break;
    case 'chair_office':
      b = chair(0, 0, 's');
      break;
    case 'chair_guest':
      b = chair(0, 0, 'n', '#8E5A3C');
      break;
    case 'server_rack':
      b = [
        [0.12, 0, 0.12, 0.76, 1.85, 0.76, '#1F2430'],
        [0.15, 1.85, 0.15, 0.7, 0.04, 0.7, '#2E3546'],
      ];
      for (let i = 0; i < 6; i++) b.push([0.16, 0.12 + i * 0.28, 0.86, 0.68, 0.2, 0.03, '#374151']);
      o.push({ kind: 'leds', x: 0.5, y: 0.95, z: 0.895, w: 0.55, h: 1.6 });
      break;
    case 'printer':
      b = [
        [0.12, 0, 0.12, 0.76, 0.5, 0.76, WOOD_D],
        [0.15, 0.5, 0.18, 0.7, 0.3, 0.6, '#D9D4CC'],
        [0.2, 0.8, 0.22, 0.6, 0.06, 0.45, '#BFB8AC'],
        [0.28, 0.62, 0.76, 0.44, 0.04, 0.12, WHITE],
        [0.62, 0.81, 0.62, 0.08, 0.02, 0.08, '#22C55E'],
      ];
      break;
    case 'cabinet_file':
      b = [[0.14, 0, 0.18, 0.72, 1.05, 0.66, '#9CA3AF']];
      for (let i = 0; i < 3; i++)
        b.push(
          [0.18, 0.1 + i * 0.33, 0.84, 0.64, 0.26, 0.02, '#B8BEC7'],
          [0.42, 0.22 + i * 0.33, 0.86, 0.16, 0.04, 0.02, '#4B5563'],
        );
      break;
    case 'bookshelf': {
      b = [
        [0.05, 0, 0.12, 1.9, 1.85, 0.12, WOOD_D],
        [0.05, 0, 0.12, 0.08, 1.85, 0.72, WOOD_D],
        [1.87, 0, 0.12, 0.08, 1.85, 0.72, WOOD_D],
        [0.05, 1.82, 0.12, 1.9, 0.06, 0.72, WOOD_D],
      ];
      for (let s = 0; s < 4; s++) {
        const y = 0.05 + s * 0.45;
        b.push([0.1, y, 0.2, 1.8, 0.05, 0.62, WOOD]);
        let x = 0.15;
        let k = s * 3;
        while (x < 1.75) {
          const w = 0.08 + ((k * 7) % 5) * 0.02;
          const h = 0.26 + ((k * 13) % 4) * 0.03;
          if ((k * 11) % 9 !== 0)
            b.push([x, y + 0.05, 0.3, w, h, 0.4, bookColors[k % bookColors.length]]);
          x += w + 0.015;
          k++;
        }
      }
      break;
    }
    case 'table_coffee':
      b = [
        [0.12, 0.3, 0.12, 0.76, 0.07, 0.76, WOOD_L],
        [0.16, 0, 0.16, 0.07, 0.3, 0.07, WOOD_D],
        [0.77, 0, 0.16, 0.07, 0.3, 0.07, WOOD_D],
        [0.16, 0, 0.77, 0.07, 0.3, 0.07, WOOD_D],
        [0.77, 0, 0.77, 0.07, 0.3, 0.07, WOOD_D],
        [0.3, 0.37, 0.35, 0.1, 0.1, 0.1, WHITE],
        [0.55, 0.37, 0.5, 0.25, 0.03, 0.18, '#E76F51'],
      ];
      break;
    case 'conference_table': {
      b = [
        [1.05, 0.62, 1.05, 1.9, 0.08, 1.9, '#8B5A36'],
        [1.2, 0, 1.2, 0.12, 0.62, 0.12, WOOD_D],
        [2.68, 0, 1.2, 0.12, 0.62, 0.12, WOOD_D],
        [1.2, 0, 2.68, 0.12, 0.62, 0.12, WOOD_D],
        [2.68, 0, 2.68, 0.12, 0.62, 0.12, WOOD_D],
        [1.5, 0.7, 1.3, 0.3, 0.02, 0.22, WHITE],
        [2.2, 0.7, 2.4, 0.3, 0.02, 0.22, WHITE],
        [1.8, 0.7, 1.8, 0.4, 0.04, 0.4, '#374151'],
      ];
      b.push(...chair(1, 0, 's'), ...chair(2, 0, 's'), ...chair(1, 3, 'n'), ...chair(2, 3, 'n'));
      b.push(...chair(0, 1, 'e'), ...chair(0, 2, 'e'), ...chair(3, 1, 'w'), ...chair(3, 2, 'w'));
      break;
    }
    case 'round_table':
      b = [
        [1.15, 0.65, 0.15, 0.7, 0.06, 0.7, WHITE],
        [1.45, 0, 0.45, 0.1, 0.65, 0.1, METAL],
        [1.3, 0, 0.3, 0.4, 0.04, 0.4, METAL],
        [1.3, 0.71, 0.3, 0.1, 0.1, 0.1, '#F4A261'],
        [0.3, 0.42, 0.3, 0.4, 0.06, 0.4, CUSHION],
        [0.45, 0, 0.45, 0.1, 0.42, 0.1, METAL],
        [2.3, 0.42, 0.3, 0.4, 0.06, 0.4, CUSHION],
        [2.45, 0, 0.45, 0.1, 0.42, 0.1, METAL],
      ];
      break;
    case 'sofa':
      b = [
        [0.04, 0.05, 0.15, 1.92, 0.33, 0.78, '#3D6E8E'],
        [0.04, 0.38, 0.05, 1.92, 0.52, 0.24, '#335D78'],
        [0.04, 0.38, 0.15, 0.2, 0.24, 0.78, '#335D78'],
        [1.76, 0.38, 0.15, 0.2, 0.24, 0.78, '#335D78'],
        [0.26, 0.38, 0.32, 0.72, 0.08, 0.58, '#4C86AA'],
        [1.02, 0.38, 0.32, 0.72, 0.08, 0.58, '#4C86AA'],
        [0.3, 0.46, 0.3, 0.3, 0.26, 0.1, '#F2CC8F'],
        [0.04, 0, 0.18, 0.1, 0.05, 0.1, WOOD_D],
        [1.86, 0, 0.18, 0.1, 0.05, 0.1, WOOD_D],
      ];
      break;
    case 'armchair':
      b = [
        [0.08, 0.05, 0.15, 0.84, 0.33, 0.78, '#B5654A'],
        [0.08, 0.38, 0.05, 0.84, 0.5, 0.22, '#9C5640'],
        [0.08, 0.38, 0.15, 0.16, 0.22, 0.78, '#9C5640'],
        [0.76, 0.38, 0.15, 0.16, 0.22, 0.78, '#9C5640'],
        [0.24, 0.38, 0.3, 0.52, 0.08, 0.58, '#D07B5E'],
      ];
      break;
    case 'plant_big':
      b = plantBoxes(0.5, 0.5, 1.25);
      break;
    case 'plant_small':
      b = plantBoxes(0.5, 0.5, 0.55, '#E9C46A', '#6BAF5C');
      break;
    case 'plant_palm':
      b = [
        [0.3, 0, 0.3, 0.4, 0.4, 0.4, '#8D99AE'],
        [0.46, 0.4, 0.46, 0.08, 0.9, 0.08, '#8B6B3E'],
        [0.1, 1.25, 0.42, 0.8, 0.08, 0.16, '#3F8A4B'],
        [0.42, 1.25, 0.1, 0.16, 0.08, 0.8, '#4F9D5A'],
        [0.2, 1.38, 0.2, 0.6, 0.08, 0.6, '#63B46D'],
        [0.05, 1.15, 0.45, 0.14, 0.14, 0.1, '#3F8A4B'],
        [0.82, 1.15, 0.45, 0.14, 0.14, 0.1, '#3F8A4B'],
      ];
      break;
    case 'lamp_floor':
      b = [
        [0.35, 0, 0.35, 0.3, 0.05, 0.3, DARK],
        [0.47, 0.05, 0.47, 0.06, 1.2, 0.06, DARK],
        [0.28, 1.22, 0.28, 0.44, 0.32, 0.44, '#F2E3C6'],
      ];
      o.push({ kind: 'glow', x: 0.5, y: 1.2, z: 0.5, w: 0.36, h: 0.05, d: 0.36, color: '#FFE7A3' });
      break;
    case 'coffee_machine':
      b = [
        [0.08, 0, 0.12, 0.84, 0.7, 0.76, WOOD_D],
        [0.1, 0.7, 0.14, 0.8, 0.04, 0.72, WOOD_L],
        [0.22, 0.74, 0.2, 0.56, 0.48, 0.42, '#B23A48'],
        [0.3, 1.0, 0.62, 0.4, 0.1, 0.06, '#2B2118'],
        [0.42, 0.86, 0.5, 0.16, 0.05, 0.14, METAL],
        [0.44, 0.76, 0.5, 0.12, 0.1, 0.12, WHITE],
        [0.72, 0.74, 0.62, 0.12, 0.14, 0.12, WHITE],
      ];
      o.push({ kind: 'steam', x: 0.5, y: 0.9, z: 0.56 });
      break;
    case 'water_dispenser':
      b = [
        [0.25, 0, 0.25, 0.5, 0.95, 0.5, '#E5E7EB'],
        [0.4, 0.55, 0.75, 0.2, 0.08, 0.04, '#60A5FA'],
        [0.3, 0.95, 0.3, 0.4, 0.42, 0.4, '#93C5FD'],
        [0.38, 1.37, 0.38, 0.24, 0.05, 0.24, '#60A5FA'],
      ];
      o.push({ kind: 'fish', x: 0.5, y: 1.1, z: 0.5, w: 0 });
      break;
    case 'vending_machine':
      b = [[0.08, 0, 0.12, 0.84, 1.85, 0.76, '#C2410C']];
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 3; c++)
          b.push([
            0.16 + c * 0.17,
            0.75 + r * 0.24,
            0.85,
            0.12,
            0.14,
            0.04,
            bookColors[(r * 3 + c) % bookColors.length],
          ]);
      b.push(
        [0.16, 0.2, 0.86, 0.5, 0.2, 0.04, '#1F2937'],
        [0.72, 0.8, 0.86, 0.12, 0.5, 0.04, '#374151'],
      );
      o.push({
        kind: 'glow',
        x: 0.4,
        y: 1.18,
        z: 0.885,
        w: 0.56,
        h: 1.0,
        d: 0.01,
        color: '#FDE68A',
      });
      break;
    case 'whiteboard':
      b = [
        [0.15, 0, 0.45, 0.06, 1.55, 0.08, METAL],
        [1.79, 0, 0.45, 0.06, 1.55, 0.08, METAL],
        [0.1, 0.7, 0.42, 1.8, 0.9, 0.06, '#D1D5DB'],
        [0.14, 0.74, 0.48, 1.72, 0.82, 0.01, '#FAFAF7'],
        [0.3, 1.3, 0.49, 0.6, 0.04, 0.01, '#2563EB'],
        [0.3, 1.18, 0.49, 0.9, 0.04, 0.01, '#DC2626'],
        [0.3, 1.06, 0.49, 0.4, 0.04, 0.01, '#16A34A'],
        [1.2, 0.9, 0.49, 0.4, 0.4, 0.01, '#FBBF24'],
        [0.4, 0.7, 0.48, 1.2, 0.04, 0.12, METAL],
      ];
      break;
    case 'screen_present':
      b = [
        [0.9, 0, 0.35, 0.2, 0.9, 0.2, DARK],
        [0.6, 0, 0.25, 0.8, 0.05, 0.5, DARK],
        [0.08, 0.85, 0.42, 1.84, 0.95, 0.08, DARK],
      ];
      o.push({
        kind: 'screen',
        x: 1.0,
        y: 1.325,
        z: 0.505,
        w: 1.72,
        h: 0.84,
        facing: 0,
        variant: 'present',
      });
      break;
    case 'rug':
      b = [
        [0.08, 0, 0.08, 1.84, 0.02, 1.84, '#C8553D'],
        [0.2, 0.003, 0.2, 1.6, 0.02, 1.6, '#F2CC8F'],
        [0.4, 0.006, 0.4, 1.2, 0.02, 1.2, '#E07A5F'],
        [0.8, 0.009, 0.8, 0.4, 0.02, 0.4, '#3D405B'],
      ];
      break;
    case 'trophy':
      b = [
        [0.2, 0, 0.2, 0.6, 0.7, 0.6, WOOD_D],
        [0.35, 0.7, 0.35, 0.3, 0.08, 0.3, '#B7791F'],
        [0.42, 0.78, 0.42, 0.16, 0.12, 0.16, '#ECC94B'],
        [0.32, 0.9, 0.32, 0.36, 0.25, 0.36, '#F6E05E'],
        [0.25, 0.95, 0.44, 0.08, 0.14, 0.12, '#ECC94B'],
        [0.67, 0.95, 0.44, 0.08, 0.14, 0.12, '#ECC94B'],
      ];
      break;
    case 'aquarium':
      b = [
        [0.08, 0, 0.15, 1.84, 0.6, 0.7, WOOD_D],
        [0.1, 0.6, 0.17, 1.8, 0.08, 0.66, '#4B5563'],
        [0.12, 0.68, 0.19, 1.76, 0.55, 0.62, '#5DADE2'],
        [0.12, 0.68, 0.19, 1.76, 0.08, 0.62, '#E9C46A'],
        [0.4, 0.76, 0.35, 0.1, 0.3, 0.1, '#2E8B57'],
        [1.4, 0.76, 0.4, 0.1, 0.35, 0.1, '#2E8B57'],
        [0.1, 1.23, 0.17, 1.8, 0.05, 0.66, '#374151'],
      ];
      o.push({ kind: 'fish', x: 1.0, y: 0.98, z: 0.82, w: 1.4 });
      break;
    case 'arcade':
      b = [
        [0.15, 0, 0.15, 0.7, 1.75, 0.7, '#6D28D9'],
        [0.15, 0.85, 0.55, 0.7, 0.12, 0.35, '#1F2937'],
        [0.3, 0.97, 0.7, 0.06, 0.08, 0.06, '#EF4444'],
        [0.55, 0.97, 0.72, 0.07, 0.04, 0.07, '#FBBF24'],
        [0.15, 1.6, 0.6, 0.7, 0.15, 0.25, '#F472B6'],
      ];
      o.push({
        kind: 'screen',
        x: 0.5,
        y: 1.28,
        z: 0.86,
        w: 0.5,
        h: 0.4,
        facing: 0,
        variant: 'arcade',
      });
      break;
    default:
      b = [[0.1, 0, 0.1, 0.8, 0.8, 0.8, '#FF00FF']];
  }
  return { boxes: b, overlays: o };
}

const shade = (c: THREE.Color, f: number) => c.clone().multiplyScalar(f);

function boxGeometry([x, y, z, w, h, d, color]: Box): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x + w / 2, y + h / 2, z + d / 2);
  const base = new THREE.Color(color);
  const normals = g.getAttribute('normal');
  const colors = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) {
    const ny = normals.getY(i);
    const nx = normals.getX(i);
    const c =
      ny > 0.5
        ? shade(base, 1.08)
        : ny < -0.5
          ? shade(base, 0.6)
          : Math.abs(nx) > 0.5
            ? shade(base, 0.86)
            : shade(base, 0.95);
    colors.set([Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b)], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

const cache = new Map<string, { geometry: THREE.BufferGeometry; overlays: Overlay[] }>();

/** Merged geometry, centred on the footprint centre so rotation spins in place. */
export function furnitureModel(catalogId: string) {
  let hit = cache.get(catalogId);
  if (hit) return hit;
  const item = getCatalog(catalogId);
  const { boxes, overlays } = models(catalogId);
  const geometry = mergeGeometries(boxes.map(boxGeometry), false)!;
  geometry.translate(-item.w / 2, 0, -item.d / 2);
  geometry.computeBoundingSphere();
  const centred = overlays.map((ov) => ({ ...ov, x: ov.x - item.w / 2, z: ov.z - item.d / 2 }));
  hit = { geometry, overlays: centred };
  cache.set(catalogId, hit);
  return hit;
}

export const vertexColorMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
