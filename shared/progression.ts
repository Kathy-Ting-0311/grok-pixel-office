import type { BotEvent, OfficeLayout } from './types';
import { getCatalog } from './catalog';

/**
 * Cosmetic game layer. XP / coins are toys: they are NOT a measure of AI model performance.
 * Only simulated events and source-verified REAL completions count; UNKNOWN and REPLAYED never do.
 */
export type Progression = {
  officeXp: number;
  coins: number;
  botXp: Record<string, number>;
  achievements: Record<string, string>;
  unlocked: string[];
  counters: { tasksObserved: number; meetings: number; chats: number; customizations: number };
};

export const emptyProgression = (): Progression => ({
  officeXp: 0,
  coins: 50,
  botXp: {},
  achievements: {},
  unlocked: [],
  counters: { tasksObserved: 0, meetings: 0, chats: 0, customizations: 0 },
});

export const levelFor = (xp: number) => 1 + Math.floor(Math.sqrt(xp / 60));
export const xpForLevel = (level: number) => (level - 1) ** 2 * 60;

export const achievementDefs = [
  { id: 'first_expansion', name: 'First Office Expansion', description: 'Grow the office floor beyond 16 × 12.' },
  { id: 'first_meeting', name: 'First Team Meeting', description: 'Watch a meeting from start to finish.' },
  { id: 'ten_tasks', name: 'Ten Tasks Observed', description: 'Observe ten finished tasks (simulated or verified).' },
  { id: 'decorated', name: 'Fully Decorated Office', description: 'Place twelve decorative items.' },
  { id: 'stylist', name: 'Office Stylist', description: 'Customise a Bot’s look.' },
  { id: 'social', name: 'Water-Cooler Talk', description: 'Observe ten idle chats.' },
] as const;

const countable = (e: BotEvent) => e.source === 'simulated' || e.source === 'real';

export function applyGameEvent(p: Progression, e: BotEvent): Progression {
  if (!countable(e)) return p;
  const next: Progression = { ...p, botXp: { ...p.botXp }, counters: { ...p.counters }, achievements: { ...p.achievements } };
  const give = (bot: string, xp: number) => (next.botXp[bot] = (next.botXp[bot] ?? 0) + xp);
  if (e.type === 'task_completed') {
    give(e.botId, 12);
    next.officeXp += 10;
    next.coins += 6;
    next.counters.tasksObserved++;
  } else if (e.type === 'task_failed') {
    give(e.botId, 3);
    next.counters.tasksObserved++;
  } else if (e.type === 'meeting_ended') {
    next.officeXp += 15;
    next.coins += 8;
    next.counters.meetings++;
  } else if (e.type === 'meeting_started') {
    const parts = Array.isArray(e.payload.participants) ? (e.payload.participants as string[]) : [];
    parts.forEach((b) => give(b, 4));
  } else return p;
  return unlockAchievements(next, e.timestamp);
}

export function recordChat(p: Progression, a: string, b: string, at: string): Progression {
  const next = { ...p, botXp: { ...p.botXp }, counters: { ...p.counters, chats: p.counters.chats + 1 } };
  next.botXp[a] = (next.botXp[a] ?? 0) + 1;
  next.botXp[b] = (next.botXp[b] ?? 0) + 1;
  next.officeXp += 1;
  return unlockAchievements(next, at);
}

export function unlockAchievements(p: Progression, at: string, layout?: OfficeLayout): Progression {
  const a = { ...p.achievements };
  const grant = (id: string) => {
    if (!a[id]) a[id] = at;
  };
  if (p.counters.meetings >= 1) grant('first_meeting');
  if (p.counters.tasksObserved >= 10) grant('ten_tasks');
  if (p.counters.chats >= 10) grant('social');
  if (p.counters.customizations >= 1) grant('stylist');
  if (layout) {
    if (layout.width * layout.depth > 16 * 12) grant('first_expansion');
    const decor = layout.furniture.filter((f) => {
      const c = getCatalog(f.catalogId);
      return c.tags?.includes('decor') || c.category === 'plants' || c.category === 'decorations';
    }).length;
    if (decor >= 12) grant('decorated');
  }
  const gained = Object.keys(a).length - Object.keys(p.achievements).length;
  return { ...p, achievements: a, coins: p.coins + gained * 25 };
}

export function canUse(p: Progression, catalogId: string) {
  const c = getCatalog(catalogId);
  return c.price === 0 || p.unlocked.includes(catalogId) || (c.unlockLevel <= 1 && c.price <= 40);
}

export function buyItem(p: Progression, catalogId: string): Progression | string {
  const c = getCatalog(catalogId);
  if (canUse(p, catalogId)) return p;
  if (levelFor(p.officeXp) < c.unlockLevel) return `Reach office level ${c.unlockLevel} to unlock ${c.name}.`;
  if (p.coins < c.price) return `Needs ${c.price} coins.`;
  return { ...p, coins: p.coins - c.price, unlocked: [...p.unlocked, catalogId] };
}

/** Cosmetic accessory unlocks by office level. */
export const cosmeticUnlocks: Record<string, number> = { crown: 3, headphones: 2, shades: 2, scarf: 2, backpack: 1 };
