import { useRef, useState } from 'react';
import {
  BrickWall,
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  MousePointer2,
  Paintbrush,
  Plus,
  Redo2,
  RotateCw,
  Search,
  SquareDashed,
  Undo2,
  Upload,
  LayoutGrid,
} from 'lucide-react';
import { catalog, furnitureCategories } from '../../../shared/catalog';
import { createDefaultLayout, resizeLayout, checkEssentialRoutes } from '../../../shared/layout';
import { buyItem, canUse, levelFor } from '../../../shared/progression';
import type { OfficeLayout, RoomType, WallKind } from '../../../shared/types';
import { isNarrow, loadLocal, saveLocal, useStore, type BuildTool } from '../store';
import { floorLabel, floorSwatch, floorTypes } from '../scene/textures';
import { roomTypes } from './RightPanel';
import { Section } from './common';

const tools: { id: BuildTool; label: string; icon: typeof MousePointer2 }[] = [
  { id: 'select', label: 'Select / move', icon: MousePointer2 },
  { id: 'place', label: 'Place', icon: Plus },
  { id: 'floor', label: 'Floor', icon: Paintbrush },
  { id: 'room', label: 'Rooms', icon: SquareDashed },
  { id: 'wall', label: 'Walls', icon: BrickWall },
  { id: 'erase', label: 'Erase', icon: Eraser },
];
const wallKinds: { id: WallKind; label: string }[] = [
  { id: 'wall', label: 'Wall' },
  { id: 'glass', label: 'Glass' },
  { id: 'window', label: 'Window' },
  { id: 'door', label: 'Door' },
  { id: 'partition', label: 'Low partition' },
];
const catIcon: Record<string, string> = {
  desks: '🖥️',
  chairs: '🪑',
  computers: '🖨️',
  cabinets: '🗄️',
  tables: '🍽️',
  sofas: '🛋️',
  plants: '🪴',
  lighting: '💡',
  appliances: '☕',
  decorations: '🖼️',
};

const isValidLayout = (v: unknown): v is OfficeLayout => {
  const l = v as OfficeLayout;
  return (
    !!l &&
    l.version === 1 &&
    Array.isArray(l.tiles) &&
    l.tiles.length === l.width * l.depth &&
    Array.isArray(l.furniture) &&
    Array.isArray(l.walls) &&
    Array.isArray(l.rooms)
  );
};

export function BuildPanel() {
  const build = useStore((s) => s.build);
  const layout = useStore((s) => s.layout);
  const progression = useStore((s) => s.progression);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [newRoom, setNewRoom] = useState<{ name: string; type: RoomType }>({
    name: 'New Room',
    type: 'recreation',
  });
  const [slots, setSlots] = useState<string[]>(() =>
    Object.keys(loadLocal<Record<string, OfficeLayout>>('layouts') ?? {}),
  );
  const [slotName, setSlotName] = useState('My layout');
  const [confirmReset, setConfirmReset] = useState(false);
  // Phones: the builder is a bottom sheet that folds away so the floor stays tappable.
  const [folded, setFolded] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const s = useStore.getState;
  const level = levelFor(progression.officeXp);
  const items = catalog.filter(
    (c) =>
      (category === 'all' || c.category === category) &&
      c.name.toLowerCase().includes(query.toLowerCase()),
  );

  const resize = (side: 'north' | 'south' | 'east' | 'west', d: 1 | -1) => {
    const r = resizeLayout(s().layout, side, d);
    if (typeof r === 'string') s().toast(r, 'warn');
    else s().commitLayout(r);
  };
  const saveSlot = () => {
    const all = loadLocal<Record<string, OfficeLayout>>('layouts') ?? {};
    all[slotName] = s().layout;
    saveLocal('layouts', all);
    setSlots(Object.keys(all));
    s().toast(`Saved “${slotName}”.`, 'good');
  };
  const loadSlot = (name: string) => {
    const l = (loadLocal<Record<string, OfficeLayout>>('layouts') ?? {})[name];
    if (l && isValidLayout(l)) s().commitLayout(l, `Loaded “${name}”.`);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(s().layout, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s().layout.name.replace(/\W+/g, '-').toLowerCase() || 'office'}-layout.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (f: File) => {
    try {
      const v = JSON.parse(await f.text());
      if (!isValidLayout(v)) throw new Error('Not a Pixel Office layout file.');
      const check = checkEssentialRoutes(v);
      if (!check.ok) throw new Error(check.reason);
      s().commitLayout(v, 'Layout imported.');
    } catch (err) {
      s().toast(err instanceof Error ? err.message : 'Import failed', 'warn');
    }
  };

  return (
    <aside
      className="panel scroll-thin absolute bottom-16 left-2 right-2 z-20 max-h-[42%] overflow-y-auto p-3 sm:right-auto sm:top-16 sm:max-h-none sm:w-72"
      data-testid="build-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="panel-title">Office builder</h2>
        <div className="flex gap-1">
          <button
            className="btn !px-1.5"
            disabled={!past}
            onClick={() => s().undo()}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 size={13} />
          </button>
          <button
            className="btn !px-1.5"
            disabled={!future}
            onClick={() => s().redo()}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <Redo2 size={13} />
          </button>
          <button
            className="btn !px-1.5"
            onClick={() => s().setBuild({ rot: ((build.rot + 1) % 4) as 0 | 1 | 2 | 3 })}
            title="Rotate (R)"
            aria-label="Rotate"
          >
            <RotateCw size={13} /> {build.rot * 90}°
          </button>
          <button
            className="btn !px-1.5 sm:!hidden"
            onClick={() => setFolded(!folded)}
            aria-label={folded ? 'Show builder' : 'Fold builder'}
            aria-expanded={!folded}
            data-testid="build-fold"
          >
            {folded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>
      {folded && (
        <p className="text-[11px] text-stone-700 sm:hidden">
          {build.tool === 'place' && build.catalogId
            ? `Placing ${catalog.find((c) => c.id === build.catalogId)?.name ?? 'item'}: tap the floor. Tap again to place another.`
            : 'Tap the arrow to show tools and furniture.'}
        </p>
      )}
      <div className={folded ? 'max-sm:hidden' : ''}>
        <p className="mb-2 rounded bg-amber-100 px-2 py-1 text-[10px] text-amber-900">
          Bots pause while you build; they re-route when you leave. Changes save automatically.
        </p>
        <div className="mb-3 grid grid-cols-3 gap-1">
          {tools.map((t) => (
            <button
              key={t.id}
              className={`btn !text-[11px] ${build.tool === t.id ? 'btn-active' : ''}`}
              onClick={() => s().setBuild({ tool: t.id, carrying: undefined })}
              data-testid={`tool-${t.id}`}
            >
              <t.icon size={12} /> {t.label}
            </button>
          ))}
        </div>
        {build.warning && (
          <p className="mb-2 rounded bg-stone-100 px-2 py-1 text-[10px]">⚠️ {build.warning}</p>
        )}

        {(build.tool === 'place' || build.tool === 'select') && (
          <Section title="Furniture catalog">
            <div className="mb-1 flex items-center gap-1">
              <Search size={12} />
              <input
                className="field w-full"
                placeholder="Search furniture"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search furniture"
              />
            </div>
            <div className="mb-2 flex flex-wrap gap-1">
              {['all', ...furnitureCategories].map((c) => (
                <button
                  key={c}
                  className={`chip border border-ink/30 ${category === c ? 'bg-ink text-cream' : 'bg-white'}`}
                  onClick={() => setCategory(c)}
                >
                  {c === 'all' ? 'All' : `${catIcon[c]} ${c}`}
                </button>
              ))}
            </div>
            <ul className="grid grid-cols-2 gap-1">
              {items.map((c) => {
                const usable = canUse(progression, c.id);
                const levelOk = level >= c.unlockLevel;
                const active = build.tool === 'place' && build.catalogId === c.id;
                return (
                  <li key={c.id}>
                    <button
                      draggable={usable}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-furniture', c.id);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className={`w-full rounded-md border-2 p-1.5 text-left ${active ? 'border-amber-500 bg-amber-50' : 'border-ink/20 bg-white hover:border-ink/60'} ${usable ? '' : 'opacity-70'}`}
                      onClick={() => {
                        if (usable) {
                          if (isNarrow()) setFolded(true);
                          return s().setBuild({
                            tool: 'place',
                            catalogId: c.id,
                            carrying: undefined,
                          });
                        }
                        const r = buyItem(s().progression, c.id);
                        if (typeof r === 'string') s().toast(r, 'warn');
                        else {
                          s().setProgression(r);
                          s().toast(`Unlocked ${c.name}!`, 'good');
                        }
                      }}
                      data-testid={`catalog-${c.id}`}
                      title={
                        usable
                          ? 'Click or tap, then click the floor (or drag onto the floor)'
                          : `Unlock: level ${c.unlockLevel}, ${c.price} coins`
                      }
                    >
                      <div className="text-[11px] font-bold leading-tight">
                        {catIcon[c.category]} {c.name}
                      </div>
                      <div className="text-[9px] text-stone-500">
                        {c.w}×{c.d}{' '}
                        {usable ? '' : levelOk ? `· 🔒 ${c.price}🪙` : `· 🔒 Lv ${c.unlockLevel}`}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {build.tool === 'floor' && (
          <Section title="Flooring — click or drag to paint">
            <div className="grid grid-cols-2 gap-1">
              {floorTypes.map((f) => (
                <button
                  key={f}
                  className={`btn !justify-start ${build.floor === f ? 'btn-active' : ''}`}
                  onClick={() => s().setBuild({ floor: f })}
                >
                  <span
                    className="h-3 w-3 rounded-sm border border-ink"
                    style={{ background: floorSwatch(f) }}
                  />{' '}
                  {floorLabel(f)}
                </button>
              ))}
            </div>
          </Section>
        )}

        {build.tool === 'room' && (
          <Section title="Rooms — pick one, then paint tiles">
            <ul className="mb-2 space-y-1">
              {layout.rooms.map((r) => (
                <li key={r.id}>
                  <button
                    className={`btn w-full !justify-start ${build.roomId === r.id ? 'btn-active' : ''}`}
                    onClick={() => s().setBuild({ roomId: r.id })}
                  >
                    {r.name} <span className="text-[10px] font-normal">({r.type})</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="rounded border border-ink/20 bg-white p-2">
              <div className="mb-1 text-[10px] font-bold">Create room</div>
              <input
                className="field mb-1 w-full"
                value={newRoom.name}
                onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value.slice(0, 40) })}
                aria-label="New room name"
              />
              <select
                className="field mb-1 w-full capitalize"
                value={newRoom.type}
                onChange={(e) => setNewRoom({ ...newRoom, type: e.target.value as RoomType })}
                aria-label="New room type"
              >
                {roomTypes.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <button
                className="btn w-full"
                onClick={() => {
                  const id = `room-${Date.now().toString(36)}`;
                  s().commitLayout({
                    ...layout,
                    rooms: [
                      ...layout.rooms,
                      { id, name: newRoom.name || 'Room', type: newRoom.type },
                    ],
                  });
                  s().setBuild({ roomId: id });
                }}
              >
                <Plus size={12} /> Add & paint
              </button>
            </div>
          </Section>
        )}

        {build.tool === 'wall' && (
          <Section title="Walls — click a tile edge">
            <div className="grid grid-cols-2 gap-1">
              {wallKinds.map((w) => (
                <button
                  key={w.id}
                  className={`btn ${build.wallKind === w.id ? 'btn-active' : ''}`}
                  onClick={() => s().setBuild({ wallKind: w.id })}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-stone-500">
              Clicking an edge that already has this kind removes it (outer walls can only change
              kind). Routes to desks and rooms are always kept open.
            </p>
          </Section>
        )}

        {build.tool === 'erase' && (
          <p className="mb-3 text-xs">
            Click furniture to remove it. Removing an assigned desk leaves that Bot without a desk
            until you assign another.
          </p>
        )}

        <Section title={`Office size · ${layout.width}×${layout.depth}`}>
          <div className="grid grid-cols-2 gap-1 text-[11px]">
            {(['north', 'south', 'west', 'east'] as const).map((side) => (
              <div
                key={side}
                className="flex items-center justify-between rounded border border-ink/20 bg-white px-1.5 py-0.5"
              >
                <span className="capitalize">{side}</span>
                <span className="flex gap-0.5">
                  <button
                    className="btn !px-1 !py-0"
                    onClick={() => resize(side, -1)}
                    aria-label={`Shrink ${side}`}
                  >
                    −
                  </button>
                  <button
                    className="btn !px-1 !py-0"
                    onClick={() => resize(side, 1)}
                    aria-label={`Expand ${side}`}
                    data-testid={`expand-${side}`}
                  >
                    +
                  </button>
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Layouts">
          <div className="mb-1 flex gap-1">
            <input
              className="field w-full"
              value={slotName}
              onChange={(e) => setSlotName(e.target.value.slice(0, 30))}
              aria-label="Layout name"
            />
            <button className="btn" onClick={saveSlot}>
              Save
            </button>
          </div>
          {slots.length > 0 && (
            <select
              className="field mb-1 w-full"
              value=""
              onChange={(e) => e.target.value && loadSlot(e.target.value)}
              aria-label="Load layout"
            >
              <option value="">Load saved layout…</option>
              {slots.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          )}
          <div className="flex flex-wrap gap-1">
            <button className="btn" onClick={exportJson}>
              <Download size={12} /> Export
            </button>
            <button className="btn" onClick={() => file.current?.click()}>
              <Upload size={12} /> Import
            </button>
            <input
              ref={file}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
            />
            {confirmReset ? (
              <>
                <button
                  className="btn !bg-rose-200"
                  onClick={() => {
                    s().commitLayout(createDefaultLayout(), 'Reset to the default office.');
                    setConfirmReset(false);
                  }}
                >
                  Confirm reset
                </button>
                <button className="btn" onClick={() => setConfirmReset(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => setConfirmReset(true)}>
                <LayoutGrid size={12} /> Reset default
              </button>
            )}
          </div>
        </Section>
      </div>
    </aside>
  );
}
