import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { activeTaskFor } from '../../../shared/events';
import { bubblePriority, layoutBubbles } from '../../../shared/bubbles';
import { roster } from '../../../shared/roster';
import type { VisualState } from '../../../shared/behavior';
import type { EventSource } from '../../../shared/types';
import { displayState, useStore } from '../store';
import { world } from '../systems/world';
import { headAnchors } from './Character';

/** DOM elements per Bot, positioned imperatively every frame (no React re-render per frame). */
const nodes = new Map<string, HTMLDivElement>();
const sizes = new Map<string, { w: number; h: number }>();

export const stateIcon: Record<VisualState, string> = {
  IDLE: '•',
  WANDERING: '🚶',
  WALKING_TO_DESK: '🚶',
  WORKING: '⌨️',
  THINKING: '💭',
  TALKING: '💬',
  MEETING: '👥',
  BREAK: '☕',
  COMPLETED: '✅',
  ERROR: '⚠️',
  OFFLINE: '💤',
};
export const stateLabel: Record<VisualState, string> = {
  IDLE: 'Idle',
  WANDERING: 'Wandering',
  WALKING_TO_DESK: 'To desk',
  WORKING: 'Working',
  THINKING: 'Thinking',
  TALKING: 'Chatting',
  MEETING: 'In meeting',
  BREAK: 'Break',
  COMPLETED: 'Completed',
  ERROR: 'Error',
  OFFLINE: 'Offline',
};
export const sourceClass: Record<EventSource, string> = {
  real: 'bg-emerald-600 text-white',
  simulated: 'bg-violet-600 text-white',
  replayed: 'bg-blue-600 text-white',
  unknown: 'bg-stone-500 text-white',
};
const short: Record<EventSource, string> = {
  real: 'REAL',
  simulated: 'SIM',
  replayed: 'REPLAY',
  unknown: '?',
};

/** Inside the Canvas: projects anchors and lays bubbles out. */
export function OverlaySync() {
  const { camera, size } = useThree();
  const v = useRef(new THREE.Vector3());
  const acc = useRef(0);
  const placement = useRef(new Map<string, { visible: boolean; lift: number }>());
  useFrame((_, dt) => {
    acc.current += dt;
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    const s = useStore.getState();
    const screen = new Map<string, { x: number; y: number }>();
    for (const [id, anchor] of headAnchors) {
      v.current.copy(anchor).project(camera);
      screen.set(id, {
        x: (v.current.x * 0.5 + 0.5) * size.width,
        y: (-v.current.y * 0.5 + 0.5) * size.height,
      });
    }
    if (acc.current > 0.12) {
      acc.current = 0;
      for (const [id, el] of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width) sizes.set(id, { w: r.width, h: r.height });
      }
      const now = Date.now();
      const sel = s.selection?.kind === 'bot' ? s.selection.id : undefined;
      const items = [...screen].map(([id, p]) => {
        const bubble = s.bubbles[id] && s.bubbles[id].until > now ? s.bubbles[id] : undefined;
        const sz = sizes.get(id) ?? { w: 110, h: 24 };
        return {
          id,
          x: p.x,
          y: p.y,
          width: sz.w,
          height: sz.h,
          priority: bubble
            ? bubblePriority({ source: bubble.source, kind: bubble.kind, selected: sel === id })
            : sel === id
              ? 100
              : 1,
          distance: zoom < 20 && !bubble && sel !== id ? 2 : 0,
        };
      });
      const out = layoutBubbles(items, {
        maxVisible: s.settings.maxBubbles + roster.length,
        viewport: size,
        step: 16,
        maxLift: 3,
        padding: 2,
      });
      placement.current = new Map(out.map((o) => [o.id, { visible: o.visible, lift: o.lift }]));
      // Limit simultaneous speech bubbles to maxBubbles (by priority) — names may still show.
      const withBubble = items
        .filter((i) => s.bubbles[i.id] && s.bubbles[i.id].until > now)
        .sort((a, b) => b.priority - a.priority);
      withBubble
        .slice(s.settings.maxBubbles)
        .forEach((i) => nodes.get(i.id)?.setAttribute('data-bubble-hidden', '1'));
      withBubble
        .slice(0, s.settings.maxBubbles)
        .forEach((i) => nodes.get(i.id)?.removeAttribute('data-bubble-hidden'));
    }
    for (const [id, p] of screen) {
      const el = nodes.get(id);
      if (!el) continue;
      const pl = placement.current.get(id);
      const lift = (pl?.lift ?? 0) * 16;
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - lift)}px) translate(-50%, -100%)`;
      el.style.opacity = pl && !pl.visible ? '0' : '1';
      el.style.zIndex = String(Math.round(p.y));
    }
  });
  return null;
}

type Label = {
  id: string;
  name: string;
  color: string;
  state: VisualState;
  task?: string;
  progress?: number | null;
  source?: EventSource;
  bubble?: { text: string; source: EventSource; kind: string };
};

/** Outside the Canvas: the label DOM, refreshed ~4×/s. */
export function HeadLabels() {
  const [labels, setLabels] = useState<Label[]>([]);
  const selected = useStore((s) => (s.selection?.kind === 'bot' ? s.selection.id : undefined));
  const mode = useStore((s) => s.mode);
  useEffect(() => {
    const tick = () => {
      const s = useStore.getState();
      const state = displayState(s);
      const now = Date.now();
      setLabels(
        roster.map((b) => {
          const brain = world.brains.get(b.id);
          const task = activeTaskFor(state, b.id);
          const bubble =
            s.bubbles[b.id] && s.bubbles[b.id].until > now ? s.bubbles[b.id] : undefined;
          return {
            id: b.id,
            name: b.name.split(' ')[0],
            color: b.color,
            state: brain?.state ?? 'IDLE',
            task: task?.title,
            progress: task?.progress,
            source: task?.source,
            bubble: bubble && { text: bubble.text, source: bubble.source, kind: bubble.kind },
          };
        }),
      );
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      className="pointer-events-none absolute inset-0 isolate z-10 overflow-hidden"
      aria-hidden={mode === 'build'}
    >
      {labels.map((l) => (
        <div
          key={l.id}
          ref={(el) => {
            if (el) nodes.set(l.id, el);
            else nodes.delete(l.id);
          }}
          className={`head-stack absolute left-0 top-0 flex flex-col items-center gap-1 transition-opacity duration-200 ${mode === 'build' ? 'hidden' : ''}`}
          data-bot={l.id}
        >
          {l.bubble && (
            <button
              type="button"
              className="bubble pointer-events-auto max-w-[200px] rounded-md border-2 border-ink bg-white px-2 py-1 text-left text-[11px] leading-tight text-ink shadow-[2px_2px_0_rgba(43,33,24,0.35)]"
              onClick={() => {
                const s = useStore.getState();
                s.select({ kind: 'bot', id: l.id });
                useStore.setState({ rightOpen: true });
                window.dispatchEvent(new CustomEvent('open-conversation', { detail: l.id }));
              }}
              title="Open conversation"
            >
              <span
                className={`mr-1 rounded px-1 text-[8px] font-bold ${sourceClass[l.bubble.source]}`}
              >
                {short[l.bubble.source]}
              </span>
              {l.bubble.text}
            </button>
          )}
          <div
            className={`flex items-center gap-1 whitespace-nowrap rounded-full border-2 px-1.5 py-[1px] text-[10px] font-bold shadow-sm ${selected === l.id ? 'border-amber-400 bg-amber-50' : 'border-ink/70 bg-cream/95'}`}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
            <span className="text-ink">{l.name}</span>
            <span title={stateLabel[l.state]}>{stateIcon[l.state]}</span>
            {l.task &&
              (l.state === 'WORKING' ||
                l.state === 'THINKING' ||
                l.state === 'WALKING_TO_DESK') && (
                <>
                  {l.progress != null ? (
                    <span className="relative h-1.5 w-8 overflow-hidden rounded bg-stone-300">
                      <span
                        className="absolute inset-y-0 left-0 bg-emerald-500"
                        style={{ width: `${Math.round(l.progress * 100)}%` }}
                      />
                    </span>
                  ) : (
                    <span
                      className="indeterminate relative h-1.5 w-8 overflow-hidden rounded bg-stone-300"
                      title="Progress unknown"
                    />
                  )}
                  {l.source && (
                    <span className={`rounded px-1 text-[8px] ${sourceClass[l.source]}`}>
                      {short[l.source]}
                    </span>
                  )}
                </>
              )}
          </div>
        </div>
      ))}
    </div>
  );
}
