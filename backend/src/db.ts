import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BotEvent, EventSource } from '../../shared/types';

export type Store = ReturnType<typeof openStore>;

/** Local SQLite persistence: normalized events + key/value app state (layouts, appearances, settings). */
export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      task_id TEXT,
      ts TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts_ms);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO events (id, bot_id, task_id, ts, ts_ms, type, source, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const getKv = db.prepare('SELECT value FROM kv WHERE key = ?');
  const putKv = db.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  type Row = {
    id: string;
    bot_id: string;
    task_id: string | null;
    ts: string;
    type: string;
    source: string;
    payload: string;
  };
  const toEvent = (r: Row): BotEvent => ({
    id: r.id,
    botId: r.bot_id,
    ...(r.task_id ? { taskId: r.task_id } : {}),
    timestamp: r.ts,
    type: r.type as BotEvent['type'],
    source: r.source as EventSource,
    payload: JSON.parse(r.payload),
  });

  return {
    /** Insert; returns true when the event was new (duplicate ids are ignored). */
    addEvent(e: BotEvent) {
      const res = insert.run(
        e.id,
        e.botId,
        e.taskId ?? null,
        e.timestamp,
        Date.parse(e.timestamp),
        e.type,
        e.source,
        JSON.stringify(e.payload ?? {}),
        Date.now(),
      );
      return res.changes > 0;
    },
    recent(limit = 500, source?: EventSource): BotEvent[] {
      const rows = (
        source
          ? db
              .prepare('SELECT * FROM events WHERE source = ? ORDER BY ts_ms DESC, id DESC LIMIT ?')
              .all(source, limit)
          : db.prepare('SELECT * FROM events ORDER BY ts_ms DESC, id DESC LIMIT ?').all(limit)
      ) as Row[];
      return rows.map(toEvent).reverse();
    },
    range(fromMs: number, toMs: number, limit = 20000): BotEvent[] {
      return (
        db
          .prepare(
            'SELECT * FROM events WHERE ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms ASC, id ASC LIMIT ?',
          )
          .all(fromMs, toMs, limit) as Row[]
      ).map(toEvent);
    },
    timestamps(limit = 100000) {
      return db
        .prepare('SELECT id, ts, source, ts_ms FROM events ORDER BY ts_ms ASC LIMIT ?')
        .all(limit) as { id: string; ts: string; source: EventSource; ts_ms: number }[];
    },
    count() {
      return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    },
    /** Keep the store bounded: drop the oldest simulated events beyond `max`. */
    prune(max = 100000) {
      const n = this.count();
      if (n > max)
        db.prepare(
          "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE source = 'simulated' ORDER BY ts_ms ASC LIMIT ?)",
        ).run(n - max);
    },
    getState<T>(key: string): T | undefined {
      const row = getKv.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    setState(key: string, value: unknown) {
      putKv.run(key, JSON.stringify(value), Date.now());
    },
    close() {
      db.close();
    },
  };
}
