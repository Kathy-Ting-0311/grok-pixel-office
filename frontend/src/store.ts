import { create } from 'zustand';
import { applyEvent, emptyTaskState, type TaskState } from '../../shared/events';
import { createDefaultLayout } from '../../shared/layout';
import {
  applyGameEvent,
  emptyProgression,
  recordChat,
  unlockAchievements,
  type Progression,
} from '../../shared/progression';
import { defaultAppearance, roster } from '../../shared/roster';
import type {
  Appearance,
  BotEvent,
  ConversationLine,
  EventSource,
  FloorType,
  OfficeLayout,
  Rotation,
  WallKind,
} from '../../shared/types';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Mode = 'live' | 'build' | 'replay';
export type Selection =
  | { kind: 'bot'; id: string }
  | { kind: 'furniture'; uid: string }
  | { kind: 'room'; id: string }
  | null;
export type Modal =
  null | 'tasks' | 'meeting' | 'replay' | 'settings' | 'achievements' | 'customize' | 'help';
export type BuildTool = 'select' | 'place' | 'floor' | 'room' | 'wall' | 'erase';
export type Quality = 'low' | 'medium' | 'high';

export type Settings = {
  officeName: string;
  season: 'auto' | Season;
  dayNight: 'off' | 'clock' | 'fast';
  weather: 'auto' | 'clear' | 'rain' | 'snow' | 'clouds';
  quality: Quality;
  pixelArt: boolean;
  walls: 'cutaway' | 'full';
  maxBubbles: number;
  showStats: boolean;
  enableRotate: boolean;
  audio: {
    enabled: boolean;
    muted: boolean;
    master: number;
    ambient: number;
    character: number;
    notification: number;
  };
};

/** Phone-sized screen: side panels become sheets and only one is open at a time. */
export const isNarrow = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches === true;
/** Touch-first device (phones, tablets): start on the cheaper graphics preset. */
export const isTouchDevice = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export const defaultSettings = (): Settings => ({
  officeName: 'Pixel Office',
  season: 'auto',
  dayNight: 'off',
  weather: 'auto',
  quality: isTouchDevice() ? 'low' : 'medium',
  pixelArt: true,
  walls: 'cutaway',
  maxBubbles: 4,
  showStats: false,
  enableRotate: true,
  audio: {
    enabled: false,
    muted: false,
    master: 0.5,
    ambient: 0.4,
    character: 0.6,
    notification: 0.6,
  },
});

export type Connection = 'connecting' | 'backend' | 'fallback';

export type SourcesStatus = {
  simulation: { enabled: boolean; startedAt?: string };
  localCache: {
    state: 'disabled' | 'watching' | 'error';
    dir?: string;
    authorizedAt?: string;
    files: number;
    accepted: number;
    rejected: number;
    unmatchedBots: number;
    duplicates: number;
    lastEventAt?: string;
    lastError?: string;
  };
  officialApi: { available: false; reason: string };
  storedEvents: number;
};

export type Bubble = {
  botId: string;
  text: string;
  source: EventSource;
  kind: 'task' | 'meeting' | 'social' | 'status';
  until: number;
  id: string;
};

export type ReplayState = {
  label: string;
  events: BotEvent[];
  start: number;
  end: number;
  time: number;
  playing: boolean;
  speed: number;
  state: TaskState;
  demo: boolean;
};

type CameraRequest = {
  kind: 'bot' | 'room' | 'reset' | 'tile';
  id?: string;
  x?: number;
  z?: number;
  nonce: number;
};

export type Toast = { id: number; text: string; tone: 'info' | 'good' | 'warn' };

type Store = {
  connection: Connection;
  sources?: SourcesStatus;
  events: BotEvent[];
  live: TaskState;
  conversations: ConversationLine[];
  bubbles: Record<string, Bubble>;
  replay?: ReplayState;

  layout: OfficeLayout;
  past: OfficeLayout[];
  future: OfficeLayout[];
  appearances: Record<string, Appearance>;
  progression: Progression;
  settings: Settings;

  mode: Mode;
  selection: Selection;
  modal: Modal;
  leftOpen: boolean;
  rightOpen: boolean;
  follow?: string;
  camera?: CameraRequest;
  build: {
    tool: BuildTool;
    catalogId?: string;
    rot: Rotation;
    floor: FloorType;
    roomId?: string;
    wallKind: WallKind;
    carrying?: string;
    warning?: string;
  };
  toasts: Toast[];
  simClockStart: number;

  ingest: (events: BotEvent[], opts?: { snapshot?: boolean }) => void;
  setConnection: (c: Connection) => void;
  setSources: (s: SourcesStatus) => void;
  say: (b: Omit<Bubble, 'until' | 'id'> & { duration?: number }) => void;
  chat: (a: string, b: string) => void;

  commitLayout: (next: OfficeLayout, label?: string) => void;
  undo: () => void;
  redo: () => void;
  setAppearance: (botId: string, a: Appearance) => void;
  setProgression: (p: Progression) => void;
  patchSettings: (p: Partial<Settings>) => void;
  patchAudio: (p: Partial<Settings['audio']>) => void;

  setMode: (m: Mode) => void;
  select: (s: Selection) => void;
  openModal: (m: Modal) => void;
  setBuild: (p: Partial<Store['build']>) => void;
  focus: (r: Omit<CameraRequest, 'nonce'>) => void;
  setFollow: (id?: string) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toast: (text: string, tone?: Toast['tone']) => void;

  startReplay: (r: Omit<ReplayState, 'time' | 'playing' | 'speed' | 'state'>) => void;
  setReplay: (p: Partial<ReplayState>) => void;
  stopReplay: () => void;
};

const LS = 'pixel-office:v1:';
export const loadLocal = <T>(key: string): T | undefined => {
  try {
    const raw = localStorage.getItem(LS + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
};
export const saveLocal = (key: string, value: unknown) => {
  try {
    localStorage.setItem(LS + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings stay in memory */
  }
};

const initialAppearances = () =>
  Object.fromEntries(roster.map((b, i) => [b.id, defaultAppearance(b, i)]));

const shortText = (t: string, n = 72) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
let toastId = 0;
let bubbleSeq = 0;

export const useStore = create<Store>((set, get) => ({
  connection: 'connecting',
  events: [],
  live: emptyTaskState(),
  conversations: [],
  bubbles: {},
  layout: loadLocal<OfficeLayout>('layout') ?? createDefaultLayout(),
  past: [],
  future: [],
  appearances: {
    ...initialAppearances(),
    ...(loadLocal<Record<string, Appearance>>('appearances') ?? {}),
  },
  progression: loadLocal<Progression>('progression') ?? emptyProgression(),
  settings: {
    ...defaultSettings(),
    ...(loadLocal<Partial<Settings>>('settings') ?? {}),
    audio: {
      ...defaultSettings().audio,
      ...(loadLocal<Settings>('settings')?.audio ?? {}),
      enabled: false,
    },
  },
  mode: 'live',
  selection: null,
  modal: null,
  leftOpen: !isNarrow(),
  rightOpen: false,
  build: { tool: 'select', rot: 0, floor: 'wood', wallKind: 'wall' },
  toasts: [],
  simClockStart: Date.now(),

  ingest: (incoming, opts) => {
    if (!incoming.length) return;
    const s = get();
    const known = new Set(s.events.slice(-4000).map((e) => e.id));
    const fresh = incoming.filter((e) => !known.has(e.id));
    if (!fresh.length) return;
    let live = s.live;
    let progression = s.progression;
    const conversations = [...s.conversations];
    const bubbles = { ...s.bubbles };
    const now = Date.now();
    for (const e of fresh) {
      live = applyEvent(live, e);
      if (!opts?.snapshot) progression = applyGameEvent(progression, e);
      const recent = now - Date.parse(e.timestamp) < 20000;
      const text = typeof e.payload.text === 'string' ? e.payload.text : undefined;
      if (e.type === 'message' && text) {
        conversations.push({
          id: e.id,
          botId: e.botId,
          text,
          timestamp: e.timestamp,
          source: e.source,
          meetingId: e.payload.meetingId as string | undefined,
          taskId: e.taskId,
        });
        if (recent && s.mode !== 'replay')
          bubbles[e.botId] = {
            id: `b${bubbleSeq++}`,
            botId: e.botId,
            text: shortText(text),
            source: e.source,
            kind: e.payload.meetingId ? 'meeting' : 'task',
            until: now + Math.min(9000, 2800 + text.length * 55),
          };
      }
      if (e.type === 'task_started' && recent && s.mode !== 'replay') {
        const title = typeof e.payload.title === 'string' ? e.payload.title : 'New task';
        bubbles[e.botId] = {
          id: `b${bubbleSeq++}`,
          botId: e.botId,
          text: `📝 ${shortText(title, 48)}`,
          source: e.source,
          kind: 'task',
          until: now + 4500,
        };
      }
    }
    set({
      events: [...s.events, ...fresh].slice(-5000),
      live,
      progression,
      conversations: conversations.slice(-600),
      bubbles,
    });
  },
  setConnection: (connection) => set({ connection }),
  setSources: (sources) => set({ sources }),
  say: ({ duration, ...b }) =>
    set((s) => ({
      bubbles: {
        ...s.bubbles,
        [b.botId]: {
          ...b,
          id: `b${bubbleSeq++}`,
          until: Date.now() + (duration ?? Math.min(9000, 2800 + b.text.length * 55)),
        },
      },
    })),
  chat: (a, b) =>
    set((s) => ({ progression: recordChat(s.progression, a, b, new Date().toISOString()) })),

  commitLayout: (next, label) => {
    const s = get();
    set({
      layout: next,
      past: [...s.past, s.layout].slice(-100),
      future: [],
      progression: unlockAchievements(s.progression, new Date().toISOString(), next),
    });
    if (label) get().toast(label);
  },
  undo: () => {
    const s = get();
    const prev = s.past.at(-1);
    if (!prev) return;
    set({ layout: prev, past: s.past.slice(0, -1), future: [s.layout, ...s.future].slice(0, 100) });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ layout: next, past: [...s.past, s.layout], future: s.future.slice(1) });
  },
  setAppearance: (botId, a) =>
    set((s) => {
      const progression = {
        ...s.progression,
        counters: {
          ...s.progression.counters,
          customizations: s.progression.counters.customizations + 1,
        },
      };
      return {
        appearances: { ...s.appearances, [botId]: a },
        progression: unlockAchievements(progression, new Date().toISOString()),
      };
    }),
  setProgression: (progression) => set({ progression }),
  patchSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
  patchAudio: (p) =>
    set((s) => ({ settings: { ...s.settings, audio: { ...s.settings.audio, ...p } } })),

  setMode: (mode) =>
    set((s) => ({
      mode,
      selection: mode === 'build' && s.selection?.kind === 'bot' ? null : s.selection,
      rightOpen: mode === 'build' && isNarrow() ? false : s.rightOpen,
      build: { ...s.build, carrying: undefined, warning: undefined },
    })),
  select: (selection) =>
    set((s) => ({
      selection,
      rightOpen: selection ? true : s.rightOpen,
      leftOpen: selection && isNarrow() ? false : s.leftOpen,
    })),
  openModal: (modal) => set({ modal }),
  setBuild: (p) => set((s) => ({ build: { ...s.build, ...p } })),
  focus: (r) => set({ camera: { ...r, nonce: Math.random() } }),
  setFollow: (follow) => set({ follow }),
  toggleLeft: () =>
    set((s) => ({
      leftOpen: !s.leftOpen,
      rightOpen: !s.leftOpen && isNarrow() ? false : s.rightOpen,
    })),
  toggleRight: () =>
    set((s) => ({
      rightOpen: !s.rightOpen,
      leftOpen: !s.rightOpen && isNarrow() ? false : s.leftOpen,
    })),
  toast: (text, tone = 'info') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-4) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500);
  },

  startReplay: (r) =>
    set({
      mode: 'replay',
      replay: { ...r, time: r.start - 1, playing: false, speed: 1, state: emptyTaskState() },
      bubbles: {},
      modal: null,
    }),
  setReplay: (p) => set((s) => (s.replay ? { replay: { ...s.replay, ...p } } : {})),
  stopReplay: () => set({ mode: 'live', replay: undefined, bubbles: {} }),
}));

/** Task state currently on display (live monitoring or replay). */
export const displayState = (s: Pick<Store, 'mode' | 'replay' | 'live'>) =>
  s.mode === 'replay' && s.replay ? s.replay.state : s.live;

export const sourceLabel: Record<EventSource, string> = {
  real: 'REAL',
  simulated: 'SIMULATED',
  replayed: 'REPLAYED',
  unknown: 'UNKNOWN',
};
