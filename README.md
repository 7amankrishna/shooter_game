# BLACKLINE: DEADFALL

A survival-horror zombie shooter. You are dropped into an endless, procedurally
generated deadland with a rifle, a sidearm and a marksman's bolt-action — scavenge,
fight, earn coins, call in supply drops, climb watchtowers to breathe, and survive
the night. **Every asset is procedural** (geometry, textures, audio cues, world):
no downloads, no binary files. Three.js + Vite, one dependency.

```
npm install
npm run dev      # http://localhost:5173
npm test         # 39 headless tests: physics, world gen, AI, economy, full-run sim, UI, boot → PLAY
npm run build    # production bundle in dist/
npm run smoke    # Playwright browser test of the built game (needs `npx playwright install chromium`,
                 # or CHROMIUM_PATH=/path/to/chrome to use a local browser)
```

## The loop

```
MENU → LOAD → EXPLORE → SCAVENGE → FIGHT → COINS → SUPPLY DROPS → NIGHT → ...
                 ↳ climb a tower to regroup (safe zone, weapons hold)
                 ↳ die → RUN SUMMARY → (Restart | Main Menu | Continue from autosave)
```

Difficulty scales with **distance travelled, time survived, kills and darkness** —
the further you push from the spawn clearing, the worse it gets. Death is permanent
for a run; the autosave keeps your last standing state for a Continue.

## Controls

| Input | Action |
| --- | --- |
| **W A S D / Arrows** | Move (camera-relative, normalized diagonals) |
| **Mouse** | Look · **LMB** fire (hold for auto) · **RMB** aim down sights |
| **Shift** | Sprint (stamina) · **C / Ctrl** crouch · **Space** jump |
| **R** | Reload · **1 / 2 / 3 / wheel** weapons |
| **E** | Interact — climb towers, open crates, grab loot |
| **B** | Supply-drop buy menu (coins) |
| **Esc** | Close overlay / pause |
| **F3** | Debug stats · **M** mute · **F6** admin panel (dev: time + weather) |

## What's in the box

**Player & physics** — heightfield terrain with proper slope physics (no launches,
no hovering: gravity-first integration, step-up, downhill glue, cliff faces become
walls), stamina/sprint/crouch, per-surface footsteps, landing dips, camera recoil
and damage shake. Towers teleport-free: a 1-second climb transition, then a safe
platform with slow health regen and a weapons hold.

**Weapons** — three def-driven firearms (P-92 sidearm, AK-01 carbine, M-700
marksman): ballistic feel with recoil patterns, hip/ADS spread bloom, tracers,
shell ejection, reload states, weapon switching with raise animations. Hit
detection is limb-accurate: headshots, chest, limbs — with damage multipliers,
stagger and physical death topples on the zombies.

**Zombies** — five types (Walker, Runner, Brute, Crawler, Screamer) with distinct
stats, silhouettes, gaits, vocals and payouts. A real perception model: vision
cones with line-of-sight, hearing that routes gunshots/sprints/crate impacts to
nearby zombies, an 8 Hz think tick over an FSM (idle → wander → investigate →
chase → attack → search → dead). No omniscience — sneak, break line of sight, and
they lose you. Screamers call the horde. Night narrows *their* sight less than
yours.

**World** — infinite deterministic chunk streaming (seeded), five blended biomes
(forest / field / rocky / abandoned / dead), varied vegetation (trees, bushes,
rocks, grass) with scale/rotation/density variation, ruins and structures, a
winding road, watchtowers on a 168 m grid. Chunks generate and unload around you;
no seams, no popping, no per-frame allocations.

**Atmosphere** — full day/night cycle with graded sky, sun, fog and exposure
(darker nights stay playable), weather system (clear / cloudy / fog / rain /
storm / heavy fog) with slow blending and lightning + delayed thunder, and a
rain field that follows the camera. Adaptive audio: explore/tension/chase/night
music layers with cooldowns, 3D-positioned zombie vocals, footsteps, wind, rain.

**Economy** — coins per kill (type-based, night and headshot bonuses), four
airdrop tiers (Basic / Medical / Weapon / Premium) that fall from the sky with a
beacon, randomized loot tables with rarity, ammo/health pickups scattered in the
world. Crates land loudly — the noise draws zombies.

**UI** — main menu with settings (sensitivity, FOV, invert-Y, screen shake,
volumes, quality presets — persisted), controls screen, pause, death screen with
run stats, loading progress. HUD: vitals, stamina, ammo + weapon slots, clock /
phase / weather / threat, a compass with threat markers, coin counter, prompts
("E — CLIMB TOWER"), notifications ("+25 HEALTH"), buy menu, admin panel.

## Architecture

```
src/
  config/    GameConfig.js        — every tunable in one place (no magic numbers)
  core/      Engine, InputManager, AudioEngine, Fx, RainField, Textures, Geo, math
  physics/   Heightfield (terrain fns + chunk geometry), ColliderWorld (rays,
             cylinder sweeps, wall slide, steps — the anti-launch physics)
  world/     World (chunk streaming), Structures, LODInstances
  player/    PlayerController     — movement, look, camera feel, towers
  zombies/   Zombie (body + animation), ZombieAI (FSM + senses), ZombieManager
             (pool, spawn director, noise routing, difficulty)
  weapons/   Weapon (def-driven), Loadout, RifleModel (procedural viewmodels)
  game/      Survival (state machine + wiring), HitDetection, Economy, DayNight,
             Weather
  ui/        HUD, Menu, styles.css
  main.js    bootstrap: engine ↔ menu ↔ game, settings, admin DOM wiring
tests/       stubDom.js (headless DOM) + logic / sim / ui suites
```

Design rules the code holds itself to:

- **Config over constants** — all balance lives in `GameConfig.js`.
- **No per-frame allocations** in the hot path; pooled zombies, particles, drops.
- **Determinism from seeds** — same seed, same world, same loot rolls.
- **Fix root causes** — the original hover/launch bug was solved in `moveBody`
  (gravity-first integration + climb-rate clamp), not by teleport hacks.
- **Headless-testable** — the whole game runs without a renderer; the sim suite
  plays minutes of the real loop and asserts on behavior.

## Performance notes

Chunk streaming with a 7×7 resident grid, merged grass geometry per chunk,
cell-level culling, pooled everything, capped audio voices with distance culling,
and a fixed 900-drop rain field driven by a single draw call. The headless
performance smoke keeps 60 sim-seconds under a fraction of real time.

## Credits

Built on [three.js](https://threejs.org). Everything else — terrain, textures,
weapon models, zombie bodies, audio cues, UI — generated in code.
