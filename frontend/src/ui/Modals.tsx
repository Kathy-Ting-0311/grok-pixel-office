import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Pause, Play, X } from 'lucide-react';
import { achievementDefs, cosmeticUnlocks, levelFor } from '../../../shared/progression';
import { findGaps, replaySpeeds, type ReplaySession } from '../../../shared/replay';
import { botById, defaultAppearance, roster } from '../../../shared/roster';
import { SimulationProvider } from '../../../shared/simProvider';
import type { Appearance } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { audio } from '../systems/audio';
import { seekReplay } from '../systems/world';
import { PreviewCharacter } from '../scene/Character';
import { perf } from '../scene/Scene';
import { ago, fmtDateTime, fmtTime, Modal, Section, SourceBadge } from './common';

// ---------------------------------------------------------------- meetings
export function MeetingPanel() {
  const live = useStore((s) => s.live);
  const replay = useStore((s) => s.replay);
  const mode = useStore((s) => s.mode);
  const state = mode === 'replay' && replay ? replay.state : live;
  const meetings = Object.values(state.meetings).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const [chosen, setChosen] = useState<string[]>(roster.map((b) => b.id).slice(0, 4));
  const [title, setTitle] = useState('Demo stand-up');
  const [selected, setSelected] = useState<string | undefined>(meetings[0]?.id);
  const m = meetings.find((x) => x.id === selected) ?? meetings[0];
  const start = async () => {
    try {
      await api.simulateMeeting(chosen, title);
      useStore.getState().toast('Simulated meeting started.', 'good');
      audio.notify('meeting');
    } catch (err) {
      useStore.getState().toast(err instanceof Error ? err.message : String(err), 'warn');
    }
  };
  return (
    <Modal title="Meetings" wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[16rem_1fr]">
        <div>
          <Section title="Start a simulated meeting">
            <p className="mb-1 text-[10px] text-stone-500">
              For demonstration only — the transcript is scripted and labelled SIMULATED.
            </p>
            <input
              className="field mb-1 w-full"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 60))}
              aria-label="Meeting title"
            />
            <ul className="mb-1 space-y-0.5">
              {roster.map((b) => (
                <li key={b.id}>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={chosen.includes(b.id)}
                      onChange={(e) =>
                        setChosen(
                          e.target.checked ? [...chosen, b.id] : chosen.filter((x) => x !== b.id),
                        )
                      }
                    />
                    {b.name}
                  </label>
                </li>
              ))}
            </ul>
            <button
              className="btn w-full"
              disabled={chosen.length < 2 || mode === 'replay'}
              onClick={start}
              data-testid="start-meeting"
            >
              Start meeting
            </button>
          </Section>
          <Section title="History">
            <ul className="space-y-1">
              {meetings.length === 0 && (
                <li className="text-xs text-stone-500">No meetings yet.</li>
              )}
              {meetings.slice(0, 20).map((x) => (
                <li key={x.id}>
                  <button
                    className={`w-full rounded border-2 px-2 py-1 text-left text-xs ${m?.id === x.id ? 'border-amber-500 bg-amber-50' : 'border-ink/15 bg-white'}`}
                    onClick={() => setSelected(x.id)}
                  >
                    <div className="flex justify-between gap-1">
                      <b className="truncate">{x.title}</b>
                      <span
                        className={`chip ${x.state === 'in_progress' ? 'bg-amber-200' : 'bg-stone-200'}`}
                      >
                        {x.state === 'in_progress' ? 'live' : x.state}
                      </span>
                    </div>
                    <div className="text-[10px] text-stone-500">{fmtDateTime(x.startedAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        </div>
        <div>
          {m ? (
            <div data-testid="meeting-detail">
              <div className="mb-1 flex items-center gap-2">
                <h3 className="text-sm font-extrabold">{m.title}</h3>
                <SourceBadge source={m.source} />
                <span className="chip bg-stone-200">{m.state.replace('_', ' ')}</span>
              </div>
              <p className="mb-2 text-xs text-stone-600">
                {fmtTime(m.startedAt)} – {m.endedAt ? fmtTime(m.endedAt) : 'now'} ·{' '}
                {m.participants.map((p) => botById(p)?.name ?? p).join(', ')}
              </p>
              <ul className="max-h-[50vh] space-y-1 overflow-auto">
                {m.messages.length === 0 && (
                  <li className="text-xs text-stone-500">No messages recorded.</li>
                )}
                {m.messages.map((msg, i) => (
                  <li key={i} className="rounded border border-ink/10 bg-white p-1.5 text-xs">
                    <span className="mr-1 font-bold">{botById(msg.botId)?.name}</span>
                    <span className="text-[10px] text-stone-500">{fmtTime(msg.timestamp)}</span>
                    <div>{msg.text}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-stone-500">
              Meetings appear here with participants, timestamps, messages and their source.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- replay
export function ReplayPicker() {
  const [sessions, setSessions] = useState<ReplaySession[] | null>(null);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    api.sessions().then(setSessions, (e) => setErr(String(e)));
  }, []);
  const open = async (s: ReplaySession) => {
    const events = await api.range(Date.parse(s.start), Date.parse(s.end));
    if (!events.length) return useStore.getState().toast('That session has no events.', 'warn');
    useStore.getState().startReplay({
      label: `Session ${fmtDateTime(s.start)}`,
      events,
      start: Date.parse(events[0].timestamp),
      end: Date.parse(events.at(-1)!.timestamp),
      demo: false,
    });
  };
  const demo = () => {
    const start = Date.now() - 20 * 60000;
    const events = SimulationProvider.demoHistory(roster, start, 20 * 60000, Date.now() & 0xff);
    useStore.getState().startReplay({
      label: 'Simulated replay demo (20 min)',
      events,
      start,
      end: Date.parse(events.at(-1)!.timestamp),
      demo: true,
    });
  };
  return (
    <Modal title="Historical replay">
      <p className="mb-2 text-xs text-stone-600">
        Replays recorded events in order. Gaps with no data are shown as gaps — nothing is invented.
        Live monitoring keeps recording in the background.
      </p>
      <button className="btn mb-3" onClick={demo} data-testid="replay-demo">
        ▶ Fully simulated replay demo
      </button>
      <Section title="Recorded sessions">
        {err && <p className="text-xs text-rose-700">{err}</p>}
        {!sessions && !err && <p className="text-xs">Loading…</p>}
        {sessions?.length === 0 && (
          <p className="text-xs text-stone-500">No recorded sessions yet.</p>
        )}
        <ul className="space-y-1">
          {sessions?.slice(0, 30).map((s) => (
            <li key={s.id}>
              <button
                className="w-full rounded border-2 border-ink/15 bg-white px-2 py-1 text-left text-xs hover:border-ink/50"
                onClick={() => open(s)}
              >
                <div className="flex items-center justify-between">
                  <b>{fmtDateTime(s.start)}</b>
                  <span className="flex gap-1">
                    {s.sources.map((x) => (
                      <SourceBadge key={x} source={x} />
                    ))}
                  </span>
                </div>
                <div className="text-[10px] text-stone-500">
                  until {fmtTime(s.end)} · {s.count} events
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </Modal>
  );
}

export function ReplayBar() {
  const r = useStore((s) => s.replay);
  const follow = useStore((s) => s.follow);
  const [showEvents, setShowEvents] = useState(false);
  const gaps = useMemo(() => (r ? findGaps(r.events) : []), [r?.events]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  const span = Math.max(1, r.end - r.start);
  const pct = ((Math.max(r.start, r.time) - r.start) / span) * 100;
  const s = useStore.getState;
  const recent = r.events
    .filter((e) => Date.parse(e.timestamp) <= r.time)
    .slice(-40)
    .reverse();
  return (
    <div
      className="panel absolute bottom-16 left-1/2 z-30 w-[min(720px,calc(100%-1rem))] -translate-x-1/2 p-2"
      data-testid="replay-bar"
    >
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="chip bg-blue-600 text-white">REPLAYED</span>
        <b className="truncate">{r.label}</b>
        {r.demo && <span className="chip bg-violet-600 text-white">originally SIMULATED</span>}
        <span className="ml-auto font-pixel">
          {new Date(Math.max(r.start, r.time)).toLocaleTimeString()}
        </span>
        <button className="btn !px-1.5" onClick={() => s().stopReplay()} aria-label="Exit replay">
          <X size={12} /> Exit
        </button>
      </div>
      <div
        className="relative mb-1 h-5 cursor-pointer rounded border-2 border-ink bg-white"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seekReplay(r.start + ((e.clientX - rect.left) / rect.width) * span);
        }}
        title="Click to jump"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Replay position"
      >
        {gaps.map((g, i) => (
          <span
            key={i}
            className="absolute inset-y-0 bg-[repeating-linear-gradient(45deg,#d6d3d1_0_3px,transparent_3px_6px)]"
            style={{
              left: `${((g.start - r.start) / span) * 100}%`,
              width: `${((g.end - g.start) / span) * 100}%`,
            }}
            title="No data recorded"
          />
        ))}
        {r.events
          .filter((e) => e.type === 'task_completed' || e.type === 'meeting_started')
          .map((e) => (
            <span
              key={e.id}
              className={`absolute top-0 h-1.5 w-px ${e.type === 'meeting_started' ? 'bg-amber-500' : 'bg-emerald-600'}`}
              style={{ left: `${((Date.parse(e.timestamp) - r.start) / span) * 100}%` }}
            />
          ))}
        <span className="absolute inset-y-0 left-0 bg-blue-500/25" style={{ width: `${pct}%` }} />
        <span
          className="absolute inset-y-[-3px] w-1 rounded bg-blue-700"
          style={{ left: `calc(${pct}% - 2px)` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          className="btn"
          onClick={() => {
            if (r.time >= r.end) seekReplay(r.start);
            s().setReplay({ playing: !r.playing });
          }}
          data-testid="replay-play"
        >
          {r.playing ? <Pause size={12} /> : <Play size={12} />} {r.playing ? 'Pause' : 'Play'}
        </button>
        {replaySpeeds.map((sp) => (
          <button
            key={sp}
            className={`btn !px-1.5 ${r.speed === sp ? 'btn-active' : ''}`}
            onClick={() => s().setReplay({ speed: sp })}
          >
            {sp}×
          </button>
        ))}
        <label className="ml-1 flex items-center gap-1">
          Jump to
          <input
            type="time"
            step={1}
            className="field !py-0"
            onChange={(e) => {
              const [h, m, sec] = e.target.value.split(':').map(Number);
              const d = new Date(r.start);
              d.setHours(h, m, sec || 0, 0);
              seekReplay(d.getTime());
            }}
            aria-label="Jump to time"
          />
        </label>
        <select
          className="field !py-0"
          value={follow ?? ''}
          onChange={(e) => s().setFollow(e.target.value || undefined)}
          aria-label="Follow Bot"
        >
          <option value="">Follow…</option>
          {roster.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button className="btn ml-auto" onClick={() => setShowEvents(!showEvents)}>
          {showEvents ? 'Hide' : 'Inspect'} events
        </button>
      </div>
      {showEvents && (
        <ul className="scroll-thin mt-1 max-h-40 overflow-auto rounded border border-ink/20 bg-white text-[10px]">
          {recent.map((e) => (
            <li key={e.id} className="flex gap-2 border-b border-ink/5 px-2 py-0.5">
              <span className="font-pixel text-stone-500">{fmtTime(e.timestamp)}</span>
              <b>{botById(e.botId)?.name}</b>
              <span>{e.type}</span>
              <span className="truncate text-stone-600">
                {String(e.payload.title ?? e.payload.text ?? '')}
              </span>
              <span className="ml-auto">
                <SourceBadge source="replayed" original={e.source} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings & sources
export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const sources = useStore((s) => s.sources);
  const connection = useStore((s) => s.connection);
  const [dir, setDir] = useState(sources?.localCache.dir ?? '');
  const [authorize, setAuthorize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statsTick, setStatsTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStatsTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void statsTick;
  const s = useStore.getState;
  const patch = s().patchSettings;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      s().toast(err instanceof Error ? err.message : String(err), 'warn');
    } finally {
      setBusy(false);
    }
  };
  const lc = sources?.localCache;
  return (
    <Modal title="Settings" wide>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Section title="Data sources">
            <div className="mb-2 rounded border-2 border-ink/20 bg-white p-2 text-xs">
              <div className="mb-1 flex items-center justify-between">
                <b>B · Simulation</b>
                <span className="chip bg-violet-600 text-white">SIMULATED</span>
              </div>
              {connection === 'backend' ? (
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={!!sources?.simulation.enabled}
                    disabled={busy}
                    onChange={(e) => run(() => api.setSimulation(e.target.checked))}
                    data-testid="sim-toggle"
                  />
                  Generate fictional demo activity
                </label>
              ) : (
                <p>Backend offline — a browser-side simulation is running as a fallback.</p>
              )}
            </div>
            <div className="mb-2 rounded border-2 border-ink/20 bg-white p-2 text-xs">
              <div className="mb-1 flex items-center justify-between">
                <b>A · Local cache (read-only)</b>
                <span
                  className={`chip ${lc?.state === 'watching' ? 'bg-emerald-600 text-white' : lc?.state === 'error' ? 'bg-rose-600 text-white' : 'bg-stone-300'}`}
                >
                  {lc?.state ?? 'unavailable'}
                </span>
              </div>
              <p className="mb-1 text-[11px] text-stone-600">
                Watches one folder of <code>*.jsonl</code> event files you control (format in
                README). Grok Bot has no documented readable activity cache, so nothing is read
                automatically. Credential stores such as <code>~/.grokbot</code> and{' '}
                <code>~/.ssh</code> are refused.
              </p>
              <input
                className="field mb-1 w-full font-pixel"
                placeholder="/absolute/path/to/events-folder"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                aria-label="Local cache folder"
              />
              <label className="mb-1 flex items-start gap-1 text-[11px]">
                <input
                  type="checkbox"
                  checked={authorize}
                  onChange={(e) => setAuthorize(e.target.checked)}
                />
                I authorise read-only access to this folder only (no subfolders).
              </label>
              <div className="flex gap-1">
                <button
                  className="btn"
                  disabled={busy || !dir || !authorize || connection !== 'backend'}
                  onClick={() => run(() => api.setLocalCache(dir, true))}
                >
                  Connect
                </button>
                <button
                  className="btn"
                  disabled={busy || lc?.state === 'disabled' || connection !== 'backend'}
                  onClick={() => run(() => api.setLocalCache(null, false))}
                >
                  Disconnect
                </button>
              </div>
              {lc && lc.state !== 'disabled' && (
                <dl className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-stone-600">
                  <dt>Folder</dt>
                  <dd className="truncate">{lc.dir}</dd>
                  <dt>Files</dt>
                  <dd>{lc.files}</dd>
                  <dt>Accepted / dupes</dt>
                  <dd>
                    {lc.accepted} / {lc.duplicates}
                  </dd>
                  <dt>Rejected / unknown Bot</dt>
                  <dd>
                    {lc.rejected} / {lc.unmatchedBots}
                  </dd>
                  <dt>Last event</dt>
                  <dd>{ago(lc.lastEventAt)}</dd>
                  {lc.lastError && (
                    <>
                      <dt>Error</dt>
                      <dd className="text-rose-700">{lc.lastError}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
            <div className="rounded border-2 border-ink/20 bg-white p-2 text-xs">
              <b>C · Official API adapter</b>{' '}
              <span className="chip bg-stone-300">not available</span>
              <p className="text-[11px] text-stone-600">
                {sources?.officialApi.reason ??
                  'No official Grok Bot event API is documented. Interface only.'}
              </p>
            </div>
            <p className="mt-1 text-[10px] text-stone-500">
              Stored events: {sources?.storedEvents ?? '—'} · connection: {connection}
            </p>
          </Section>
        </div>
        <div>
          <Section title="Graphics">
            <div className="mb-1 flex gap-1">
              {(['low', 'medium', 'high'] as const).map((q) => (
                <button
                  key={q}
                  className={`btn capitalize ${settings.quality === q ? 'btn-active' : ''}`}
                  onClick={() => patch({ quality: q })}
                >
                  {q}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={settings.pixelArt}
                onChange={(e) => patch({ pixelArt: e.target.checked })}
              />{' '}
              Pixel-art rendering (low-res, nearest-neighbour)
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={settings.walls === 'full'}
                onChange={(e) => patch({ walls: e.target.checked ? 'full' : 'cutaway' })}
              />{' '}
              Full-height interior walls
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={settings.enableRotate}
                onChange={(e) => patch({ enableRotate: e.target.checked })}
              />{' '}
              Allow camera rotation (right/middle drag or two-finger twist)
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={settings.showStats}
                onChange={(e) => patch({ showStats: e.target.checked })}
                data-testid="stats-toggle"
              />{' '}
              Show performance overlay
            </label>
            <label className="mt-1 flex items-center gap-2 text-xs">
              Max speech bubbles
              <input
                type="range"
                min={1}
                max={6}
                value={settings.maxBubbles}
                onChange={(e) => patch({ maxBubbles: Number(e.target.value) })}
              />
              {settings.maxBubbles}
            </label>
            <p className="mt-1 text-[10px] text-stone-500">
              Now: {perf.fps} FPS · {perf.calls} draw calls · {perf.triangles.toLocaleString()}{' '}
              triangles · {perf.geometries} geometries · {perf.textures} textures
            </p>
          </Section>
          <Section title="Environment">
            <label className="mb-1 flex items-center gap-2 text-xs">
              Day / night
              <select
                className="field"
                value={settings.dayNight}
                onChange={(e) => patch({ dayNight: e.target.value as typeof settings.dayNight })}
              >
                <option value="off">Off (afternoon)</option>
                <option value="clock">Follow my clock</option>
                <option value="fast">Fast cycle (12 min)</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              Effects
              <select
                className="field min-w-0 max-w-full flex-1 sm:flex-none"
                value={settings.weather}
                onChange={(e) => patch({ weather: e.target.value as typeof settings.weather })}
              >
                <option value="auto">Seasonal (petals / clouds / leaves / snow)</option>
                <option value="clear">Clear</option>
                <option value="clouds">Clouds</option>
                <option value="rain">Rain</option>
                <option value="snow">Snow</option>
              </select>
            </label>
            <p className="text-[10px] text-stone-500">
              Decorative only — no live weather source is used.
            </p>
          </Section>
          <Section title="Finished tasks">
            <label className="block text-xs">
              Pop-up on completion
              <select
                className="field mt-0.5 block w-full min-w-0"
                value={settings.popupOnCompletion}
                onChange={(e) =>
                  patch({ popupOnCompletion: e.target.value as typeof settings.popupOnCompletion })
                }
                data-testid="popup-setting"
              >
                <option value="always">Always</option>
                <option value="focused">Only when I am in the app</option>
                <option value="off">Off (show a toast with an Open button)</option>
              </select>
            </label>
            <p className="text-[10px] text-stone-500">
              A soft sound also plays when sound is enabled. All results stay in the Results board.
            </p>
          </Section>
          <Section title="Audio">
            {!settings.audio.enabled && (
              <button
                className="btn mb-1"
                onClick={async () => {
                  await audio.enable();
                  s().patchAudio({ enabled: true, muted: false });
                }}
              >
                Enable sound
              </button>
            )}
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={settings.audio.muted}
                onChange={(e) => s().patchAudio({ muted: e.target.checked })}
              />{' '}
              Mute all
            </label>
            {(['master', 'ambient', 'character', 'notification'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs capitalize">
                <span className="w-20">{k}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.audio[k]}
                  onChange={(e) => s().patchAudio({ [k]: Number(e.target.value) })}
                  aria-label={`${k} volume`}
                />
                {Math.round(settings.audio[k] * 100)}%
              </label>
            ))}
            <p className="text-[10px] text-stone-500">
              All sounds are synthesised in the browser. Audio starts only after you enable it.
            </p>
          </Section>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- achievements
export function AchievementsModal() {
  const p = useStore((s) => s.progression);
  const level = levelFor(p.officeXp);
  return (
    <Modal title="Office goals & achievements">
      <p className="mb-2 text-xs text-stone-600">
        Office level {level} · {p.officeXp} XP · {p.coins} coins. A cosmetic game layer: it counts
        simulated activity and source-verified REAL completions, never UNKNOWN or REPLAYED events,
        and is not a measure of AI performance.
      </p>
      <ul className="mb-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {achievementDefs.map((a) => {
          const got = p.achievements[a.id];
          return (
            <li
              key={a.id}
              className={`rounded border-2 p-2 text-xs ${got ? 'border-amber-500 bg-amber-50' : 'border-ink/15 bg-white opacity-70'}`}
            >
              <div className="font-bold">
                {got ? '🏆' : '🔒'} {a.name}
              </div>
              <div className="text-[10px] text-stone-600">{a.description}</div>
              {got && <div className="text-[10px] text-stone-500">Unlocked {fmtDateTime(got)}</div>}
            </li>
          );
        })}
      </ul>
      <Section title="Counters">
        <p className="text-xs">
          Tasks observed {p.counters.tasksObserved} · meetings {p.counters.meetings} · chats{' '}
          {p.counters.chats} · style changes {p.counters.customizations}
        </p>
      </Section>
      <Section title="Cosmetic unlocks">
        <p className="text-xs">
          {Object.entries(cosmeticUnlocks)
            .map(([k, lv]) => `${k} (Lv ${lv}) ${level >= lv ? '✓' : '🔒'}`)
            .join(' · ')}
        </p>
      </Section>
    </Modal>
  );
}

// ---------------------------------------------------------------- customisation
const swatches = {
  hair: ['#1F1A17', '#3B2A20', '#5B3A29', '#A0522D', '#E8C170', '#C2410C', '#7C3AED', '#E5E7EB'],
  skin: ['#F6D2B5', '#F1C9A5', '#E8B894', '#D7A27C', '#C98E66', '#9A6546', '#6F4630'],
  cloth: [
    '#60A5FA',
    '#FB923C',
    '#FBBF24',
    '#F472B6',
    '#2DD4BF',
    '#A3C96A',
    '#EF4444',
    '#8B5CF6',
    '#F3EEE4',
    '#374151',
  ],
  bottom: ['#3D4A66', '#2B2118', '#6B7280', '#1E3A8A', '#7C2D12', '#E5E7EB'],
};
const options: { key: keyof Appearance; label: string; values: string[] }[] = [
  { key: 'hairStyle', label: 'Hair', values: ['short', 'bob', 'spiky', 'long', 'bun', 'bald'] },
  { key: 'top', label: 'Outfit', values: ['shirt', 'hoodie', 'suit', 'dress'] },
  { key: 'glasses', label: 'Glasses', values: ['none', 'round', 'square', 'shades'] },
  { key: 'hat', label: 'Hat', values: ['none', 'cap', 'beanie', 'crown', 'headphones'] },
  { key: 'accessory', label: 'Accessory', values: ['none', 'tie', 'scarf', 'badge', 'backpack'] },
  {
    key: 'expression',
    label: 'Expression',
    values: ['happy', 'neutral', 'focused', 'sleepy', 'wink'],
  },
  { key: 'idle', label: 'Idle animation', values: ['sway', 'stretch', 'look', 'bounce'] },
];

export function Customizer() {
  const selection = useStore((s) => s.selection);
  const appearances = useStore((s) => s.appearances);
  const level = useStore((s) => levelFor(s.progression.officeXp));
  const botId = selection?.kind === 'bot' ? selection.id : roster[0].id;
  const bot = botById(botId)!;
  const [draft, setDraft] = useState<Appearance>(appearances[botId]);
  useEffect(() => setDraft(appearances[botId]), [botId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) =>
    setDraft({ ...draft, [k]: v });
  const locked = (v: string) => (cosmeticUnlocks[v] ?? 0) > level;
  const Swatch = ({
    k,
    list,
  }: {
    k: 'hairColor' | 'skin' | 'topColor' | 'bottomColor' | 'shoes';
    list: string[];
  }) => (
    <div className="flex flex-wrap gap-1">
      {list.map((c) => (
        <button
          key={c}
          className={`h-5 w-5 rounded border-2 ${draft[k] === c ? 'border-amber-500 ring-2 ring-amber-300' : 'border-ink/50'}`}
          style={{ background: c }}
          onClick={() => set(k, c)}
          aria-label={`${k} ${c}`}
        />
      ))}
    </div>
  );
  return (
    <Modal title={`Style · ${bot.name}`} wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[14rem_1fr]">
        <div>
          <select
            className="field mb-2 w-full"
            value={botId}
            onChange={(e) => useStore.getState().select({ kind: 'bot', id: e.target.value })}
            aria-label="Bot"
          >
            {roster.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <div
            className="h-56 rounded-md border-2 border-ink bg-[#F3E3C3]"
            style={{ imageRendering: 'pixelated' }}
          >
            <Canvas orthographic camera={{ position: [3, 2.2, 3], zoom: 110 }} dpr={0.6} flat>
              <ambientLight intensity={1.1} />
              <directionalLight position={[3, 5, 2]} intensity={1.4} />
              <Suspense fallback={null}>
                <PreviewCharacter bot={bot} appearance={draft} />
              </Suspense>
            </Canvas>
          </div>
          <p className="mt-1 text-[10px] text-stone-500">
            Appearance is cosmetic. It never changes the Bot’s identity, ID, role or task data.
          </p>
        </div>
        <div className="space-y-2 text-xs">
          {options.map((o) => (
            <div key={o.key}>
              <div className="mb-0.5 font-bold">{o.label}</div>
              <div className="flex flex-wrap gap-1">
                {o.values.map((v) => (
                  <button
                    key={v}
                    disabled={locked(v)}
                    className={`btn !py-0.5 capitalize ${draft[o.key] === v ? 'btn-active' : ''}`}
                    onClick={() => set(o.key, v as never)}
                    title={locked(v) ? `Unlocks at office level ${cosmeticUnlocks[v]}` : undefined}
                  >
                    {v}
                    {locked(v) && ' 🔒'}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="font-bold">Hair colour</div>
              <Swatch k="hairColor" list={swatches.hair} />
            </div>
            <div>
              <div className="font-bold">Skin tone</div>
              <Swatch k="skin" list={swatches.skin} />
            </div>
            <div>
              <div className="font-bold">Outfit colour</div>
              <Swatch k="topColor" list={swatches.cloth} />
            </div>
            <div>
              <div className="font-bold">Trousers</div>
              <Swatch k="bottomColor" list={swatches.bottom} />
            </div>
            <div>
              <div className="font-bold">Shoes</div>
              <Swatch k="shoes" list={['#2B2118', '#F3EEE4', '#B91C1C', '#1D4ED8', '#6B7280']} />
            </div>
          </div>
          <div className="flex gap-1 pt-1">
            <button
              className="btn btn-active"
              onClick={() => {
                useStore.getState().setAppearance(botId, draft);
                useStore.getState().toast(`${bot.name}’s look saved.`, 'good');
              }}
              data-testid="save-style"
            >
              Save look
            </button>
            <button className="btn" onClick={() => setDraft(defaultAppearance(bot))}>
              Reset to default
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function HelpModal() {
  return (
    <Modal title="How this office works">
      <div className="space-y-2 text-xs">
        <p>
          <b>What is real?</b> Every task, message and meeting carries a source label:{' '}
          <SourceBadge source="real" /> only from a folder you authorised that explicitly marks it
          real, <SourceBadge source="simulated" /> generated demo activity,{' '}
          <SourceBadge source="replayed" /> historical playback, <SourceBadge source="unknown" />{' '}
          unlabelled data.
        </p>
        <p>
          Bots’ walking, coffee breaks, chats and idle animations are <b>visual simulation</b>. Only
          task and meeting events move a Bot to its desk or the meeting room, and task completion is
          shown only when a completion event arrives.
        </p>
        <p>
          <b>Touch</b>: drag to pan · pinch to zoom · twist with two fingers to rotate · tap a Bot
          to select it · in Build mode, tap a catalog item and then tap the floor to place it.
        </p>
        <p>
          <b>Mouse &amp; keyboard</b>: left-drag pan · wheel zoom · right/middle-drag or Q/E rotate
          · double-click a Bot to follow · WASD pan · 0 reset · B build mode · R rotate furniture ·
          Esc cancel · Ctrl+Z / Ctrl+Shift+Z undo / redo.
        </p>
      </div>
    </Modal>
  );
}
