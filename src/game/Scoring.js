/**
 * Scoring — body-part points, streak multipliers and the match ledger.
 *
 * Kept deliberately shallow (as specified): one streak counter drives the
 * multiplier, headshot streaks add a bonus tier, accuracy pays a flat bonus,
 * and a miss only kills the combo if no hit lands within the grace window.
 */
import { BODY, SCORING } from '../config/GameConfig.js';
import { clamp } from '../core/math.js';

export class Scoring {
  constructor() {
    this.reset();
  }

  reset() {
    this.score = 0;
    this.hits = 0;
    this.misses = 0;
    this.shots = 0;
    this.headshots = 0;
    this.grazes = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.headStreak = 0;
    this.multiplier = 1;
    this.comboLabel = '';
    this.graceTimer = 0;
    this.killBonus = 0;
    this.speedBonus = 0;
    this.accuracyBonusAwarded = 0;
    this.events = [];
  }

  get accuracy() {
    return this.shots > 0 ? this.hits / this.shots : 0;
  }

  #recomputeMultiplier() {
    let mult = 1;
    let label = '';
    for (const tier of SCORING.comboTiers) {
      if (this.streak >= tier.streak) {
        mult = tier.multiplier;
        label = tier.label.replace(/^(\d+)\+? HIT COMBO/, `${this.streak} HIT COMBO`);
      }
    }
    if (this.streak > 1 && !label) label = `${this.streak} HIT COMBO`;
    this.multiplier = mult;
    this.comboLabel = mult > 1 ? label : '';
  }

  /**
   * @param {string} region one of the BODY keys
   * @param {number} basePoints points carried by the hit test
   */
  registerHit(region, basePoints = BODY[region]?.points ?? 10) {
    const def = BODY[region] ?? BODY.graze;
    this.hits++;
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.graceTimer = 0;
    const isHead = region === 'head';
    if (isHead) {
      this.headshots++;
      this.headStreak++;
    } else if (region === 'graze') {
      this.grazes++;
      this.headStreak = 0;
    } else {
      this.headStreak = 0;
    }
    this.#recomputeMultiplier();

    const lines = [];
    const base = Math.round(basePoints * this.multiplier);
    let total = base;
    lines.push({ text: `+${base} ${def.label}`, kind: isHead ? 'headshot' : region === 'graze' ? 'graze' : 'hit', emphasize: isHead });

    if (this.multiplier > 1) {
      lines.push({ text: `${this.streak} HIT COMBO  ×${this.multiplier}`, kind: 'combo' });
    }
    if (isHead) {
      const headBonus = Math.round(SCORING.headshotStreakBonus * clamp(this.headStreak - 1, 0, 3) * 0.5);
      if (headBonus > 0) {
        total += headBonus;
        lines.push({ text: `+${headBonus} HEADSHOT STREAK ×${this.headStreak}`, kind: 'bonus' });
      }
    }
    const accBonus = this.#maybeAccuracyBonus();
    if (accBonus > 0) lines.push({ text: `+${accBonus} ACCURACY BONUS`, kind: 'bonus' });
    total += accBonus;

    this.score += total;
    const event = { region, points: total, lines, streak: this.streak, multiplier: this.multiplier, headshot: isHead };
    this.events.push(event);
    return event;
  }

  registerMiss() {
    this.misses++;
    // the streak survives until the grace window runs out (see update())
    if (this.streak > 0 && this.graceTimer <= 0) this.graceTimer = SCORING.comboGrace;
  }

  registerShot() {
    this.shots++;
  }

  #maybeAccuracyBonus() {
    if (this.shots < SCORING.accuracyBonusMinShots) return 0;
    const acc = this.accuracy;
    if (acc < SCORING.accuracyBonusThreshold) return 0;
    // one bonus per 5% band above the threshold, so it rewards sustained play
    const band = Math.floor(((acc - SCORING.accuracyBonusThreshold) / 0.05) + 1e-6);
    if (band <= this.accuracyBonusAwarded) return 0;
    this.accuracyBonusAwarded = band;
    return SCORING.accuracyBonusStep * band;
  }

  applyKill({ headshotKill = false, elapsedSeconds = 0 } = {}) {
    let bonus = SCORING.killBonus;
    if (headshotKill) bonus += SCORING.headshotKillBonus;
    const speed = Math.max(0, SCORING.speedBonusCapSeconds - elapsedSeconds) * SCORING.speedBonusPerSecond;
    this.killBonus = bonus;
    this.speedBonus = Math.round(speed);
    this.score += bonus + this.speedBonus;
    const lines = [{ text: `+${bonus} TARGET NEUTRALISED`, kind: 'kill' }];
    if (this.speedBonus > 0) lines.push({ text: `+${this.speedBonus} SPEED BONUS`, kind: 'bonus' });
    return { points: bonus + this.speedBonus, lines };
  }

  update(dt) {
    if (this.graceTimer > 0) {
      this.graceTimer -= dt;
      if (this.graceTimer <= 0) {
        this.graceTimer = 0;
        if (this.streak > 0) {
          this.streak = 0;
          this.#recomputeMultiplier();
        }
      }
    }
  }

  /** Everything the results screen needs. */
  summary(elapsedSeconds, outcome) {
    return {
      outcome,
      score: Math.round(this.score),
      hits: this.hits,
      misses: this.misses,
      shots: this.shots,
      headshots: this.headshots,
      grazes: this.grazes,
      accuracy: this.accuracy,
      bestStreak: this.bestStreak,
      killBonus: this.killBonus,
      speedBonus: this.speedBonus,
      elapsed: elapsedSeconds,
    };
  }
}
