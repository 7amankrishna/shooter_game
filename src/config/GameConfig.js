/**
 * BLACKLINE: DEADFALL — central tuning file.
 *
 * Every gameplay number the designer would touch lives here so that the
 * systems (player, weapons, zombies, world, economy, weather) stay decoupled
 * and easy to expand.
 */

export const WORLD = {
  /** Master world seed. The whole infinite world is deterministic from it. */
  seed: 20260917,
  /** Chunk edge in metres. Terrain, props and colliders stream per chunk. */
  chunkSize: 48,
  /** Terrain mesh grid resolution per chunk (2 m grid). */
  chunkSegments: 24,
  /** Chunk radius kept resident around the player (7x7 chunks). */
  viewChunks: 3,
  /** Chunks that may be generated per frame while playing (hitch guard). */
  chunksPerFrame: 1,
  gravity: -24,
  /** One watchtower cell every N metres (grid, deterministic). */
  towerGrid: 168,
  /** Terrain clears + flattens around the spawn camp. */
  spawnClearing: 26,
};

export const PLAYER = {
  health: 100,
  radius: 0.4,
  eyeHeight: 1.66,
  crouchEyeHeight: 1.0,
  height: 1.8,
  crouchHeight: 1.15,
  accelGround: 68,
  accelAir: 14,
  brakeGround: 12,
  maxSpeed: 5.5,
  sprintSpeed: 8.6,
  adsSpeed: 2.75,
  crouchSpeed: 2.4,
  jumpVelocity: 7.4,
  stepHeight: 0.62,
  /** Max upward ground correction per second when walking up slopes. */
  slopeClimbRate: 9,
  /** Walking downhill: glued to ground within this drop while grounded. */
  snapDown: 0.85,
  /** Mouse sensitivity multipliers. */
  hipSensitivity: 1.0,
  adsSensitivity: 0.42,
  sprintSensitivity: 1.12,
  /** Camera feel. */
  baseFov: 76,
  adsFov: 42,
  scopeFov: 14,
  sprintFovBoost: 8,
  bobFrequency: 8.6,
  bobAmount: 0.055,
  landingDip: 0.16,
  /** Stamina: sprinting drains, standing/walking regenerates. */
  staminaMax: 100,
  staminaDrain: 15,
  staminaRegen: 11,
  staminaMinToSprint: 22,
  /** Health slowly recovers while resting inside a tower safe zone. */
  towerRegen: 4,
  fallDamageMinSpeed: 13,
  fallDamageScale: 5.5,
};

/**
 * Weapon table. Each entry drives the shared Weapon system; the models are
 * built procedurally in RifleModel.js.
 */
export const WEAPONS = {
  sidearm: {
    id: 'sidearm',
    slot: 1,
    name: 'P-92 SIDEARM',
    type: 'pistol',
    model: 'sidearm',
    sound: 'shotPistol',
    auto: false,
    magSize: 15,
    reserveStart: 75,
    reserveMax: 150,
    rpm: 330,
    reloadTime: 1.9,
    tacticalReloadTime: 1.5,
    emptyClickDelay: 0.2,
    damage: 26,
    headMult: 2.6,
    limbMult: 0.7,
    hipSpread: 1.7,
    adsSpread: 0.3,
    spreadBloomPerShot: 0.34,
    spreadRecoveryPerSecond: 4.2,
    recoilKickUp: 0.72,
    recoilKickSide: 0.2,
    recoilRecovery: 10.5,
    adsFov: 52,
    scoped: false,
    hitRange: 200,
    switchTime: 0.3,
  },
  rifle: {
    id: 'rifle',
    slot: 2,
    name: 'AK-01 CARBINE',
    type: 'rifle',
    model: 'rifle',
    sound: 'shotRifle',
    auto: true,
    magSize: 30,
    reserveStart: 120,
    reserveMax: 300,
    rpm: 640,
    reloadTime: 2.35,
    tacticalReloadTime: 1.65,
    emptyClickDelay: 0.22,
    damage: 34,
    headMult: 2.2,
    limbMult: 0.72,
    hipSpread: 2.6,
    adsSpread: 0.22,
    spreadBloomPerShot: 0.28,
    spreadRecoveryPerSecond: 3.1,
    recoilKickUp: 0.85,
    recoilKickSide: 0.24,
    recoilRecovery: 9.5,
    adsFov: 40,
    scoped: false,
    hitRange: 260,
    switchTime: 0.42,
  },
  marksman: {
    id: 'marksman',
    slot: 3,
    name: 'M-700 MARKSMAN',
    type: 'marksman',
    model: 'marksman',
    sound: 'shotMarksman',
    auto: false,
    magSize: 5,
    reserveStart: 25,
    reserveMax: 80,
    rpm: 48,
    reloadTime: 3.1,
    tacticalReloadTime: 2.6,
    emptyClickDelay: 0.3,
    damage: 125,
    headMult: 2.0,
    limbMult: 0.8,
    hipSpread: 3.4,
    adsSpread: 0.06,
    spreadBloomPerShot: 1.1,
    spreadRecoveryPerSecond: 2.4,
    recoilKickUp: 2.6,
    recoilKickSide: 0.4,
    recoilRecovery: 6.5,
    adsFov: 14,
    scoped: true,
    hitRange: 320,
    switchTime: 0.55,
  },
};

export const WEAPON_ORDER = ['sidearm', 'rifle', 'marksman'];

/**
 * Zombie archetypes. Difficulty comes from variety, pressure and behaviour —
 * not from raw stat inflation (see ZOMBIES.difficulty).
 */
export const ZOMBIE_TYPES = {
  walker: {
    id: 'walker',
    label: 'WALKER',
    health: 60,
    speed: 1.7,
    sprintSpeed: 2.6,
    damage: 9,
    attackRange: 1.7,
    attackWindup: 0.45,
    attackCooldown: 1.35,
    viewRange: 26,
    fovDeg: 130,
    acquireTime: 0.9,
    hearing: 1.0,
    aggression: 0.5,
    poise: 18,
    scale: 1.0,
    coins: [7, 13],
    weight: { base: 58, night: 44 },
    colors: { skin: 0x76806a, cloth: 0x3c3a33, eyes: 0xd8c24a },
  },
  runner: {
    id: 'runner',
    label: 'RUNNER',
    health: 42,
    speed: 4.6,
    sprintSpeed: 6.4,
    damage: 11,
    attackRange: 1.8,
    attackWindup: 0.32,
    attackCooldown: 1.05,
    viewRange: 38,
    fovDeg: 150,
    acquireTime: 0.45,
    hearing: 1.25,
    aggression: 1.0,
    poise: 10,
    scale: 0.94,
    coins: [13, 22],
    weight: { base: 16, night: 24 },
    colors: { skin: 0x8a8262, cloth: 0x4a3226, eyes: 0xff5a3c },
  },
  brute: {
    id: 'brute',
    label: 'BRUTE',
    health: 320,
    speed: 1.25,
    sprintSpeed: 1.8,
    damage: 32,
    attackRange: 2.2,
    attackWindup: 0.75,
    attackCooldown: 1.9,
    viewRange: 22,
    fovDeg: 110,
    acquireTime: 1.2,
    hearing: 0.85,
    aggression: 0.85,
    poise: 60,
    scale: 1.32,
    coins: [38, 62],
    weight: { base: 6, night: 9 },
    colors: { skin: 0x6d7a58, cloth: 0x2f3330, eyes: 0xffb03c },
  },
  crawler: {
    id: 'crawler',
    label: 'CRAWLER',
    health: 34,
    speed: 2.9,
    sprintSpeed: 4.4,
    damage: 14,
    attackRange: 1.5,
    attackWindup: 0.26,
    attackCooldown: 0.95,
    viewRange: 20,
    fovDeg: 200,
    acquireTime: 0.35,
    hearing: 1.35,
    aggression: 0.9,
    poise: 6,
    scale: 1.0,
    coins: [10, 18],
    weight: { base: 9, night: 16 },
    colors: { skin: 0x7e7468, cloth: 0x33302b, eyes: 0x9fdc4a },
  },
  screamer: {
    id: 'screamer',
    label: 'SCREAMER',
    health: 90,
    speed: 2.6,
    sprintSpeed: 3.6,
    damage: 13,
    attackRange: 1.7,
    attackWindup: 0.4,
    attackCooldown: 1.2,
    viewRange: 44,
    fovDeg: 170,
    acquireTime: 0.6,
    hearing: 1.6,
    aggression: 0.7,
    poise: 22,
    scale: 1.02,
    coins: [42, 75],
    weight: { base: 4, night: 7 },
    colors: { skin: 0x9aa08c, cloth: 0x40342e, eyes: 0xff3c64 },
  },
};

export const ZOMBIES = {
  /** Hard cap of simultaneously simulated zombies (pool size). */
  maxActive: 26,
  /** Population floor / base + growth per difficulty level. */
  minPopulation: 3,
  basePopulation: 4.5,
  populationPerDifficulty: 1.5,
  /** Corpses stay for this long before sinking away. */
  corpseTTL: 9,
  /** Spawn annulus around the player, in metres. */
  spawnNear: 46,
  spawnFar: 88,
  /** Despawn silently beyond this distance (unless still spawning in). */
  despawn: 135,
  /** Zombies never spawn inside this radius of a tower. */
  towerExclusion: 24,
  /** How often the spawner evaluates the population (seconds). */
  spawnTick: 1.4,
  /**
   * Difficulty level 1..10 from distance travelled, time survived, kills and
   * night. Drives population + type mix + a mild HP scale — behaviour first.
   */
  difficultyDistScale: 420,
  difficultyTimeScale: 260,
  difficultyKillScale: 0.045,
  hpScalePerLevel: 0.055,
  hpScaleMax: 1.55,
  nightPopulation: 1.45,
  nightViewMul: 0.72,
  /** Gunshot noise radius in metres (runners hear further via hearing). */
  noiseGunshot: 105,
  noiseSprintStep: 26,
  noiseWalkStep: 10,
  noiseCrateLand: 85,
  noiseScream: 80,
  noiseTowerClank: 42,
};

export const ECONOMY = {
  startingCoins: 0,
  nightCoinBonus: 1.25,
  headshotCoinBonus: 1.3,
  crates: {
    basic: {
      id: 'basic',
      label: 'BASIC SUPPLY DROP',
      cost: 60,
      desc: 'Ammunition and a chance of small medical supplies.',
      rolls: [
        { item: 'ammo', amount: [60, 90], chance: 1 },
        { item: 'medkit', amount: [20, 40], chance: 0.45 },
        { item: 'coins', amount: [10, 25], chance: 0.35 },
      ],
    },
    medical: {
      id: 'medical',
      label: 'MEDICAL SUPPLY DROP',
      cost: 95,
      desc: 'Field trauma kit: guaranteed healing plus bandages.',
      rolls: [
        { item: 'medkit', amount: [45, 70], chance: 1 },
        { item: 'bandage', amount: [20, 30], chance: 1 },
        { item: 'ammo', amount: [24, 48], chance: 0.7 },
        { item: 'coins', amount: [5, 18], chance: 0.3 },
      ],
    },
    weapon: {
      id: 'weapon',
      label: 'WEAPON SUPPLY DROP',
      cost: 150,
      desc: 'Heavy ammunition cans and rare weapon-grade loot.',
      rolls: [
        { item: 'ammo', amount: [120, 180], chance: 1 },
        { item: 'ammoBig', amount: [30, 60], chance: 0.6 },
        { item: 'medkit', amount: [25, 50], chance: 0.5 },
        { item: 'coins', amount: [20, 45], chance: 0.4 },
      ],
    },
    premium: {
      id: 'premium',
      label: 'PREMIUM SUPPLY DROP',
      cost: 240,
      desc: 'Everything the quartermaster has: full spectrum resupply.',
      rolls: [
        { item: 'ammo', amount: [150, 210], chance: 1 },
        { item: 'medkit', amount: [60, 100], chance: 1 },
        { item: 'coins', amount: [40, 90], chance: 0.85 },
        { item: 'ammoBig', amount: [40, 80], chance: 0.8 },
      ],
    },
  },
  /** World scatter pickups. */
  medkitHeal: 50,
  bandageHeal: 22,
  ammoPickup: [40, 70],
  coinPickup: [12, 30],
};

export const DAYNIGHT = {
  /** Full day cycle length in seconds (dawn → night → dawn). */
  dayLength: 480,
  /** Run starts at this phase (early morning). */
  startPhase: 0.12,
  /** Killing night: population + senses scale (see ZOMBIES). */
  phases: [
    { t: 0.0, name: 'DAWN' },
    { t: 0.08, name: 'MORNING' },
    { t: 0.22, name: 'MIDDAY' },
    { t: 0.38, name: 'AFTERNOON' },
    { t: 0.48, name: 'EVENING' },
    { t: 0.55, name: 'SUNSET' },
    { t: 0.62, name: 'DUSK' },
    { t: 0.72, name: 'NIGHT' },
    { t: 0.94, name: 'LATE NIGHT' },
  ],
  isNight: (t) => t > 0.6 && t < 0.97,
};

export const WEATHER = {
  /** Weather may re-roll every [min, max] seconds. */
  rerollInterval: [110, 240],
  transitionTime: 10,
  states: {
    CLEAR: { fogNear: 90, fogFar: 250, dim: 1.0, rain: 0, cloud: 0.15 },
    CLOUDY: { fogNear: 70, fogFar: 210, dim: 0.82, rain: 0, cloud: 0.55 },
    FOG: { fogNear: 26, fogFar: 130, dim: 0.78, rain: 0, cloud: 0.5 },
    HEAVY_FOG: { fogNear: 12, fogFar: 78, dim: 0.7, rain: 0, cloud: 0.6 },
    RAIN: { fogNear: 44, fogFar: 170, dim: 0.66, rain: 0.7, cloud: 0.8 },
    STORM: { fogNear: 32, fogFar: 140, dim: 0.52, rain: 1, cloud: 1 },
  },
  /** Transition matrix — weather prefers to stay in family. */
  chances: {
    CLEAR: { CLEAR: 0.4, CLOUDY: 0.3, FOG: 0.15, HEAVY_FOG: 0, RAIN: 0.1, STORM: 0.05 },
    CLOUDY: { CLEAR: 0.25, CLOUDY: 0.25, FOG: 0.15, HEAVY_FOG: 0.05, RAIN: 0.2, STORM: 0.1 },
    FOG: { CLEAR: 0.2, CLOUDY: 0.25, FOG: 0.3, HEAVY_FOG: 0.15, RAIN: 0.1, STORM: 0 },
    HEAVY_FOG: { CLEAR: 0.1, CLOUDY: 0.2, FOG: 0.4, HEAVY_FOG: 0.25, RAIN: 0.05, STORM: 0 },
    RAIN: { CLEAR: 0.1, CLOUDY: 0.25, FOG: 0.1, HEAVY_FOG: 0, RAIN: 0.35, STORM: 0.2 },
    STORM: { CLEAR: 0.05, CLOUDY: 0.15, FOG: 0.05, HEAVY_FOG: 0, RAIN: 0.45, STORM: 0.3 },
  },
  /** Lightning strike cadence in a storm (seconds). */
  lightningInterval: [4, 13],
};

export const EVENTS = {
  /** World event roll cadence (seconds). */
  interval: [100, 210],
  weights: { horde: 0.4, surge: 0.16, signal: 0.2, elite: 0.24 },
  hordeSize: [6, 11],
  eliteGuard: [2, 4],
};

export const TOWERS = {
  /** Player is "in the tower" while above this height over its base. */
  platformHeight: 6.4,
  platformHalf: 3.1,
  enterRadius: 4.5,
  exitRadius: 4.8,
  /** Climb/descend transition duration (seconds). */
  transitionTime: 1.05,
  /** Zombies give up milling at the base after this long (seconds). */
  zombiePatience: 26,
  /** Slow health regeneration while standing in the safe zone (HP/s). */
  regenPerSecond: 4,
};

export const FX = {
  maxParticles: 1500,
  maxTracers: 48,
  maxShells: 26,
  maxDecals: 56,
  maxBloodDecals: 40,
  /** Particles are simulated only inside this radius (cheap LOD). */
  simulateRadius: 70,
  rainDrops: 420,
};

export const RENDER = {
  maxPixelRatio: 1.75,
  shadowMapSize: 1024,
  /** Props beyond this distance stop casting shadows. */
  shadowCasterRange: 46,
  /** Seconds between visibility / LOD bookkeeping passes. */
  cullInterval: 0.14,
  farClip: 620,
  fogNear: 90,
  fogFar: 250,
};

export const AUDIO = {
  master: 0.9,
  /** Number of pooled positional PannerNodes. */
  pannerPool: 16,
  /** Reference distance for the HRTF-ish panners. */
  refDistance: 8,
  maxDistance: 190,
  rolloff: 1.15,
  /** Gunshots farther than this are attenuated extra hard. */
  farFallback: 60,
};
