import { useEffect, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Hammer,
  History,
  ListChecks,
  RotateCcw,
  RotateCw,
  Settings,
  Shirt,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  CircleHelp,
} from 'lucide-react';
import { taskStats } from '../../../shared/events';
import { levelFor, xpForLevel } from '../../../shared/progression';
import { roster } from '../../../shared/roster';
import { displayState, isNarrow, useStore } from '../store';
import { world } from '../systems/world';
import { audio } from '../systems/audio';
import { cameraApi } from '../scene/CameraRig';
import { resolveSeason, dayPhase } from '../scene/Environment';
import { stateIcon, stateLabel } from '../scene/Overlay';
import { ago } from './common';

const seasonIcon = { spring: '🌸', summer: '☀️', autumn: '🍂', winter: '❄️' };

/** Tracks the phone breakpoint so labels can switch to short forms. */
function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 639px)');
    const update = () => setNarrow(m.matches);
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function TopBar() {
  const narrow = useNarrow();
  const settings = useStore((s) => s.settings);
  const mode = useStore((s) => s.mode);
  const connection = useStore((s) => s.connection);
  const sources = useStore((s) => s.sources);
  const state = useStore(displayState);
  const progression = useStore((s) => s.progression);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const stats = taskStats(Object.values(state.tasks));
  const season = resolveSeason(settings.season);
  const phase = dayPhase(settings.dayNight);
  const clock =
    settings.dayNight === 'off'
      ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : `${String(Math.floor(phase * 24)).padStart(2, '0')}:${String(Math.floor((phase * 1440) % 60)).padStart(2, '0')}`;
  const realCache = sources?.localCache.state === 'watching';
  const feed =
    mode === 'replay'
      ? {
          text: 'REPLAY',
          short: 'REPLAY',
          cls: 'bg-blue-600 text-white',
          title: 'Showing historical events',
        }
      : connection === 'fallback'
        ? {
            text: 'BROWSER SIMULATION',
            short: 'SIMULATED',
            cls: 'bg-violet-600 text-white',
            title: 'Local backend not reachable: fictional activity generated in this browser.',
          }
        : connection === 'connecting'
          ? { text: 'CONNECTING…', short: 'CONNECTING…', cls: 'bg-stone-500 text-white', title: '' }
          : realCache
            ? {
                text: sources?.simulation.enabled ? 'LOCAL CACHE + SIM' : 'LOCAL CACHE',
                short: sources?.simulation.enabled ? 'CACHE + SIM' : 'CACHE',
                cls: 'bg-emerald-600 text-white',
                title: `Watching ${sources?.localCache.dir}`,
              }
            : sources?.simulation.enabled
              ? {
                  text: 'SIMULATION',
                  short: 'SIMULATED',
                  cls: 'bg-violet-600 text-white',
                  title: 'No real data source authorised. All activity is fictional.',
                }
              : {
                  text: 'NO SOURCE',
                  short: 'NO SOURCE',
                  cls: 'bg-stone-500 text-white',
                  title: 'No provider is producing events.',
                };
  const level = levelFor(progression.officeXp);
  return (
    <header
      className="panel absolute left-2 right-2 top-2 z-20 flex h-11 items-center gap-2 px-2 sm:gap-3 sm:px-3"
      data-testid="topbar"
    >
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden sm:gap-2">
        <span className="text-lg max-sm:hidden" aria-hidden>
          🏢
        </span>
        <input
          className="w-24 min-w-0 bg-transparent text-sm font-extrabold outline-none focus:underline sm:w-36"
          value={settings.officeName}
          onChange={(e) =>
            useStore.getState().patchSettings({ officeName: e.target.value.slice(0, 32) })
          }
          aria-label="Office name"
        />
        <span className={`chip bg-ink text-cream ${mode === 'live' ? 'max-sm:!hidden' : ''}`}>
          {mode === 'build' ? 'BUILD MODE' : mode === 'replay' ? 'REPLAY MODE' : 'LIVE VIEW'}
        </span>
        <span className={`chip ${feed.cls}`} title={feed.title} data-testid="feed-label">
          {narrow ? feed.short : feed.text}
        </span>
        {realCache && sources?.localCache.lastEventAt && (
          <span className="hidden text-[10px] text-stone-600 lg:inline">
            last real/cache event {ago(sources.localCache.lastEventAt)}
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-bold sm:gap-3">
        <span className="hidden lg:inline" title="Active tasks on display">
          ⚙️ {stats.active} active
        </span>
        <span className="hidden lg:inline" title="Completed tasks on display">
          ✅ {stats.completed} done
        </span>
        <span
          className="hidden items-center gap-1 xl:flex"
          title={`Office level ${level} — cosmetic only`}
        >
          ⭐ Lv {level}
          <span className="relative h-1.5 w-14 overflow-hidden rounded bg-stone-300">
            <span
              className="absolute inset-y-0 left-0 bg-amber-500"
              style={{
                width: `${Math.min(100, ((progression.officeXp - xpForLevel(level)) / (xpForLevel(level + 1) - xpForLevel(level))) * 100)}%`,
              }}
            />
          </span>
        </span>
        <span className="hidden lg:inline" title="Cosmetic coins">
          🪙 {progression.coins}
        </span>
        <span title="Simulation clock" className="hidden font-pixel lg:inline">
          🕒 {clock}
        </span>
        <select
          className="field hidden !py-0 md:block"
          value={settings.season}
          onChange={(e) =>
            useStore.getState().patchSettings({ season: e.target.value as typeof settings.season })
          }
          aria-label="Season"
        >
          <option value="auto">
            {seasonIcon[season]} Auto ({season})
          </option>
          <option value="spring">🌸 Spring</option>
          <option value="summer">☀️ Summer</option>
          <option value="autumn">🍂 Autumn</option>
          <option value="winter">❄️ Winter</option>
        </select>
        <button
          className="btn !px-1.5"
          onClick={() => useStore.getState().openModal('help')}
          aria-label="Help"
        >
          <CircleHelp size={14} />
        </button>
        <button
          className="btn !px-1.5"
          onClick={() => useStore.getState().openModal('settings')}
          aria-label="Settings"
          data-testid="open-settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}

export function LeftSidebar() {
  const open = useStore((s) => s.leftOpen);
  const state = useStore(displayState);
  const layout = useStore((s) => s.layout);
  const selection = useStore((s) => s.selection);
  const progression = useStore((s) => s.progression);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const stats = taskStats(Object.values(state.tasks));
  if (!open)
    return (
      <button
        className="btn absolute left-2 top-16 z-20 !px-1"
        onClick={() => useStore.getState().toggleLeft()}
        aria-label="Open sidebar"
      >
        <ChevronRight size={14} />
      </button>
    );
  return (
    <aside
      className="panel scroll-thin absolute bottom-16 left-2 top-16 z-20 w-[min(15rem,calc(100%-1rem))] overflow-y-auto p-3"
      data-testid="left-sidebar"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="panel-title">Office overview</h2>
        <button
          className="btn !px-1"
          onClick={() => useStore.getState().toggleLeft()}
          aria-label="Collapse sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-1 text-center text-[10px]">
        <div className="rounded border border-ink/30 bg-white p-1">
          <div className="text-base font-extrabold">
            {layout.width}×{layout.depth}
          </div>
          tiles
        </div>
        <div className="rounded border border-ink/30 bg-white p-1">
          <div className="text-base font-extrabold">{layout.rooms.length}</div>rooms
        </div>
        <div className="rounded border border-ink/30 bg-white p-1">
          <div className="text-base font-extrabold">{layout.furniture.length}</div>items
        </div>
      </div>
      <h3 className="panel-title mb-1">Team</h3>
      <ul className="mb-3 space-y-1">
        {roster.map((b) => {
          const brain = world.brains.get(b.id);
          const st = brain?.state ?? 'IDLE';
          const sel = selection?.kind === 'bot' && selection.id === b.id;
          const hasDesk = !!layout.deskAssignments[b.id];
          return (
            <li key={b.id}>
              <button
                className={`flex w-full items-center gap-2 rounded-md border-2 px-2 py-1 text-left ${sel ? 'border-amber-500 bg-amber-50' : 'border-transparent hover:bg-paper'}`}
                onClick={() => {
                  const s = useStore.getState();
                  s.select({ kind: 'bot', id: b.id });
                  s.focus({ kind: 'bot', id: b.id });
                }}
                data-testid={`roster-${b.id}`}
              >
                <span
                  className="h-6 w-6 shrink-0 rounded border-2 border-ink"
                  style={{ background: b.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-extrabold">{b.name}</span>
                  <span className="block truncate text-[10px] text-stone-600">
                    {b.role}
                    {!hasDesk && ' · no desk'}
                  </span>
                </span>
                <span className="text-[10px]" title={stateLabel[st]}>
                  {stateIcon[st]} <span className="sr-only">{stateLabel[st]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <h3 className="panel-title mb-1">Tasks</h3>
      <button
        className="mb-3 grid w-full grid-cols-4 gap-1 text-center text-[10px]"
        onClick={() => useStore.getState().openModal('tasks')}
        title="Open task dashboard"
      >
        <span className="rounded bg-amber-100 p-1">
          <b className="block text-sm">{stats.active}</b>active
        </span>
        <span className="rounded bg-stone-100 p-1">
          <b className="block text-sm">{stats.pending}</b>pending
        </span>
        <span className="rounded bg-emerald-100 p-1">
          <b className="block text-sm">{stats.completed}</b>done
        </span>
        <span className="rounded bg-rose-100 p-1">
          <b className="block text-sm">{stats.failed}</b>failed
        </span>
      </button>
      <h3 className="panel-title mb-1">Rooms</h3>
      <ul className="space-y-0.5">
        {layout.rooms.map((r) => (
          <li key={r.id}>
            <button
              className={`w-full rounded px-2 py-0.5 text-left text-xs hover:bg-paper ${selection?.kind === 'room' && selection.id === r.id ? 'bg-amber-50 font-bold' : ''}`}
              onClick={() => {
                const s = useStore.getState();
                s.select({ kind: 'room', id: r.id });
                s.focus({ kind: 'room', id: r.id });
              }}
            >
              📍 {r.name} <span className="text-[10px] text-stone-500">({r.type})</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] text-stone-500">
        Achievements: {Object.keys(progression.achievements).length}. XP and coins are cosmetic and
        never measure AI performance.
      </p>
    </aside>
  );
}

export function BottomToolbar() {
  const mode = useStore((s) => s.mode);
  const audioSettings = useStore((s) => s.settings.audio);
  const selection = useStore((s) => s.selection);
  const follow = useStore((s) => s.follow);
  const s = useStore.getState;
  const toggleSound = async () => {
    if (!audioSettings.enabled) {
      await audio.enable();
      s().patchAudio({ enabled: true, muted: false });
    } else s().patchAudio({ muted: !audioSettings.muted });
  };
  const soundOn = audioSettings.enabled && !audioSettings.muted;
  return (
    <nav
      className="panel scroll-thin absolute bottom-2 left-2 right-2 z-20 flex items-center gap-1 overflow-x-auto px-1.5 py-1.5 sm:left-1/2 sm:right-auto sm:max-w-[calc(100%-1rem)] sm:-translate-x-1/2 sm:px-2"
      data-testid="toolbar"
    >
      <button
        className={`btn ${mode === 'build' ? 'btn-active' : ''}`}
        onClick={() => s().setMode(mode === 'build' ? 'live' : 'build')}
        data-testid="build-toggle"
        title="Build mode (B)"
      >
        <Hammer size={14} /> <span className="max-sm:sr-only">Build</span>
      </button>
      <button
        className="btn"
        onClick={() => {
          if (selection?.kind !== 'bot') s().select({ kind: 'bot', id: roster[0].id });
          s().openModal('customize');
        }}
        title="Character customisation"
      >
        <Shirt size={14} /> <span className="max-sm:sr-only">Style</span>
      </button>
      <button className="btn" onClick={() => s().openModal('tasks')} data-testid="open-tasks">
        <ListChecks size={14} /> <span className="max-sm:sr-only">Tasks</span>
      </button>
      <button className="btn" onClick={() => s().openModal('meeting')} data-testid="open-meeting">
        <Users size={14} /> <span className="max-sm:sr-only">Meeting</span>
      </button>
      <button
        className={`btn ${mode === 'replay' ? 'btn-active' : ''}`}
        onClick={() => s().openModal('replay')}
        data-testid="open-replay"
      >
        <History size={14} /> <span className="max-sm:sr-only">Replay</span>
      </button>
      <button className="btn" onClick={() => s().openModal('achievements')}>
        <Trophy size={14} /> <span className="max-sm:sr-only">Goals</span>
      </button>
      <span className="mx-1 h-6 w-px shrink-0 bg-ink/30 max-sm:hidden" />
      <button
        className="btn !px-1.5 max-sm:!hidden"
        onClick={() => cameraApi.rotate?.(-1)}
        title="Rotate left (Q)"
        aria-label="Rotate camera left"
      >
        <RotateCcw size={14} />
      </button>
      <button
        className="btn !px-1.5 max-sm:!hidden"
        onClick={() => cameraApi.rotate?.(1)}
        title="Rotate right (E)"
        aria-label="Rotate camera right"
      >
        <RotateCw size={14} />
      </button>
      <button
        className="btn !px-1.5 max-sm:!hidden"
        onClick={() => cameraApi.zoom?.(1.25)}
        title="Zoom in (+)"
        aria-label="Zoom in"
      >
        <ZoomIn size={14} />
      </button>
      <button
        className="btn !px-1.5 max-sm:!hidden"
        onClick={() => cameraApi.zoom?.(0.8)}
        title="Zoom out (-)"
        aria-label="Zoom out"
      >
        <ZoomOut size={14} />
      </button>
      <button
        className="btn !px-1.5"
        onClick={() => s().focus({ kind: 'reset' })}
        title="Reset camera (0)"
        aria-label="Reset camera"
      >
        <Camera size={14} />
      </button>
      <button
        className={`btn !px-1.5 ${follow ? 'btn-active' : ''}`}
        disabled={selection?.kind !== 'bot' && !follow}
        onClick={() => {
          if (follow) s().setFollow(undefined);
          else if (selection?.kind === 'bot') {
            s().setFollow(selection.id);
            s().focus({ kind: 'bot', id: selection.id });
          }
        }}
        title="Follow selected Bot (F)"
        aria-label="Follow selected Bot"
      >
        <Crosshair size={14} />
      </button>
      <span className="mx-1 h-6 w-px shrink-0 bg-ink/30 max-sm:hidden" />
      <button
        className={`btn !px-1.5 ${soundOn ? 'btn-active' : ''}`}
        onClick={toggleSound}
        title={audioSettings.enabled ? 'Mute / unmute' : 'Enable sound'}
        aria-label="Toggle sound"
        data-testid="sound-toggle"
      >
        {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
        <span className="hidden text-[10px] sm:inline">
          {audioSettings.enabled ? (audioSettings.muted ? 'Muted' : 'Sound') : 'Enable sound'}
        </span>
      </button>
    </nav>
  );
}
