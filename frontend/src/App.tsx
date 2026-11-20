import { useEffect, useState } from 'react';
import { useStore } from './store';
import { audio } from './systems/audio';
import { Scene, perf } from './scene/Scene';
import { BottomToolbar, LeftSidebar, TopBar } from './ui/Bars';
import { RightPanel } from './ui/RightPanel';
import { ResultsBoard } from './ui/ResultsBoard';
import { CompletionPopup } from './ui/CompletionPopup';
import { useResultsSync } from './ui/results';
import { useBoardSync } from './ui/TaskComposer';
import { BuildPanel } from './ui/BuildPanel';
import { Dashboard } from './ui/Dashboard';
import {
  AchievementsModal,
  Customizer,
  HelpModal,
  MeetingPanel,
  ReplayBar,
  ReplayPicker,
  SettingsModal,
} from './ui/Modals';

function StatsOverlay() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      className="pointer-events-none absolute right-2 top-28 z-20 sm:right-[19.5rem] sm:top-16 rounded border-2 border-ink bg-ink/85 px-2 py-1 font-pixel text-[10px] leading-4 text-lime-200"
      data-testid="stats"
    >
      <div>FPS {perf.fps}</div>
      <div>Draw calls {perf.calls}</div>
      <div>Triangles {perf.triangles.toLocaleString()}</div>
      <div>
        Geometries {perf.geometries} · Textures {perf.textures}
      </div>
      <div>
        Programs {perf.programs} · Characters {perf.characters}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-16 z-50 flex -translate-x-1/2 flex-col items-center gap-1"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`panel px-3 py-1 text-xs font-bold ${t.tone === 'warn' ? '!bg-rose-100' : t.tone === 'good' ? '!bg-emerald-100' : ''}`}
        >
          {t.text}
          {t.action && (
            <button
              className="btn pointer-events-auto ml-2 !min-h-0 !px-1.5 !py-0 !text-[10px]"
              onClick={() => {
                t.action!.run();
                useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
              }}
              data-testid="toast-action"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const mode = useStore((s) => s.mode);
  const modal = useStore((s) => s.modal);
  const showStats = useStore((s) => s.settings.showStats);
  const audioSettings = useStore((s) => s.settings.audio);
  useResultsSync();
  // Task cards in chats stay live even when no task form is open.
  useBoardSync();
  useEffect(() => audio.apply(audioSettings), [audioSettings]);
  // Notification sounds for fresh live events.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.events === prev.events || s.mode !== 'live') return;
        const last = s.events.at(-1);
        if (!last || Date.now() - Date.parse(last.timestamp) > 5000) return;
        if (last.type === 'task_completed') audio.notify('done');
        if (last.type === 'task_failed') audio.notify('fail');
        if (last.type === 'meeting_started') audio.notify('meeting');
      }),
    [],
  );
  return (
    <main className="relative h-full w-full overflow-hidden">
      <Scene />
      <TopBar />
      {mode === 'build' ? <BuildPanel /> : <LeftSidebar />}
      <RightPanel />
      <BottomToolbar />
      {mode === 'replay' && <ReplayBar />}
      {showStats && <StatsOverlay />}
      <Toasts />
      {modal === 'tasks' && <Dashboard />}
      {modal === 'meeting' && <MeetingPanel />}
      {modal === 'replay' && <ReplayPicker />}
      {modal === 'settings' && <SettingsModal />}
      {modal === 'achievements' && <AchievementsModal />}
      {modal === 'customize' && <Customizer />}
      {modal === 'help' && <HelpModal />}
      {modal === 'results' && <ResultsBoard />}
      <CompletionPopup />
    </main>
  );
}
