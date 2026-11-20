/** Screen-space layout for floating head labels and speech bubbles. Pure and testable. */

export type BubbleInput = {
  id: string;
  /** Anchor in screen pixels (head top). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Higher wins space first. */
  priority: number;
  /** Camera-relative distance factor (0 near .. 1 far); far items may be culled. */
  distance?: number;
};

export type BubblePlacement = { id: string; x: number; y: number; visible: boolean; lift: number };

type Rect = { l: number; t: number; r: number; b: number };
const overlap = (a: Rect, b: Rect, pad: number) => a.l < b.r + pad && a.r + pad > b.l && a.t < b.b + pad && a.b + pad > b.t;

export type LayoutOptions = {
  maxVisible: number;
  viewport: { width: number; height: number };
  /** Vertical step when lifting a bubble to dodge another. */
  step?: number;
  maxLift?: number;
  padding?: number;
  maxDistance?: number;
};

/**
 * Greedy priority placement: highest priority first; each bubble tries its anchor then lifts upwards
 * in steps; if it still collides (or would exceed maxVisible, leave the viewport, or be too far),
 * it is hidden. Returns placements in input order.
 */
export function layoutBubbles(items: BubbleInput[], o: LayoutOptions): BubblePlacement[] {
  const step = o.step ?? 14;
  const maxLift = o.maxLift ?? 3;
  const pad = o.padding ?? 4;
  const placed: Rect[] = [];
  const out = new Map<string, BubblePlacement>();
  const order = [...items].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
  let visible = 0;
  for (const it of order) {
    const hidden = { id: it.id, x: it.x, y: it.y, visible: false, lift: 0 };
    if (visible >= o.maxVisible || (it.distance ?? 0) > (o.maxDistance ?? 1)) {
      out.set(it.id, hidden);
      continue;
    }
    let done = false;
    for (let lift = 0; lift <= maxLift; lift++) {
      const y = it.y - lift * step;
      const rect = { l: it.x - it.width / 2, r: it.x + it.width / 2, t: y - it.height, b: y };
      if (rect.r < 0 || rect.l > o.viewport.width || rect.b < 0 || rect.t > o.viewport.height) break;
      if (placed.some((p) => overlap(rect, p, pad))) continue;
      placed.push(rect);
      out.set(it.id, { id: it.id, x: it.x, y, visible: true, lift });
      visible++;
      done = true;
      break;
    }
    if (!done) out.set(it.id, hidden);
  }
  return items.map((it) => out.get(it.id)!);
}

export const bubbleDuration = (text: string) => Math.min(9000, 2800 + text.length * 55);

/** Priority scale used by the app: real task updates > meetings > tasks > simulated chatter. */
export const bubblePriority = (opts: { source: string; kind: 'task' | 'meeting' | 'social' | 'status'; selected?: boolean }) =>
  (opts.selected ? 100 : 0) + (opts.source === 'real' ? 40 : 0) + { task: 20, meeting: 25, social: 5, status: 0 }[opts.kind];
