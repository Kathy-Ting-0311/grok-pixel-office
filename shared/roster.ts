import type { Appearance, Bot } from './types';

/**
 * Roster carried over unchanged (IDs, names, roles, colours, specialties, teams)
 * from ~/Projects/grok-3d-office/shared/simulation.ts. No production Bots are invented here.
 * `trait` is a cosmetic personality for idle animation only; it never touches real Bot behaviour.
 */
export const roster: Bot[] = [
  {
    id: 'mock-chief-01',
    name: 'Coz',
    role: 'Chief / Team Leader',
    specialty: 'Direction & coordination',
    color: '#60A5FA',
    personalityText: 'Calm, decisive; always connects the next step.',
    trait: 'calm',
    isChief: true,
    team: 'Management & Quality',
  },
  {
    id: 'mock-review-06',
    name: 'Miu Natcha',
    role: 'Reviewer',
    specialty: 'Quality & review',
    color: '#FB923C',
    personalityText: 'Careful and candid; checks every handoff.',
    trait: 'focused',
    isChief: false,
    team: 'Management & Quality',
  },
  {
    id: 'mock-execution-04',
    name: 'Lena Lalina',
    role: 'Execution Specialist',
    specialty: 'Captions & stories',
    color: '#FBBF24',
    personalityText: 'Expressive and focused; turns plans into stories.',
    trait: 'energetic',
    isChief: false,
    team: 'Content & Creative',
  },
  {
    id: 'mock-visual-05',
    name: 'Oom Eisaya',
    role: 'Visual Designer',
    specialty: 'Artwork & direction',
    color: '#F472B6',
    personalityText: 'Curious and visual; prefers showing a concept.',
    trait: 'curious',
    isChief: false,
    team: 'Content & Creative',
  },
  {
    id: 'mock-research-02',
    name: 'Krystal',
    role: 'Research Specialist',
    specialty: 'Music discovery',
    color: '#2DD4BF',
    personalityText: 'Methodical and inquisitive; shares her notes.',
    trait: 'focused',
    isChief: false,
    team: 'Research & Strategy',
  },
  {
    id: 'mock-strategy-03',
    name: 'Piploy',
    role: 'Strategy Specialist',
    specialty: 'Audience & planning',
    color: '#A3C96A',
    personalityText: 'Thoughtful and practical; makes room for discovery.',
    trait: 'sociable',
    isChief: false,
    team: 'Research & Strategy',
  },
];

export const botById = (id: string) => roster.find((b) => b.id === id);

const presets: Record<string, Partial<Appearance>> = {
  'mock-chief-01': { hairStyle: 'short', hairColor: '#2B2118', top: 'suit', accessory: 'tie', glasses: 'square' },
  'mock-review-06': { hairStyle: 'bob', hairColor: '#5B3A29', top: 'shirt', glasses: 'round', accessory: 'badge' },
  'mock-execution-04': { hairStyle: 'long', hairColor: '#A0522D', top: 'dress', hat: 'none', expression: 'wink', idle: 'bounce' },
  'mock-visual-05': { hairStyle: 'bun', hairColor: '#1F1A17', top: 'hoodie', hat: 'beanie', idle: 'look' },
  'mock-research-02': { hairStyle: 'spiky', hairColor: '#E8C170', top: 'shirt', glasses: 'round', expression: 'focused' },
  'mock-strategy-03': { hairStyle: 'short', hairColor: '#3B2A20', top: 'hoodie', hat: 'cap', accessory: 'backpack', idle: 'stretch' },
};

const skins = ['#F6D2B5', '#E8B894', '#C98E66', '#9A6546', '#F1C9A5', '#D7A27C'];

export function defaultAppearance(bot: Bot, index = roster.indexOf(bot)): Appearance {
  return {
    hairStyle: 'short',
    hairColor: '#3B2A20',
    skin: skins[Math.max(0, index) % skins.length],
    top: 'shirt',
    topColor: bot.color,
    bottomColor: '#3D4A66',
    shoes: '#2B2118',
    glasses: 'none',
    hat: 'none',
    accessory: 'none',
    expression: 'happy',
    idle: 'sway',
    ...presets[bot.id],
  };
}
