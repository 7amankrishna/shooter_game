/**
 * Difficulty presets for the AI combat machine.
 *
 * HARD is tuned through *decision quality*, not aimbot accuracy: the machine
 * keeps a reaction delay, its own recoil, reloads, runs out of ammo and misses
 * — it simply picks better angles, uses cover more, and reads the player.
 */

const BASE = {
  // --- perception -------------------------------------------------------
  viewRange: 70,
  fovDeg: 100,
  /** Seconds inside FOV+LOS before the machine registers the player. */
  acquireTime: 0.2,
  /** Seconds of lost contact before it stops tracking (and starts searching). */
  loseTime: 1.6,
  hearingRadius: 60,
  // --- gunplay ------------------------------------------------------------
  /** Randomised min..max delay before it answers observed player actions. */
  reaction: [0.5, 0.8],
  /** Cone half-angle (degrees) applied on top of prediction error. */
  aimErrorDeg: 0.95,
  /** Extra error while the player is strafing fast. */
  trackingErrorDeg: 0.5,
  /** 0..1 — how much it leads the player's velocity. */
  prediction: 0.35,
  /** Chance to deliberately throw a shot (fairness valve). */
  intentionalMiss: 0.1,
  burstShots: [2, 4],
  burstGap: [0.16, 0.26],
  burstPause: [0.5, 0.95],
  magSize: 30,
  reloadTime: 2.9,
  damagePerShot: 9,
  fireRange: 78,
  /** The band it tries to hold when it can choose its angle: [min, max] metres. */
  preferredRange: [10, 24],
  /** It will not start firing when further out than this. */
  /** Trigger discipline: how still the gun must be before it commits to a
   * burst. 1.0 = waits for a perfect settle (very accurate), 0 = hammers away
   * while still slewing. This, not raw aim skill, is most of the spread. */
  minFireAccuracy: 0.42,
  // --- movement / tactics -------------------------------------------------
  moveSpeed: 3.5,
  sprintSpeed: 6.0,
  strafeSpeed: 2.6,
  aggression: 0.55,
  coverChance: 0.6,
  coverRange: [6, 30],
  repositionInterval: 6.0,
  flankChance: 0.3,
  retreatHealthFrac: 0.22,
  searchIntensity: 0.6,
  /** Seconds it is willing to stay exposed while firing. */
  exposureBudget: 4.2,
  jumpChance: 0.0,
};

export const DIFFICULTIES = {
  EASY: {
    ...BASE,
    key: 'EASY',
    title: 'RECRUIT',
    blurb:
      'Slow to react, poor grouping, reloads in the open and forgets to check corners. Learn the rifle here.',
    tagline: 'Forgiving — the machine hesitates and misses on purpose.',
    viewRange: 42,
    fovDeg: 75,
    acquireTime: 0.55,
    loseTime: 0.9,
    hearingRadius: 34,
    reaction: [1.0, 1.5],
    aimErrorDeg: 3.2,
    trackingErrorDeg: 2.4,
    minFireAccuracy: 0.22,
    prediction: 0.0,
    intentionalMiss: 0.28,
    burstShots: [1, 2],
    burstGap: [0.24, 0.4],
    burstPause: [1.15, 1.9],
    magSize: 20,
    reloadTime: 3.6,
    damagePerShot: 6,
    fireRange: 46,
    preferredRange: [8, 17],
    moveSpeed: 2.3,
    sprintSpeed: 4.2,
    strafeSpeed: 1.4,
    aggression: 0.28,
    coverChance: 0.18,
    coverRange: [4, 16],
    repositionInterval: 11,
    flankChance: 0.04,
    retreatHealthFrac: 0.0,
    searchIntensity: 0.25,
    exposureBudget: 7.5,
  },
  MEDIUM: {
    ...BASE,
    key: 'MEDIUM',
    title: 'OPERATOR',
    blurb:
      'Balanced: uses cover, repositions between bursts, reloads behind walls and flanks when you get lazy.',
    tagline: 'Fair fight — punish its reposition windows.',
  },
  HARD: {
    ...BASE,
    key: 'HARD',
    title: 'WRAITH',
    blurb:
      'Fast reads, tight groups, constant repositioning, leads your movement and hunts you down the second you break line of sight.',
    tagline: 'Still human — it misses, reloads and takes angles like a player.',
    viewRange: 96,
    fovDeg: 128,
    acquireTime: 0.1,
    loseTime: 2.6,
    hearingRadius: 92,
    reaction: [0.22, 0.42],
    // 1.05° at 25 m is ~0.46 m of group — about one body width. Lethal, reads
    // as a very good human, and still lets you break contact.
    aimErrorDeg: 0.55,
    trackingErrorDeg: 0.35,
    prediction: 0.7,
    intentionalMiss: 0.07,
    burstShots: [3, 5],
    burstGap: [0.1, 0.16],
    burstPause: [0.34, 0.6],
    magSize: 30,
    reloadTime: 2.5,
    damagePerShot: 9.5,
    fireRange: 105,
    preferredRange: [12, 30],
    minFireAccuracy: 0.82,
    moveSpeed: 4.2,
    sprintSpeed: 7.4,
    strafeSpeed: 3.4,
    aggression: 0.85,
    coverChance: 0.85,
    coverRange: [6, 42],
    repositionInterval: 3.6,
    flankChance: 0.55,
    retreatHealthFrac: 0.14,
    searchIntensity: 0.95,
    exposureBudget: 2.6,
    jumpChance: 0.12,
  },
};

export const DIFFICULTY_ORDER = ['EASY', 'MEDIUM', 'HARD'];

export function getDifficulty(key) {
  return DIFFICULTIES[key] ?? DIFFICULTIES.MEDIUM;
}
