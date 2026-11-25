import { z } from 'zod';

// Shapes observed from the patched grok-bot-cli (commit 9616503) with --json. The CLI's output is
// undocumented, so every object is loose (extra fields are kept) and entries are parsed one by one.

export const botSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().default(''),
  kind: z.string().optional(),
});
export const botsSchema = z.array(botSchema);

export const groupSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().default(''),
  members: z.array(z.string()).default([]),
});
export const groupsSchema = z.array(groupSchema);

const ref = z.looseObject({ id: z.string().min(1), name: z.string().optional() });

export const entrySchema = z.looseObject({
  kind: z.string(),
  id: z.string().optional(),
  role: z.string().optional(),
  content: z.unknown().optional(),
  text: z.unknown().optional(),
  message: z.unknown().optional(),
  timestampMs: z.number().optional(),
  seq: z.number().optional(),
  author: ref.optional(),
  toAgent: ref.optional(),
  isStreaming: z.boolean().optional(),
});
export type Entry = z.infer<typeof entrySchema>;

export const threadSchema = z.looseObject({
  target: z.looseObject({
    id: z.string().min(1),
    name: z.string().optional(),
    isGroup: z.boolean().optional(),
    memberIds: z.array(z.string()).optional(),
  }),
  transcript: z.looseObject({ entries: z.array(z.unknown()) }),
  cursor: z.string().optional(),
  gapReset: z.boolean().optional(),
});
export type ThreadOut = z.infer<typeof threadSchema>;
