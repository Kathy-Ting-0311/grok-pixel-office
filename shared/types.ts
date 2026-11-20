// Core data model shared by backend, frontend and tests.

export type EventSource = 'real' | 'simulated' | 'replayed' | 'unknown';

export const botEventTypes = [
  'task_created',
  'task_started',
  'task_updated',
  'task_completed',
  'task_failed',
  'message',
  'meeting_started',
  'meeting_ended',
  'status_changed',
] as const;
export type BotEventType = (typeof botEventTypes)[number];

export type BotEvent = {
  id: string;
  botId: string;
  taskId?: string;
  /** ISO timestamp from the source when available. */
  timestamp: string;
  type: BotEventType;
  source: EventSource;
  payload: Record<string, unknown>;
};

export type TaskStatus = 'pending' | 'active' | 'completed' | 'failed';

export type Task = {
  id: string;
  title: string;
  botId: string;
  status: TaskStatus;
  source: EventSource;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** 0..1 when the source reports it; null = unknown (render indeterminate). */
  progress: number | null;
  summary?: string;
  lastUpdated: string;
};

export type Trait = 'energetic' | 'calm' | 'curious' | 'sociable' | 'focused';

export type Bot = {
  id: string;
  name: string;
  role: string;
  specialty: string;
  color: string;
  personalityText: string;
  trait: Trait;
  isChief: boolean;
  team: string;
};

export type Appearance = {
  hairStyle: 'short' | 'bob' | 'spiky' | 'long' | 'bun' | 'bald';
  hairColor: string;
  skin: string;
  top: 'shirt' | 'hoodie' | 'suit' | 'dress';
  topColor: string;
  bottomColor: string;
  shoes: string;
  glasses: 'none' | 'round' | 'square' | 'shades';
  hat: 'none' | 'cap' | 'beanie' | 'crown' | 'headphones';
  accessory: 'none' | 'tie' | 'scarf' | 'badge' | 'backpack';
  expression: 'happy' | 'neutral' | 'focused' | 'sleepy' | 'wink';
  idle: 'sway' | 'stretch' | 'look' | 'bounce';
};

export type FloorType = 'tile' | 'wood' | 'woodLight' | 'carpetBlue' | 'carpetGreen' | 'checker' | 'concrete';

export type RoomType =
  | 'work'
  | 'executive'
  | 'meeting'
  | 'common'
  | 'recreation'
  | 'server'
  | 'reception'
  | 'kitchen'
  | 'lounge'
  | 'custom';

export type Room = { id: string; name: string; type: RoomType };

export type TileData = {
  floor: FloorType;
  roomId: string | null;
  /** Free-form decoration metadata (e.g. tint, label). */
  meta?: Record<string, string>;
};

export type WallKind = 'wall' | 'glass' | 'window' | 'door' | 'partition';
/** Wall on an edge of tile (x,z): 'n' = between (x,z-1) and (x,z); 'w' = between (x-1,z) and (x,z). */
export type Wall = { x: number; z: number; side: 'n' | 'w'; kind: WallKind };

export type Rotation = 0 | 1 | 2 | 3;
export type FurnitureItem = { uid: string; catalogId: string; x: number; z: number; rot: Rotation };

export type OfficeLayout = {
  version: 1;
  name: string;
  width: number;
  depth: number;
  /** Row-major: tiles[z * width + x]. */
  tiles: TileData[];
  rooms: Room[];
  walls: Wall[];
  furniture: FurnitureItem[];
  /** botId -> furniture uid of an item with a 'desk' interaction point. */
  deskAssignments: Record<string, string>;
  /** Tile where Bots enter / the reachability root. */
  entrance: { x: number; z: number };
};

export type MeetingState = 'gathering' | 'in_progress' | 'ended';
export type Meeting = {
  id: string;
  title: string;
  participants: string[];
  state: MeetingState;
  source: EventSource;
  startedAt: string;
  endedAt?: string;
  messages: { botId: string; text: string; timestamp: string; source: EventSource }[];
};

export type ConversationLine = {
  id: string;
  botId: string;
  text: string;
  timestamp: string;
  source: EventSource;
  meetingId?: string;
  taskId?: string;
};
