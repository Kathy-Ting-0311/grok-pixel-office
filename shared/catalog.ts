export const furnitureCategories = [
  'desks',
  'chairs',
  'computers',
  'cabinets',
  'tables',
  'sofas',
  'plants',
  'lighting',
  'appliances',
  'decorations',
] as const;
export type FurnitureCategory = (typeof furnitureCategories)[number];

export type PointTag = 'break' | 'guest' | 'look' | 'drink' | 'print';

/** Interaction point in local tile coords of the unrotated footprint. facing: rotation.y (0 faces +z). */
export type InteractionPoint = {
  x: number;
  z: number;
  facing: number;
  pose: 'sit' | 'stand';
  kind: 'desk' | 'seat' | 'stand';
  tags?: PointTag[];
};

export type CatalogItem = {
  id: string;
  name: string;
  category: FurnitureCategory;
  /** Footprint width (x) and depth (z) in tiles, before rotation. */
  w: number;
  d: number;
  /** Rows (z) of cells (x): B = blocks walking, S = seat (only enterable as a destination), F = decor floor, . = free. */
  mask: string[];
  height: number;
  points: InteractionPoint[];
  animated?: 'screen' | 'leds' | 'steam' | 'bubbles' | 'lamp';
  unlockLevel: number;
  price: number;
  tags?: string[];
};

const N = Math.PI; // facing -z (towards a desk placed north of the seat)

export const catalog: CatalogItem[] = [
  {
    id: 'workstation',
    name: 'Workstation',
    category: 'desks',
    w: 1,
    d: 2,
    mask: ['B', 'S'],
    height: 1.1,
    points: [{ x: 0, z: 1, facing: N, pose: 'sit', kind: 'desk' }],
    animated: 'screen',
    unlockLevel: 1,
    price: 0,
  },
  {
    id: 'workstation_duo',
    name: 'Wide Workstation',
    category: 'desks',
    w: 2,
    d: 2,
    mask: ['BB', 'S.'],
    height: 1.1,
    points: [{ x: 0, z: 1, facing: N, pose: 'sit', kind: 'desk' }],
    animated: 'screen',
    unlockLevel: 2,
    price: 40,
  },
  {
    id: 'exec_desk',
    name: 'Executive Desk',
    category: 'desks',
    w: 2,
    d: 2,
    mask: ['BB', 'S.'],
    height: 1.2,
    points: [{ x: 0, z: 1, facing: N, pose: 'sit', kind: 'desk' }],
    animated: 'screen',
    unlockLevel: 1,
    price: 0,
  },
  { id: 'desk_plain', name: 'Side Desk', category: 'desks', w: 1, d: 1, mask: ['B'], height: 0.7, points: [], unlockLevel: 1, price: 10 },
  {
    id: 'chair_office',
    name: 'Office Chair',
    category: 'chairs',
    w: 1,
    d: 1,
    mask: ['S'],
    height: 0.9,
    points: [{ x: 0, z: 0, facing: 0, pose: 'sit', kind: 'seat', tags: ['guest'] }],
    unlockLevel: 1,
    price: 8,
  },
  {
    id: 'chair_guest',
    name: 'Guest Chair',
    category: 'chairs',
    w: 1,
    d: 1,
    mask: ['S'],
    height: 0.8,
    points: [{ x: 0, z: 0, facing: N, pose: 'sit', kind: 'seat', tags: ['guest'] }],
    unlockLevel: 1,
    price: 8,
  },
  {
    id: 'server_rack',
    name: 'Server Rack',
    category: 'computers',
    w: 1,
    d: 1,
    mask: ['B'],
    height: 1.9,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['look'] }],
    animated: 'leds',
    unlockLevel: 2,
    price: 60,
  },
  {
    id: 'printer',
    name: 'Printer',
    category: 'computers',
    w: 1,
    d: 1,
    mask: ['B'],
    height: 0.9,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['print'] }],
    unlockLevel: 1,
    price: 20,
  },
  { id: 'cabinet_file', name: 'File Cabinet', category: 'cabinets', w: 1, d: 1, mask: ['B'], height: 1.1, points: [], unlockLevel: 1, price: 12 },
  {
    id: 'bookshelf',
    name: 'Bookshelf',
    category: 'cabinets',
    w: 2,
    d: 1,
    mask: ['BB'],
    height: 1.9,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['look'] }],
    unlockLevel: 1,
    price: 25,
  },
  { id: 'table_coffee', name: 'Coffee Table', category: 'tables', w: 1, d: 1, mask: ['B'], height: 0.45, points: [], unlockLevel: 1, price: 10 },
  {
    id: 'conference_table',
    name: 'Conference Table',
    category: 'tables',
    w: 4,
    d: 4,
    mask: ['.SS.', 'SBBS', 'SBBS', '.SS.'],
    height: 0.8,
    points: [
      { x: 1, z: 0, facing: 0, pose: 'sit', kind: 'seat' },
      { x: 2, z: 0, facing: 0, pose: 'sit', kind: 'seat' },
      { x: 0, z: 1, facing: Math.PI / 2, pose: 'sit', kind: 'seat' },
      { x: 0, z: 2, facing: Math.PI / 2, pose: 'sit', kind: 'seat' },
      { x: 3, z: 1, facing: -Math.PI / 2, pose: 'sit', kind: 'seat' },
      { x: 3, z: 2, facing: -Math.PI / 2, pose: 'sit', kind: 'seat' },
      { x: 1, z: 3, facing: N, pose: 'sit', kind: 'seat' },
      { x: 2, z: 3, facing: N, pose: 'sit', kind: 'seat' },
    ],
    unlockLevel: 1,
    price: 0,
  },
  {
    id: 'round_table',
    name: 'Café Table',
    category: 'tables',
    w: 3,
    d: 1,
    mask: ['SBS'],
    height: 0.75,
    points: [
      { x: 0, z: 0, facing: Math.PI / 2, pose: 'sit', kind: 'seat', tags: ['break'] },
      { x: 2, z: 0, facing: -Math.PI / 2, pose: 'sit', kind: 'seat', tags: ['break'] },
    ],
    unlockLevel: 2,
    price: 30,
  },
  {
    id: 'sofa',
    name: 'Sofa',
    category: 'sofas',
    w: 2,
    d: 1,
    mask: ['SS'],
    height: 0.9,
    points: [
      { x: 0, z: 0, facing: 0, pose: 'sit', kind: 'seat', tags: ['break'] },
      { x: 1, z: 0, facing: 0, pose: 'sit', kind: 'seat', tags: ['break'] },
    ],
    unlockLevel: 1,
    price: 35,
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'sofas',
    w: 1,
    d: 1,
    mask: ['S'],
    height: 0.85,
    points: [{ x: 0, z: 0, facing: 0, pose: 'sit', kind: 'seat', tags: ['break'] }],
    unlockLevel: 1,
    price: 20,
  },
  { id: 'plant_big', name: 'Fiddle Leaf Plant', category: 'plants', w: 1, d: 1, mask: ['B'], height: 1.5, points: [], unlockLevel: 1, price: 12, tags: ['decor'] },
  { id: 'plant_small', name: 'Succulent Pot', category: 'plants', w: 1, d: 1, mask: ['B'], height: 0.6, points: [], unlockLevel: 1, price: 6, tags: ['decor'] },
  { id: 'plant_palm', name: 'Potted Palm', category: 'plants', w: 1, d: 1, mask: ['B'], height: 1.7, points: [], unlockLevel: 2, price: 18, tags: ['decor'] },
  { id: 'lamp_floor', name: 'Floor Lamp', category: 'lighting', w: 1, d: 1, mask: ['B'], height: 1.6, points: [], animated: 'lamp', unlockLevel: 1, price: 14, tags: ['decor'] },
  {
    id: 'coffee_machine',
    name: 'Coffee Machine',
    category: 'appliances',
    w: 1,
    d: 1,
    mask: ['B'],
    height: 1.2,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['break', 'drink'] }],
    animated: 'steam',
    unlockLevel: 1,
    price: 30,
  },
  {
    id: 'water_dispenser',
    name: 'Water Dispenser',
    category: 'appliances',
    w: 1,
    d: 1,
    mask: ['B'],
    height: 1.4,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['break', 'drink'] }],
    animated: 'bubbles',
    unlockLevel: 1,
    price: 15,
  },
  {
    id: 'vending_machine',
    name: 'Vending Machine',
    category: 'appliances',
    w: 1,
    d: 1,
    mask: ['B'],
    height: 1.9,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['break'] }],
    unlockLevel: 1,
    price: 40,
  },
  {
    id: 'whiteboard',
    name: 'Whiteboard',
    category: 'decorations',
    w: 2,
    d: 1,
    mask: ['BB'],
    height: 1.6,
    points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['look'] }],
    unlockLevel: 1,
    price: 15,
  },
  { id: 'screen_present', name: 'Presentation Screen', category: 'decorations', w: 2, d: 1, mask: ['BB'], height: 1.8, points: [], animated: 'screen', unlockLevel: 1, price: 45 },
  { id: 'rug', name: 'Pixel Rug', category: 'decorations', w: 2, d: 2, mask: ['FF', 'FF'], height: 0.02, points: [], unlockLevel: 1, price: 10, tags: ['decor'] },
  { id: 'trophy', name: 'Trophy Stand', category: 'decorations', w: 1, d: 1, mask: ['B'], height: 1.2, points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['look'] }], unlockLevel: 3, price: 50, tags: ['decor'] },
  { id: 'aquarium', name: 'Aquarium', category: 'decorations', w: 2, d: 1, mask: ['BB'], height: 1.3, points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['look'] }], animated: 'bubbles', unlockLevel: 3, price: 80, tags: ['decor'] },
  { id: 'arcade', name: 'Arcade Cabinet', category: 'decorations', w: 1, d: 1, mask: ['B'], height: 1.8, points: [{ x: 0, z: 1, facing: N, pose: 'stand', kind: 'stand', tags: ['break'] }], animated: 'screen', unlockLevel: 4, price: 120, tags: ['decor'] },
];

export const catalogById = new Map(catalog.map((c) => [c.id, c]));
export const getCatalog = (id: string): CatalogItem => {
  const item = catalogById.get(id);
  if (!item) throw new Error(`Unknown catalog item ${id}`);
  return item;
};
