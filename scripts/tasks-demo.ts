// Submits 3 tasks to a throwaway server in MOCK_MODE and prints every event it streams.
// No API key is read and nothing is billed. Run: npm run tasks:demo
import { buildServer } from '../backend/src/index';
import { loadGrokConfig } from '../backend/src/config';

process.env.MOCK_DELAY_MS ??= '40';
const grok = { ...loadGrokConfig({ MOCK_MODE: 'true' }), concurrency: 2 };
const { app } = await buildServer({
  dbPath: ':memory:',
  tasksFile: ':memory:',
  simulation: false,
  grok,
});
await app.listen({ host: '127.0.0.1', port: 0 });
const addr = app.server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

const seen = new Set<number>();
const done = new Set<number>();
const ctl = new AbortController();
const stream = await fetch(`${base}/api/stream`, { signal: ctl.signal });
const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();

const tasks = [
  { title: 'Write a 3-line weekly report', agent: 'auto', priority: 'normal' },
  { title: 'Review the caption draft', agent: 'mock-review-06', priority: 'high' },
  {
    title: 'List three research questions',
    agent: 'auto',
    priority: 'low',
    details: 'Topic: new indie releases.',
  },
];
for (const t of tasks) {
  const r = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  const body = (await r.json()) as { id: number; agent: string; status: string };
  seen.add(body.id);
  console.log(
    `POST /api/tasks -> ${r.status}  #${body.id} "${t.title}" agent=${body.agent} status=${body.status}`,
  );
}

let buf = '';
const deadline = setTimeout(() => {
  console.error('Timed out waiting for tasks to finish.');
  process.exit(1);
}, 20000);
while (done.size < seen.size) {
  const { value, done: end } = await reader.read();
  if (end) break;
  buf += value;
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (!block.startsWith('event: event')) continue;
    const e = JSON.parse(block.split('\ndata: ')[1]);
    const p = e.payload;
    const extra = [
      p.status && `status=${p.status}`,
      p.text && `"${String(p.text).slice(0, 70)}"`,
      p.summary && `summary="${String(p.summary).slice(0, 60)}"`,
      p.tokens_in !== undefined && `tokens ${p.tokens_in}/${p.tokens_out} ${p.model}`,
    ]
      .filter(Boolean)
      .join('  ');
    console.log(
      `#${p.placedTaskId} ${e.type.padEnd(14)} ${e.botId.padEnd(18)} [${e.source}] ${extra}`,
    );
    if (e.type === 'task_completed' || e.type === 'task_failed') done.add(p.placedTaskId);
  }
}
clearTimeout(deadline);
const list = (await (await fetch(`${base}/api/tasks`)).json()) as {
  tasks: { id: number; status: string; tokensIn: number; tokensOut: number; costUsd: number }[];
};
console.log('\nGET /api/tasks:');
for (const t of list.tasks)
  console.log(`  #${t.id} ${t.status}  tokens ${t.tokensIn}/${t.tokensOut}  cost $${t.costUsd}`);
ctl.abort();
await app.close();
