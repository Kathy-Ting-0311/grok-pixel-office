import type { LiveMessage } from './liveControl';

/**
 * State of a manually tracked Grok Bot Desktop task. Only "completed" and "result-available" come from the user
 * (Mark as Completed, linking a saved result). "waiting-input" and "working" come only from real entries observed
 * after the request; anything else stays "tracked". Nothing is ever inferred from message wording.
 */
export type DesktopTaskState =
  'tracked' | 'working' | 'waiting-input' | 'result-available' | 'completed';

/** Entry types where the bot is waiting for the user (forms, choice widgets, permission requests). */
export const INPUT_TYPES = new Set(['widget', 'user-form', 'local-tool-permission']);

export function desktopTaskState(
  t: { requestedAt: string; resultIds: number[]; completedAt?: string },
  messages: LiveMessage[],
): { state: DesktopTaskState; basis: string } {
  if (t.completedAt) return { state: 'completed', basis: 'Marked as completed by you.' };
  if (t.resultIds.length)
    return {
      state: 'result-available',
      basis: `You linked ${t.resultIds.length} saved result(s).`,
    };
  const since = Date.parse(t.requestedAt);
  const last = messages
    .filter((m) => Date.parse(m.timestamp) > since && m.attribution !== 'owner')
    .at(-1);
  const type = last?.placeholder?.type;
  if (type && INPUT_TYPES.has(type))
    return {
      state: 'waiting-input',
      basis: `The bot's latest entry asks for your input (${type}).`,
    };
  if (type === 'cursor-agent')
    return { state: 'working', basis: "The bot's latest entry started a background agent." };
  return { state: 'tracked', basis: 'Tracked by you. No progress is inferred from replies.' };
}
