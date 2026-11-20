# Architecture

```
backend/src/        Fastify (127.0.0.1 only), SSE stream, SQLite (node:sqlite)
  index.ts          routes: /api/health, roster, sources, stream (SSE), events, sessions, state/:key
  providers.ts      ProviderManager: Simulation (B), LocalCache (A), OfficialApiAdapter (C, unavailable)
  localCache.ts     read-only JSONL folder watcher (fs.watch + 3 s poll, offsets, rotation, dedupe)
  db.ts             events table (id PK → duplicate-proof) + kv app state
shared/             pure TypeScript, unit-tested, used by backend, frontend and tests
  types.ts          BotEvent, Task, Room, Wall, FurnitureItem, OfficeLayout, Appearance, Meeting
  roster.ts         the six Bots from grok-3d-office (IDs/names/roles/colours unchanged)
  catalog.ts        data-driven furniture: footprint mask (B/S/F), interaction points, unlocks
  layout.ts         grid, rotation maths, nav grid with edge walls, validation, resize, default office
  pathfinding.ts    8-way A* (octile, no corner cutting, seat cost, dynamic penalties)
  behavior.ts       OfficeWorld + AgentBrain FSM (IDLE…OFFLINE), reservations, chats, avoidance
  events.ts         zod schema, source classification, Deduper, task reducer, stats, filters
  meetings.ts       reachable meeting seats + deterministic seat allocation
  bubbles.ts        priority/collision layout for head labels and speech bubbles
  replay.ts         sessions, gaps, ReplayEngine, REPLAYED relabelling
  simProvider.ts    seeded simulation provider (+ demo history generator)
  progression.ts    cosmetic XP/coins/achievements/unlocks (separate from monitoring)
frontend/src/
  store.ts          Zustand: live TaskState, replay TaskState, layout + undo/redo, appearances,
                    progression, settings, UI state. Persisted to SQLite kv + localStorage.
  api.ts            SSE connection, browser-side simulation fallback, persistence
  systems/world.ts  task/meeting state → brain directives; seat plans; replay clock
  systems/audio.ts  procedural Web Audio engine (gesture-gated)
  scene/            R3F scene: CameraRig (ortho iso + MapControls), Floor (canvas atlas),
                    Walls (merged, camera-aware cutaway), Furniture (merged vertex-colour voxels,
                    animated screens/LEDs/steam/fish), Character (voxel chibi, procedural anims),
                    Environment (seasons, day/night, instanced trees, particles, clouds, sun),
                    BuildLayer (ghosts, painting, walls), Overlay (DOM labels, imperative positions)
  ui/               TopBar, sidebars, toolbar, BuildPanel, Dashboard, Modals
```

**Data flow.** Providers → `ProviderManager.publish` → SQLite (`INSERT OR IGNORE`) → SSE →
`store.ingest` (client dedupe) → `applyEvent` reducer → `world.ts` derives directives
(`work` / `meeting` / `idle` / `offline`) → `OfficeWorld` brains → renderer reads brains in
`useFrame` (no React re-render per frame).

**Rendering.** Orthographic camera at true isometric elevation; pixel look from rendering at
0.42–0.7 device-pixel ratio with `image-rendering: pixelated` plus nearest-filtered canvas
textures. Lambert materials, one directional shadow-casting light whose shadow map is
re-rendered on demand (layout, season or sun changes), blob shadows for characters.
Each furniture item is one merged, vertex-coloured geometry cached per catalog id.
Trees are instanced. Measured headless (software GL, SwiftShader): ~207 draw calls,
~11.5k triangles, 37 geometries, 24 textures for the default office. FPS under software
rendering is not representative; check the overlay on your GPU.

## Three.js skills

The `threejs-*` skills live in `~/.agents/skills` but are not registered with the Claude
Code Skill tool here, so their SKILL.md files were read directly:
`threejs-react-three-fiber`, `threejs-textures` (filtering), `threejs-performance` (draw
calls, merging, instancing, Clock deprecation) and `threejs-gameplay-systems`. The other
listed skills were not loaded. Their subsystems use official three.js / R3F / drei APIs:
no GLTF loaders or post-processing were needed, because all assets are procedural and
pixelation comes from the resolution scale.

## Known limitations

- No real Grok Bot data is shown unless you authorise a folder of JSONL events. Grok Bot
  has no documented event API or readable activity cache, and this app does not read its
  private data.
- Characters avoid each other with a soft path cost plus a short yield, not full crowd
  simulation, so brief overlaps can happen in tight aisles.
- Character draw calls are not merged (~20 meshes per Bot). A skinned or instanced
  character would cut ~120 calls.
- Speech-bubble collision avoidance lifts labels up to 3 steps and otherwise hides the
  lower-priority one.
- Layout save slots live in browser localStorage. The active layout, appearances,
  progression and settings are also stored in SQLite.
- drei/fiber emit the upstream `THREE.Clock` deprecation warning.
