// SYNTHETIC fixtures in the shape of patched grok-bot-cli 9616503 `--json` output
// (bots list, groups list, thread, thread --after). Ids and text are invented; no real transcript
// content is stored in the repo.

export const OWNER = '00000000-0000-4000-8000-000000000001';
export const COZ = '11111111-1111-4111-8111-111111111111';
export const KRYSTAL = '22222222-2222-4222-8222-222222222222';
export const HELPER = '33333333-3333-4333-8333-333333333333';
export const GROUP = '99999999-9999-4999-8999-999999999999';
export const STRANGER = '44444444-4444-4444-8444-444444444444';

export const bots = [
  { id: COZ, name: 'Coz · Chief', kind: 'bot', description: '', hiddenFromSidebar: false },
  {
    id: KRYSTAL,
    name: 'Krystal · Research',
    kind: 'bot',
    description: '',
    hiddenFromSidebar: false,
  },
  { id: HELPER, name: 'Helper Bot', kind: 'bot', description: '', hiddenFromSidebar: false },
  { id: OWNER, name: 'Owner', kind: 'bot', description: '', hiddenFromSidebar: false },
];

export const groups = [
  {
    id: GROUP,
    name: 'Test Team',
    kind: 'group',
    members: [COZ, KRYSTAL],
    hiddenFromSidebar: false,
  },
];

const target = (id: string, name: string, isGroup: boolean, memberIds: string[] = []) => ({
  id,
  name,
  title: '',
  description: name,
  avatarShape: 'tablet',
  avatarColor: 'black',
  notifyOnAgentUpdates: true,
  hiddenFromSidebar: false,
  isGroup,
  memberIds,
});

export const ts = (n: number) => 1795000000000 + n * 1000;

/** A 1:1 bot reply: no author, no role (as observed). */
export const sendMessage = (id: string, seq: number, text: string, extra = {}) => ({
  kind: 'send-message',
  id,
  message: { type: 'text', content: text },
  timestampMs: ts(seq),
  requestId: `req-${id}`,
  seq,
  ...extra,
});
export const userMessage = (id: string, seq: number, text: string) => ({
  kind: 'message',
  id,
  role: 'user',
  content: text,
  isStreaming: false,
  timestampMs: ts(seq),
  clientNonce: `nonce-${id}`,
  seq,
});
export const assistantMessage = (id: string, seq: number, text: string, extra = {}) => ({
  kind: 'message',
  id,
  role: 'assistant',
  content: text,
  isStreaming: false,
  timestampMs: ts(seq),
  seq,
  ...extra,
});

export const thread = (
  id: string,
  entries: unknown[],
  opts: { name?: string; isGroup?: boolean; after?: { cursor: string; gapReset?: boolean } } = {},
) => ({
  target: target(
    id,
    opts.name ?? 'Thread',
    opts.isGroup ?? false,
    opts.isGroup ? [COZ, KRYSTAL] : [],
  ),
  transcript: { entries, ...(opts.after ? {} : { nextBeforeSeq: 1, precedingTimestampMs: ts(0) }) },
  ...(opts.after
    ? { cursor: opts.after.cursor, entryCount: entries.length, gapReset: !!opts.after.gapReset }
    : {}),
});
