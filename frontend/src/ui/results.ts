import { useEffect } from 'react';
import { create } from 'zustand';
import { botById } from '../../../shared/roster';
import { api, resultsApi, type ResultEntry, type ResultRecord } from '../api';
import { useStore } from '../store';

// Shared state for the Results board and the completion pop-up. Updates are event-driven:
// task_completed / task_failed events for placed tasks arrive over the existing SSE stream.

type ResultsState = {
  entries: ResultEntry[];
  keep: number;
  loaded: boolean;
  error: string | null;
  records: Record<number, ResultRecord>;
  /** Board selection. */
  selected?: number;
  /** Completion pop-up queue (result ids, oldest first) and the one on screen. */
  popup: number[];
  popupIndex: number;
  refresh: () => Promise<void>;
  load: (id: number) => Promise<ResultRecord | undefined>;
  markRead: (id: number) => void;
  openBoard: (id?: number) => void;
};

/** Read marks made here win over a list fetched before the server saw them. */
const readHere = new Set<number>();

export const useResults = create<ResultsState>((set, get) => ({
  entries: [],
  keep: 500,
  loaded: false,
  error: null,
  records: {},
  popup: [],
  popupIndex: 0,
  refresh: async () => {
    if (!api.backend) return;
    try {
      const r = await resultsApi.list();
      const entries = r.results.map((e) => (readHere.has(e.id) ? { ...e, read: true } : e));
      set({ entries, keep: r.keep, loaded: true, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loaded: true });
    }
  },
  load: async (id) => {
    try {
      const rec = await resultsApi.get(id);
      set((s) => ({ records: { ...s.records, [id]: rec } }));
      return rec;
    } catch {
      return undefined;
    }
  },
  markRead: (id) => {
    // The pop-up can show a result before the list has loaded it, so always tell the server.
    if (readHere.has(id) || get().entries.find((x) => x.id === id)?.read) return;
    readHere.add(id);
    set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, read: true } : x)) }));
    void resultsApi.patch(id, { read: true }).catch(() => undefined);
  },
  openBoard: (id) => {
    set({ selected: id ?? get().selected, popup: [], popupIndex: 0 });
    useStore.getState().openModal('results');
  },
}));

const inApp = () => document.visibilityState === 'visible' && document.hasFocus();

/** Mount once: loads the index and reacts to finished placed tasks. */
export function useResultsSync() {
  useEffect(() => {
    if (!api.backend) return;
    const st = useResults.getState;
    void st().refresh();
    const seen = new Set<string>();
    // Events replayed in the connect snapshot are old news: they show as unread on the board instead.
    const openedAt = Date.now() - 500;
    let t: number | undefined;
    const off = useStore.subscribe((s, prev) => {
      if (s.events === prev.events || s.mode !== 'live') return;
      for (const e of s.events.slice(-12)) {
        const id = e.payload?.placedTaskId as number | undefined;
        if (id === undefined || (e.type !== 'task_completed' && e.type !== 'task_failed')) continue;
        const at = Date.parse(e.timestamp);
        if (seen.has(e.id) || at < openedAt || Date.now() - at > 15000) continue;
        seen.add(e.id);
        clearTimeout(t);
        t = window.setTimeout(() => void st().refresh(), 120);
        const name = botById(e.botId)?.name.split(' ')[0] ?? e.botId;
        const title = String(e.payload.title ?? `Task #${id}`);
        const open = () => st().openBoard(id);
        if (e.type === 'task_failed') {
          if (e.payload.status !== 'cancelled')
            useStore
              .getState()
              .toast(`#${id} ${title} failed (${name})`, 'warn', { label: 'Open', run: open });
          continue;
        }
        const pref = useStore.getState().settings.popupOnCompletion;
        if (pref === 'always' || (pref === 'focused' && inApp())) {
          void st().load(id);
          // One window only: add to the queue; the open pop-up shows "1 of N".
          useResults.setState((r) => (r.popup.includes(id) ? r : { popup: [...r.popup, id] }));
        } else
          useStore
            .getState()
            .toast(`#${id} ${title} is done (${name})`, 'good', { label: 'Open', run: open });
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);
}
