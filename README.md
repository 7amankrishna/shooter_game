# BLACKLINE // ARENA

A 3D first-person **1v1**: you against **one** AI combat machine, in a medium open-world
arena, on one rifle, until somebody reaches 0 HP.

Prototype-grade by design: one map, one weapon, one enemy, no networking, no vehicles —
everything that is in there is tuned, and **every asset is procedural** (no downloads,
no binary files). Three.js + Vite, ~900 kB bundled, 22 headless tests covering the sim.

```
npm install
npm run dev      # http://localhost:5173
npm test         # 22 tests: logic, world generation, full match simulation, UI wiring
npm run build    # production bundle in dist/
```

## The loop

`MENU → DIFFICULTY → LOAD → SPAWN → SEARCH/DETECT → COMBAT → RESULTS → (Play Again | Change Difficulty | Main Menu)`

`Esc` pauses (Restart / Change difficulty / Quit resume the same loop). The machine spawns
60–80 m away on purpose: the match opens with a search phase, and it ends the first time
either side's health hits zero.

| Control | |
| --- | --- |
| `W A S D` / arrows | move |
| mouse | look (pointer lock; see fallback below) |
| `LMB` | fire |
| `RMB` | aim down sights — smoothed, never a snap |
| `R` | reload (auto-reload also kicks in when the mag runs dry mid-trigger-pull) |
| `Shift` | sprint (weapon swings out of the way, spread spikes) |
| `Space` | jump |
| `Ctrl` / `C` | crouch (steadier gun, smaller profile, slower) |
| `Esc` | pause |
| `F3` | perf overlay · `M` mute · `1/2/3` difficulty in menus |

**Pointer lock in an embedded preview:** browsers can refuse pointer lock inside an iframe.
If it is refused the game keeps playing — raw mouse deltas plus an edge-assist turn zone in
the outer 24 % of the window, and `Alt+←/→` for a precise turn. Nothing dead-ends.

## Scoring (the whole point of the gunplay)

| Region | Points | Damage |
| --- | --- | --- |
| Head | **+100** | 100 (one-shot kill) |
| Chest | +50 | 40 |
| Lower / pelvis | +40 | 30 |
| Arm | +25 | 20 |
| Leg | +20 | 15 |
| Graze (round passed within 0.5 m of armour) | +10 | 0 |

Hits chain: **combo multipliers** at streaks of 2 / 4 / 7 / 11 → ×1.5 / ×2 / ×2.5 / ×3, a
**headshot streak** bonus, an **accuracy** bonus at ≥70 % over at least 8 shots, and
,"+250 for the kill, +150 if that kill was a headshot, and a speed bonus of 4 points per second
saved under the 240 s par. A miss starts a 3.2 s grace window: land
inside it and the combo survives, otherwise it resets. Every hit pops floating score text at
the impact point in world space (`+100 HEADSHOT`, `+50 BODY HIT`), and dying halves the payout
so a loss still reports the marks you actually made.

Damage and points are deliberately **decoupled** — a leg hit pays 20 and costs the machine 15,
so "shoot for the head" is a real risk/reward decision rather than a strictly dominant choice.

## The machine

`src/ai/AIBrain.js` is a perception + FSM layer over `src/ai/AIMachine.js` (the body).

- **Perception:** `viewRange`, a `fovDeg` cone, real line-of-sight through the same collider
  grid bullets use, plus **hearing** (gunshots carry ~1.75× the hearing radius, sprint
  footsteps ~0.32×). Awareness accumulates over `acquireTime` and decays over `loseTime`, so
  breaking contact buys you a reposition, not a rest.
- **States:** `PATROL → INVESTIGATE → SEARCH → ENGAGE → IN_COVER → REPOSITION → FLANK →
  RELOAD → RETREAT → DEAD`, evaluated on a 0.28 s cadence. It does not stand still: strafe
  lines, periodic repositions, flanks on prolonged contact, cover on damage, and it tops its
  magazine up in safety (but not after every single shot — that reads as a robot with a tick
  counter).
- **Gunnery:** a reaction delay before answering, an aim sight that physically slews onto you
  (so its own movement and your direction changes cost it accuracy), grouping error resampled
  *per burst*, muzzle climb that decays between bursts, finite magazine, reload time, a fire
  range it will not exceed, and an `intentionalMiss` probability.

| | EASY · RECRUIT | MEDIUM · OPERATOR | HARD · WRAITH |
| --- | --- | --- | --- |
| reaction | 1.0 – 1.5 s | 0.5 – 0.8 s | 0.22 – 0.42 s |
| hit rate at 20–30 m | ~40 % | ~62 % | ~75 % |
| view / FOV | 42 m / 75° | 70 m / 100° | 96 m / 128° |
| burst | 1–2 | 2–4 | 3–5 |
| mag / reload | 20 / 3.6 s | 30 / 2.9 s | 30 / 2.5 s |
| cover use | 0.18 | 0.6 | 0.85 |
| flanking | 0.04 | 0.3 | 0.55 |

HP is **100 on every difficulty**: difficulty changes decision quality and gun handling, not
the size of the health bar. Hard mode is not an aimbot and the test suite enforces that
(`tests/logic.test.mjs` asserts HARD still has a reaction delay, still misses, still reloads,
and still moves at human speed).

## The AK-01

Procedural rifle + arms viewmodel (`src/weapons/RifleModel.js`): 30 / 120 rounds, 640 rpm,
bolt-open reload 2.35 s vs 1.65 s tactical (magazine retained), mag-check on dry, per-shot bloom that decays,
recoil pattern with randomised side-to-side, ADS from 2.6° hip spread down to 0.22°,
sway that follows movement, bolt cycling, muzzle flash, tracers that *travel* (a segment
moving down the ray, not a stretched quad), ejected brass that bounces off the ground with a
ping, and reload/dry-fire/hit audio. The viewmodel renders in its own scene after a depth
clear, so the barrel can never poke through a wall.

## Arena

`src/world/Environment.js` builds a ~216 m abandoned supply quarter — village block west,
warehouse + container depot east, ruins north, shop row south, an elevated overlook deck at
(58, 80) you can reach by stairs, roads bisecting the middle, perimeter berm at ±107 m. Close,
medium and long sightlines all exist on purpose; **610 cover points** are derived from the
collider volumes (hard cover needs ≥0.95 m of height above its base, and a cover point must
face away from the threat to count). Terrain is an analytic heightfield (roads flattened,
hills, a trench), and colliders are a uniform-grid AABB world (`src/physics/ColliderWorld.js`)
with DDA ray queries — bullets, line-of-sight and the AI's body sweep all share it.

## Performance

- Static geometry merged per structure; props (trees, rocks, crates, barrels, fences…) in
  instanced LOD families with zero-scale culling and a distance budget.
- `CellCuller` hides whole 24 m blocks of buildings outside the frustum, and shadow casting is
  distance-gated to `RENDER.shadowCasterRange` with the shadow map refreshed at ~10 Hz on a
  4 m follow grid (the arena is static — a per-frame shadow pass would be wasted).
- One shadow-casting light. Two static fills. No point lights except the muzzle flash.
- Pooled particles / tracers / decals / shells; zero per-frame allocation in the hot path.
- Adaptive pixel ratio: holds ~55 fps by scaling the framebuffer between 0.62× and the
  device ratio (capped at 1.75) instead of dropping frames.
- HUD writes to the DOM only when a value actually changes (per-field dirty cache).
- `F3` shows fps, frame ms, draw calls, triangles, prop/LOD counts, live cell counts, particle
  count, shadow casters, rays and box tests per frame, AI state/awareness/HP, and the current
  resolution scale.

## Layout

```
src/config/    GameConfig.js, DifficultyConfig.js        all tuning lives here
src/core/      Engine, InputManager, AudioEngine, Fx, Textures, Geo, math
src/physics/   Heightfield (terrain/roads), ColliderWorld (AABB grid + DDA)
src/world/     Environment, NavGrid (A* bake), LODInstances (props, cell culling)
src/player/    PlayerController (movement, camera, ADS, recoil, damage)
src/weapons/   RifleModel, Weapon
src/ai/        AIMachine (body), AIBrain (perception + FSM)
src/game/      HitDetection, Scoring, Match (orchestrator)
src/ui/        styles.css, HUD, Menu
tests/         logic.test.mjs, sim.test.mjs, ui.test.mjs, stubDom.js
```

`src/game/Match.js` is the only place combat state changes hands: it owns the tick order
(weapon → player → camera sync → fire → AI → AI shot → scoring → FX → audio → win/loss) and
emits `hit / miss / playerDamaged / results / phase / log / warn` for the UI to react to. The
UI never mutates the simulation.

## Testing note

`npm test` runs the whole game for thousands of fixed ticks **without a browser** — it builds
the real arena, then asserts that the machine detects, closes distance, uses cover/flank/
reposition, runs its magazine dry, hits *and* misses; that every body region maps to the
designed points and damage; that a match reaches `WIN` through sustained rifle fire and `LOSE`
through player death; that pause really freezes the sim; that generation is deterministic
(same seed → identical collider hash); and that a full sim tick costs ≈0.15 ms, so rendering
gets the rest of the frame.
