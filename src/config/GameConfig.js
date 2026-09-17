/**
 * BLACKLINE // ARENA — central tuning file.
 *
 * Every gameplay number the designer would touch lives here so that the
 * systems (player, weapon, scoring, damage) stay decoupled and easy to expand.
 */

export const WORLD = {
  /** Half-extent of the playable arena in metres. */
  bounds: 108,
  /** Size of the generated terrain mesh. */
  terrainSize: 260,
  terrainSegments: 128,
  gravity: -24,
  /** Fixed-timestep simulation rate used by the deterministic sim harness. */
  tickRate: 60,
  maxSubSteps: 5,
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
  /** Mouse sensitivity multipliers. */
  hipSensitivity: 1.0,
  adsSensitivity: 0.42,
  sprintSensitivity: 1.12,
  /** Camera feel. */
  baseFov: 76,
  adsFov: 30,
  scopeFov: 12,
  sprintFovBoost: 8,
  bobFrequency: 8.6,
  bobAmount: 0.055,
  landingDip: 0.16,
};

export const WEAPON = {
  name: 'AK-01',
  magSize: 30,
  reserveStart: 120,
  reserveMax: 240,
  /** Rounds per minute. */
  rpm: 640,
  reloadTime: 2.35,
  /** Tactical (retained magazine) reload is faster. */
  tacticalReloadTime: 1.65,
  emptyClickDelay: 0.22,
  /** Automatic after this many ms of held trigger with 2+ rounds. */
  autoFire: true,
  /** Base spread in degrees. */
  hipSpread: 2.6,
  adsSpread: 0.22,
  /** Spread growth per consecutive shot, in degrees. */
  spreadBloomPerShot: 0.28,
  spreadRecoveryPerSecond: 3.1,
  /** Vertical / horizontal recoil impulses, in degrees. */
  recoilKickUp: 0.85,
  recoilKickSide: 0.24,
  recoilRecovery: 9.5,
  /** Damage per bullet on the player (AI uses this too). */
  projectileSpeed: 420,
  tracerEvery: 1,
  maxRange: 300,
  /** Headless ray-march distance for the hitscan projectile. */
  hitRange: 260,
};

/**
 * Body-region table. Score and damage are intentionally separate columns so a
 * headshot can be worth a lot of points while remaining lethal.
 */
export const BODY = {
  head: { label: 'HEADSHOT', points: 100, damage: 100, multiplier: 1.5, hitColor: 0xffc93c },
  chest: { label: 'BODY HIT', points: 50, damage: 40, multiplier: 1.0, hitColor: 0xffffff },
  lower: { label: 'BELT HIT', points: 40, damage: 30, multiplier: 1.0, hitColor: 0xdddddd },
  arm: { label: 'ARM HIT', points: 25, damage: 20, multiplier: 1.0, hitColor: 0x9fd8ff },
  leg: { label: 'LEG HIT', points: 20, damage: 15, multiplier: 1.0, hitColor: 0x9fd8ff },
  graze: { label: 'GRAZE', points: 10, damage: 5, multiplier: 1.0, hitColor: 0x8ab4ff },
};

export const SCORING = {
  /** Multiplier tiers keyed by hit-streak length. */
  comboTiers: [
    { streak: 2, multiplier: 1.5, label: '2 HIT COMBO' },
    { streak: 4, multiplier: 2.0, label: '3+ HIT COMBO' },
    { streak: 7, multiplier: 2.5, label: '7 HIT COMBO' },
    { streak: 11, multiplier: 3.0, label: 'ON FIRE' },
  ],
  /** A miss only breaks the streak if no hit lands within this window (seconds). */
  comboGrace: 3.2,
  headshotStreakBonus: 50,
  accuracyBonusStep: 50,
  accuracyBonusThreshold: 0.7,
  accuracyBonusMinShots: 8,
  killBonus: 250,
  headshotKillBonus: 150,
  /** Points per second saved on a fast win (0 after the cap). */
  speedBonusPerSecond: 4,
  speedBonusCapSeconds: 240,
};

export const AI = {
  health: 100,
  radius: 0.46,
  height: 1.86,
  eyeHeight: 1.62,
  damagePerShot: 9,
  /** Distance the machine keeps from the player while trading fire. */
  preferredRange: [10, 26],
  gravity: WORLD.gravity,
  stepHeight: 0.62,
  aimHeightChest: 1.22,
  aimHeightHead: 1.6,
};

export const FX = {
  maxParticles: 1400,
  maxTracers: 48,
  maxShells: 26,
  maxFlashes: 4,
  maxDecals: 40,
  /** Particles are simulated only inside this radius (cheap LOD). */
  simulateRadius: 70,
};

export const RENDER = {
  maxPixelRatio: 1.75,
  shadowMapSize: 1024,
  /** Props beyond this distance stop casting shadows. */
  shadowCasterRange: 46,
  /** Instanced props are culled entirely past this distance. */
  instanceFarRange: 118,
  /** Distance at which small props swap to their low-poly sibling. */
  lodNearRange: 26,
  lodFarRange: 60,
  /** Seconds between visibility / LOD bookkeeping passes. */
  cullInterval: 0.14,
  fogNear: 60,
  fogFar: 300,
  farClip: 620,
};

export const AUDIO = {
  master: 0.9,
  /** Number of pooled positional PannerNodes. */
  pannerPool: 14,
  /** Reference distance for the HRTF-ish panners. */
  refDistance: 8,
  maxDistance: 190,
  rolloff: 1.15,
  /** Gunshots farther than this are attenuated extra hard. */
  farFallback: 60,
};
