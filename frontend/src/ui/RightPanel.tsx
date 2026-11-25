import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Coffee,
  Crosshair,
  Eraser,
  MoreHorizontal,
  Move,
  RotateCw,
  Shirt,
  Trash2,
  Video,
} from 'lucide-react';
import { getCatalog } from '../../../shared/catalog';
import { activeTaskFor, durationMs } from '../../../shared/events';
import {
  itemPoints,
  roomAt,
  validatePlacement,
  checkEssentialRoutes,
} from '../../../shared/layout';
import { levelFor } from '../../../shared/progression';
import { botById, roster } from '../../../shared/roster';
import type { Rotation, RoomType } from '../../../shared/types';
import { displayState, useStore } from '../store';
import { world } from '../systems/world';
import { stateIcon, stateLabel } from '../scene/Overlay';
import { floorLabel, floorTypes } from '../scene/textures';
import { fmtDuration, fmtTime, Progress, Section, SourceBadge, StatusChip } from './common';
import { TaskForm, TaskThreads } from './TaskComposer';
import { BotChat } from './BotChat';
import { LiveGrokBotTab } from '../live/LiveGrokBotTab';
import { useLiveFlag } from '../live/liveFlag';

export const roomTypes: RoomType[] = [
  'work',
  'executive',
  'meeting',
  'common',
  'recreation',
  'server',
  'reception',
  'kitchen',
  'lounge',
  'custom',
];

function useTick(ms = 400) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function BotPanel({ id }: { id: string }) {
  useTick();
  const bot = botById(id)!;
  const state = useStore(displayState);
  const layout = useStore((s) => s.layout);
  const conversations = useStore((s) => s.conversations);
  const progression = useStore((s) => s.progression);
  const follow = useStore((s) => s.follow);
  const mode = useStore((s) => s.mode);
  // Chat is the default view; Profile / Tasks / Activity live in the "..." menu.
  const [tab, setTab] = useState<'profile' | 'talk' | 'live' | 'tasks' | 'chat'>('talk');
  const liveOn = useLiveFlag((s) => s.enabled);
  // Chat source: the existing xAI chat, or the real Grok Bot conversation (only while Live Control is on).
  const [chatSource, setChatSource] = useState<'xai' | 'live'>('xai');
  const [menu, setMenu] = useState(false);
  const [clearAsk, setClearAsk] = useState(false);
  const [chatCount, setChatCount] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) =>
      !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);
  useEffect(() => {
    const open = (e: Event) => (e as CustomEvent).detail === id && setTab('chat');
    window.addEventListener('open-conversation', open);
    return () => window.removeEventListener('open-conversation', open);
  }, [id]);
  const brain = world.brains.get(id);
  const task = activeTaskFor(state, id);
  const tasks = Object.values(state.tasks)
    .filter((t) => t.botId === id)
    .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  const lines = (mode === 'replay' ? [] : conversations)
    // Placed-task messages are shown inside their task thread below.
    .filter((c) => c.botId === id && !c.taskId?.startsWith('placed-'))
    .slice(-60)
    .reverse();
  const desks = layout.furniture.filter((f) => itemPoints(f).some((p) => p.kind === 'desk'));
  const assigned = layout.deskAssignments[id];
  const s = useStore.getState;

  const assignDesk = (uid: string) => {
    const L = s().layout;
    const next = { ...L.deskAssignments };
    const prevOwner = Object.entries(next).find(([, u]) => u === uid)?.[0];
    if (prevOwner && prevOwner !== id) {
      if (next[id]) next[prevOwner] = next[id];
      else delete next[prevOwner];
    }
    if (uid) next[id] = uid;
    else delete next[id];
    const check = checkEssentialRoutes({ ...L, deskAssignments: next });
    if (!check.ok) return s().toast(check.reason, 'warn');
    s().commitLayout(
      { ...L, deskAssignments: next },
      prevOwner && prevOwner !== id
        ? `Swapped desks with ${botById(prevOwner)?.name}.`
        : 'Desk assigned.',
    );
  };
  const takeBreak = () => {
    if (!brain) return;
    const p = world.points.find(
      (pt) =>
        pt.tags?.includes('break') &&
        !world.reservations.has(pt.id) &&
        world.isReachable({ x: pt.tx, z: pt.tz }),
    );
    if (!p) return s().toast('No free break spot right now.', 'warn');
    world.goTo(brain, {
      tile: { x: p.tx, z: p.tz },
      facing: p.worldFacing,
      pose: p.pose,
      pointId: p.id,
      purpose: 'break',
    });
    brain.timer = 12;
  };

  const iconBtn = 'rounded p-1 text-ink hover:bg-paper disabled:opacity-40';
  const views = [
    ['talk', 'Chat'],
    // Grok Bot Live Control: listed only while the server-side flag is on.
    ...(liveOn ? ([['live', 'Live Grok Bot']] as const) : []),
    ['profile', 'Profile'],
    ['tasks', 'Tasks'],
    ['chat', 'Activity'],
  ] as const;
  const viewName = views.find(([v]) => v === tab)?.[1] ?? 'Chat';
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-panel">
      <div className="flex h-9 shrink-0 items-center gap-1.5 pl-3 pr-1.5">
        {tab !== 'talk' && (
          <button
            className={iconBtn}
            onClick={() => setTab('talk')}
            aria-label="Back to chat"
            data-testid="back-to-chat"
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full border border-ink"
          style={{ background: bot.color }}
        />
        <div className="min-w-0 flex-1 leading-none">
          <div className="truncate text-xs font-extrabold">
            {bot.name}
            {tab !== 'talk' && (
              <span className="ml-1 font-normal text-stone-500">· {viewName}</span>
            )}
          </div>
          <div className="truncate text-[10px] text-stone-500">{bot.role}</div>
        </div>
        <button
          className={iconBtn}
          onClick={() => s().focus({ kind: 'bot', id })}
          title="Focus"
          aria-label="Focus camera on this Bot"
        >
          <Crosshair size={14} />
        </button>
        <button
          className={`${iconBtn} ${follow === id ? 'bg-amber-200' : ''}`}
          onClick={() => s().setFollow(follow === id ? undefined : id)}
          title="Follow"
          aria-label="Follow this Bot"
          aria-pressed={follow === id}
        >
          <Video size={14} />
        </button>
        <button
          className={iconBtn}
          onClick={() => {
            setTab('talk');
            setClearAsk(true);
          }}
          disabled={!chatCount || mode === 'replay'}
          title="Clear chat"
          aria-label="Clear chat"
          data-testid="chat-clear"
        >
          <Eraser size={14} />
        </button>
        <div className="relative" ref={menuRef}>
          <button
            className={`${iconBtn} ${menu ? 'bg-paper' : ''}`}
            onClick={() => setMenu((v) => !v)}
            aria-label="More"
            aria-expanded={menu}
            data-testid="bot-menu"
          >
            <MoreHorizontal size={14} />
          </button>
          {menu && (
            <div className="panel absolute right-0 top-8 z-30 w-36 p-1 text-xs" role="menu">
              {views.map(([v, label]) => (
                <button
                  key={v}
                  role="menuitemradio"
                  aria-checked={tab === v}
                  className={`block w-full rounded px-2 py-1 text-left hover:bg-paper ${tab === v ? 'font-extrabold' : ''}`}
                  onClick={() => {
                    setTab(v);
                    setMenu(false);
                  }}
                  data-testid={`tab-${v}`}
                >
                  {label}
                </button>
              ))}
              <hr className="my-1 border-ink/15" />
              <button
                role="menuitem"
                className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-paper"
                onClick={() => {
                  setMenu(false);
                  s().openModal('customize');
                }}
              >
                <Shirt size={12} /> Style
              </button>
              <button
                role="menuitem"
                className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-paper disabled:opacity-40"
                onClick={() => {
                  setMenu(false);
                  takeBreak();
                }}
                disabled={!!task || mode !== 'live'}
                title="Visual only — does not change any task"
              >
                <Coffee size={12} /> Break
              </button>
            </div>
          )}
        </div>
        <button
          className={iconBtn}
          onClick={() => s().toggleRight()}
          aria-label="Collapse details panel"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      {tab === 'talk' && liveOn && (
        <div className="flex gap-1 px-3 pb-1" role="tablist" aria-label="Conversation source" data-testid="chat-source">
          {(
            [
              ['xai', 'xAI Chat'],
              ['live', 'Grok Bot Live'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              role="tab"
              aria-selected={chatSource === v}
              className={`chip ${chatSource === v ? 'bg-ink text-cream' : 'bg-stone-200 text-stone-700'}`}
              onClick={() => setChatSource(v)}
              data-testid={`chat-source-${v}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'talk' && (!liveOn || chatSource === 'xai') && (
        <BotChat bot={bot} clearAsk={clearAsk} setClearAsk={setClearAsk} onCount={setChatCount} />
      )}
      {tab === 'talk' && liveOn && chatSource === 'live' && <LiveGrokBotTab bot={bot} />}
      {tab === 'live' && liveOn && <LiveGrokBotTab bot={bot} />}
      {tab !== 'talk' && tab !== 'live' && (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
          {tab === 'profile' && (
            <>
              <Section title="Now">
                <div className="rounded border border-ink/20 bg-white p-2 text-xs">
                  <div className="mb-1">
                    Visual: {stateIcon[brain?.state ?? 'IDLE']}{' '}
                    <b>{stateLabel[brain?.state ?? 'IDLE']}</b>
                    <span className="ml-1 text-[10px] text-stone-500">
                      (animation — not task status)
                    </span>
                  </div>
                  {task ? (
                    <>
                      <div className="mb-1 flex items-center gap-1">
                        <StatusChip status={task.status} /> <SourceBadge source={task.source} />
                      </div>
                      <div className="font-bold">{task.title}</div>
                      <div className="my-1">
                        <Progress value={task.progress} />
                      </div>
                      <div className="text-[10px] text-stone-500">
                        Started {fmtTime(task.startedAt)} · {fmtDuration(durationMs(task))} ·
                        updated {fmtTime(task.lastUpdated)}
                      </div>
                    </>
                  ) : (
                    <div className="text-stone-500">No active task.</div>
                  )}
                </div>
              </Section>
              <Section title="Profile">
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                  <dt className="text-stone-500">ID</dt>
                  <dd className="truncate font-pixel text-[10px]">{bot.id}</dd>
                  <dt className="text-stone-500">Team</dt>
                  <dd>{bot.team}</dd>
                  <dt className="text-stone-500">Specialty</dt>
                  <dd>{bot.specialty}</dd>
                  <dt className="text-stone-500">About</dt>
                  <dd>{bot.personalityText}</dd>
                  <dt className="text-stone-500">Vibe</dt>
                  <dd>
                    {bot.trait}{' '}
                    <span className="text-[10px] text-stone-500">(cosmetic idle style)</span>
                  </dd>
                  <dt className="text-stone-500">Office XP</dt>
                  <dd>
                    {progression.botXp[id] ?? 0} · Lv {levelFor(progression.botXp[id] ?? 0)}{' '}
                    <span className="text-[10px] text-stone-500">(cosmetic)</span>
                  </dd>
                </dl>
              </Section>
              <Section title="Workstation">
                <select
                  className="field w-full"
                  value={assigned ?? ''}
                  onChange={(e) => assignDesk(e.target.value)}
                  aria-label="Assigned desk"
                >
                  <option value="">— no desk —</option>
                  {desks.map((d) => {
                    const owner = Object.entries(layout.deskAssignments).find(
                      ([, u]) => u === d.uid,
                    )?.[0];
                    const room = roomAt(layout, d.x, d.z);
                    return (
                      <option key={d.uid} value={d.uid}>
                        {getCatalog(d.catalogId).name} · {room?.name ?? 'Unassigned'} ({d.x},{d.z})
                        {owner && owner !== id ? ` — ${botById(owner)?.name}` : ''}
                      </option>
                    );
                  })}
                </select>
              </Section>
            </>
          )}
          {tab === 'tasks' && (
            <ul className="space-y-1">
              {tasks.length === 0 && (
                <li className="text-xs text-stone-500">No tasks observed for {bot.name}.</li>
              )}
              {tasks.slice(0, 40).map((t) => (
                <li key={t.id} className="rounded border border-ink/15 bg-white p-1.5 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-bold">{t.title}</span>
                    <StatusChip status={t.status} />
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[10px] text-stone-500">
                    <span>
                      {fmtTime(t.startedAt ?? t.createdAt)} · {fmtDuration(durationMs(t))}
                    </span>
                    <SourceBadge source={t.source} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tab === 'chat' && (
            <>
              {mode !== 'replay' && <TaskThreads />}
              <ul className="space-y-1" data-testid="conversation">
                {mode === 'replay' && (
                  <li className="text-xs text-stone-500">
                    Replay messages appear as bubbles in the office and in the replay event list.
                  </li>
                )}
                {lines.length === 0 && mode !== 'replay' && (
                  <li className="text-xs text-stone-500">No conversation lines yet.</li>
                )}
                {lines.map((l) => (
                  <li key={l.id} className="rounded border border-ink/15 bg-white p-1.5 text-xs">
                    <div className="mb-0.5 flex items-center justify-between text-[10px] text-stone-500">
                      <span>
                        {fmtTime(l.timestamp)}{' '}
                        {l.meetingId ? '· meeting' : l.taskId ? '· task' : ''}
                      </span>
                      <SourceBadge source={l.source} />
                    </div>
                    {l.text}
                  </li>
                ))}
              </ul>
            </>
          )}
          {tab === 'chat' && mode !== 'replay' && <TaskForm />}
        </div>
      )}
    </div>
  );
}

function FurniturePanel({ uid }: { uid: string }) {
  const layout = useStore((s) => s.layout);
  const mode = useStore((s) => s.mode);
  const f = layout.furniture.find((x) => x.uid === uid);
  const s = useStore.getState;
  if (!f) return <p className="text-xs text-stone-500">That item was removed.</p>;
  const c = getCatalog(f.catalogId);
  const owner = Object.entries(layout.deskAssignments).find(([, u]) => u === uid)?.[0];
  const rotate = () => {
    const next = { ...f, rot: ((f.rot + 1) % 4) as Rotation };
    const r = validatePlacement(layout, next);
    if (!r.ok) return s().toast(r.reason, 'warn');
    s().commitLayout({
      ...layout,
      furniture: layout.furniture.map((x) => (x.uid === uid ? next : x)),
    });
  };
  const remove = () => {
    const deskAssignments = Object.fromEntries(
      Object.entries(layout.deskAssignments).filter(([, u]) => u !== uid),
    );
    s().commitLayout(
      { ...layout, furniture: layout.furniture.filter((x) => x.uid !== uid), deskAssignments },
      owner ? `${botById(owner)?.name} no longer has a desk.` : 'Removed.',
    );
    s().select(null);
  };
  return (
    <div data-testid="furniture-panel">
      <div className="mb-1 text-sm font-extrabold">{c.name}</div>
      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
        <dt className="text-stone-500">Category</dt>
        <dd className="capitalize">{c.category}</dd>
        <dt className="text-stone-500">Position</dt>
        <dd>
          tile {f.x}, {f.z} · {roomAt(layout, f.x, f.z)?.name ?? '—'}
        </dd>
        <dt className="text-stone-500">Rotation</dt>
        <dd>{f.rot * 90}°</dd>
        <dt className="text-stone-500">Size</dt>
        <dd>
          {c.w}×{c.d}
        </dd>
        {owner && (
          <>
            <dt className="text-stone-500">Desk of</dt>
            <dd>{botById(owner)?.name}</dd>
          </>
        )}
        <dt className="text-stone-500">Uses</dt>
        <dd>
          {c.points.length
            ? c.points
                .map((p) => p.kind + (p.tags?.length ? ` (${p.tags.join(', ')})` : ''))
                .join(', ')
            : 'decorative'}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-1">
        <button className="btn" onClick={rotate}>
          <RotateCw size={12} /> Rotate
        </button>
        <button
          className="btn"
          onClick={() => {
            if (mode !== 'build') s().setMode('build');
            s().setBuild({ tool: 'select', carrying: uid, rot: f.rot });
            s().toast('Move the pointer and click a tile to drop it (Esc cancels, R rotates).');
          }}
        >
          <Move size={12} /> Move
        </button>
        <button className="btn" onClick={remove}>
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

function RoomPanel({ id }: { id: string }) {
  useTick(800);
  const layout = useStore((s) => s.layout);
  const room = layout.rooms.find((r) => r.id === id);
  const s = useStore.getState;
  if (!room) return <p className="text-xs text-stone-500">That room no longer exists.</p>;
  const tiles = layout.tiles.filter((t) => t.roomId === id).length;
  const assigned = Object.entries(layout.deskAssignments)
    .filter(([, uid]) => {
      const f = layout.furniture.find((x) => x.uid === uid);
      return (
        f && itemPoints(f).some((p) => p.kind === 'desk' && roomAt(layout, p.tx, p.tz)?.id === id)
      );
    })
    .map(([b]) => b);
  const present = roster.filter((b) => {
    const br = world.brains.get(b.id);
    return br && roomAt(layout, br.tile.x, br.tile.z)?.id === id;
  });
  const patchRoom = (p: Partial<typeof room>) =>
    s().commitLayout({
      ...layout,
      rooms: layout.rooms.map((r) => (r.id === id ? { ...r, ...p } : r)),
    });
  return (
    <div data-testid="room-panel">
      <label className="mb-1 block text-[10px] font-bold text-stone-500">
        Room name
        <input
          className="field mt-0.5 w-full"
          value={room.name}
          onChange={(e) => patchRoom({ name: e.target.value.slice(0, 40) })}
        />
      </label>
      <label className="mb-2 block text-[10px] font-bold text-stone-500">
        Room type
        <select
          className="field mt-0.5 w-full capitalize"
          value={room.type}
          onChange={(e) => patchRoom({ type: e.target.value as RoomType })}
        >
          {roomTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="mb-2 block text-[10px] font-bold text-stone-500">
        Flooring (whole room)
        <select
          className="field mt-0.5 w-full"
          value=""
          onChange={(e) => {
            const floor = e.target.value as (typeof floorTypes)[number];
            if (!floor) return;
            s().commitLayout({
              ...layout,
              tiles: layout.tiles.map((t) => (t.roomId === id ? { ...t, floor } : t)),
            });
          }}
        >
          <option value="">Choose…</option>
          {floorTypes.map((f) => (
            <option key={f} value={f}>
              {floorLabel(f)}
            </option>
          ))}
        </select>
      </label>
      <p className="mb-1 text-xs">{tiles} tiles</p>
      <Section title="Assigned Bots">
        <p className="text-xs">
          {assigned.length ? assigned.map((b) => botById(b)?.name).join(', ') : 'None'}
        </p>
      </Section>
      <Section title="In the room now">
        <p className="text-xs">
          {present.length ? present.map((b) => b.name).join(', ') : 'Nobody'}
        </p>
      </Section>
      <button className="btn" onClick={() => s().focus({ kind: 'room', id })}>
        <Crosshair size={12} /> Focus room
      </button>
    </div>
  );
}

export function RightPanel() {
  const open = useStore((s) => s.rightOpen);
  const selection = useStore((s) => s.selection);
  const mode = useStore((s) => s.mode);
  if (!open)
    return (
      <button
        className="btn absolute right-2 top-16 z-20 !px-1"
        onClick={() => useStore.getState().toggleRight()}
        aria-label="Open details panel"
      >
        <ChevronLeft size={14} />
      </button>
    );
  if (selection?.kind === 'bot')
    return (
      <aside
        className={`panel absolute left-2 right-2 z-20 flex flex-col overflow-hidden sm:bottom-16 sm:left-auto sm:top-16 sm:h-auto sm:w-80 ${mode === 'build' ? 'top-16 h-[36%]' : 'bottom-16 h-[52%]'}`}
        data-testid="right-panel"
      >
        <BotPanel key={selection.id} id={selection.id} />
      </aside>
    );
  return (
    <aside
      className={`panel scroll-thin absolute left-2 right-2 z-20 overflow-y-auto p-3 sm:bottom-16 sm:left-auto sm:top-16 sm:max-h-none sm:w-72 ${mode === 'build' ? 'top-16 max-h-[36%]' : 'bottom-16 max-h-[48%]'}`}
      data-testid="right-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="panel-title">
          {selection?.kind === 'furniture'
            ? 'Furniture'
            : selection?.kind === 'room'
              ? 'Room'
              : 'Details'}
        </h2>
        <button
          className="btn !px-1"
          onClick={() => useStore.getState().toggleRight()}
          aria-label="Collapse details panel"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      {selection?.kind === 'furniture' && <FurniturePanel uid={selection.uid} />}
      {selection?.kind === 'room' && <RoomPanel id={selection.id} />}
      {!selection && (
        <div className="space-y-2 text-xs text-stone-600">
          <p>Click a Bot, a piece of furniture or a floor tile to see details here.</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Left-drag: pan · wheel: zoom · right/middle-drag or Q/E: rotate</li>
            <li>Double-click a Bot to focus and follow it</li>
            <li>WASD/arrows pan · 0 resets the camera · B toggles build mode</li>
            {mode === 'build' && (
              <li>Build: R rotates, Del deletes, Ctrl+Z / Ctrl+Shift+Z undo/redo</li>
            )}
          </ul>
        </div>
      )}
    </aside>
  );
}
