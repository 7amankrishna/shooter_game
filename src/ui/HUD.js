/**
 * HUD — the survival overlay.
 *
 * DOM-based (crisp text at any DPI, no second render pass), updated from one
 * snapshot per frame with dirty-field checks so nothing thrashes layout.
 * Layout: vitals bottom-left, weapon bottom-right, status top-left, coins
 * top-right, compass strip top-centre, prompt + notifications mid-screen,
 * with the buy menu, dev panel and death screen as full overlays.
 */
import { clamp } from '../core/math.js';

const NOTE_TTL = 3.2;
const MAX_NOTES = 5;

export class HUD {
  constructor({ root, camera }) {
    this.root = root;
    this.camera = camera;
    this._cache = {};
    this._notes = [];
    this._bannerT = 0;
    this._hitT = 0;
    this._hurtT = 0;
    this._prompt = '';
    this._buyOpen = false;
    this._adminOpen = false;
    this._deathOpen = false;
    this._build();
  }

  #el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  #set(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  _build() {
    const R = this.root;
    R.innerHTML = '';

    // ---- full-screen effects
    this.#el('div', 'vignette', R);
    this.hurtEl = this.#el('div', 'hurt-overlay', R);
    this.lowhpEl = this.#el('div', 'lowhp-overlay', R);
    this.nightEl = this.#el('div', 'night-overlay', R);

    // ---- crosshair + hitmarker
    this.crosshair = this.#el('div', 'crosshair', R);
    for (const side of ['n', 's', 'e', 'w']) this.#el('span', `ch-${side}`, this.crosshair);
    this.hitmarkerEl = this.#el('div', 'hitmarker', R);
    for (const side of ['a', 'b', 'c', 'd']) this.#el('span', `hm-${side}`, this.hitmarkerEl);

    // ---- top status
    const status = this.#el('div', 'hud-block hud-status', R);
    this.clockEl = this.#el('div', 'hud-clock', status, '08:22');
    this.phaseEl = this.#el('div', 'hud-phase', status, 'MORNING');
    const meta = this.#el('div', 'hud-meta', status);
    this.weatherEl = this.#el('span', 'hud-weather', meta, 'CLEAR');
    this.diffEl = this.#el('span', 'hud-diff', meta, 'THREAT 1.0');
    this.killsEl = this.#el('span', 'hud-kills', meta, 'KILLS 0');

    // ---- compass strip
    this.compass = this.#el('div', 'hud-compass', R);
    this.compassTrack = this.#el('div', 'compass-track', this.compass);
    this.compassMarks = this.#el('div', 'compass-marks', this.compass);

    // ---- coins (top right)
    const coins = this.#el('div', 'hud-block hud-coins', R);
    this.coinsEl = this.#el('span', 'coin-count', coins, '0');
    this.#el('span', 'coin-label', coins, 'COINS');

    // ---- banner (top centre, under compass)
    this.bannerEl = this.#el('div', 'hud-banner', R);

    // ---- vitals (bottom left)
    const vitals = this.#el('div', 'hud-block hud-vitals', R);
    const hpRow = this.#el('div', 'vital-row', vitals);
    this.#el('span', 'vital-label', hpRow, 'HEALTH');
    this.hpNum = this.#el('span', 'vital-num', hpRow, '100');
    this.hpBar = this.#el('div', 'bar hp-bar', hpRow);
    this.hpFill = this.#el('div', 'bar-fill hp-fill', this.hpBar);
    const stRow = this.#el('div', 'vital-row', vitals);
    this.#el('span', 'vital-label', stRow, 'STAMINA');
    this.stBar = this.#el('div', 'bar stam-bar', stRow);
    this.stFill = this.#el('div', 'bar-fill stam-fill', this.stBar);
    this.safeZoneEl = this.#el('div', 'safe-zone', vitals, 'SAFE ZONE');

    // ---- weapon (bottom right)
    const weapon = this.#el('div', 'hud-block hud-weapon', R);
    this.weaponNameEl = this.#el('div', 'weapon-name', weapon, 'AK-01 CARBINE');
    this.ammoEl = this.#el('div', 'ammo-label', weapon, '30 / 120');
    this.slotsEl = this.#el('div', 'weapon-slots', weapon);

    // ---- prompt (mid-lower centre)
    this.promptEl = this.#el('div', 'hud-prompt', R);

    // ---- notifications (right side, above weapon)
    this.notesEl = this.#el('div', 'hud-notes', R);

    // ---- buy menu overlay
    this.buyMenu = this.#el('div', 'overlay buy-menu hidden', R);
    this.buyTitle = this.#el('div', 'buy-title', this.buyMenu, 'FIELD QUARTERMASTER');
    this.buyCoins = this.#el('div', 'buy-coins', this.buyMenu, '0 COINS');
    this.buyList = this.#el('div', 'buy-list', this.buyMenu);
    this.#el('div', 'buy-hint', this.buyMenu, '1–4 PURCHASE  ·  B CLOSE');

    // ---- admin/dev panel (F6)
    this.adminPanel = this.#el('div', 'overlay admin-panel hidden', R);
    this.#el('div', 'admin-title', this.adminPanel, 'DEV PANEL — F6');
    this.adminBody = this.#el('div', 'admin-body', this.adminPanel);

    // ---- death screen
    this.deathEl = this.#el('div', 'overlay death-screen hidden', R);
    this.#el('div', 'death-title', this.deathEl, 'YOU DIED');
    this.deathStats = this.#el('div', 'death-stats', this.deathEl);
    this.deathHint = this.#el('div', 'death-hint', this.deathEl, 'PRESS ENTER TO TRY AGAIN');
  }

  /* ------------------------------------------------------------- events */

  prompt(text) {
    if (text === this._prompt) return;
    this._prompt = text;
    this.promptEl.textContent = text;
    this.promptEl.classList.toggle('visible', !!text);
  }

  notify(text) {
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = text;
    this.notesEl.appendChild(el);
    this._notes.push({ el, life: NOTE_TTL });
    while (this._notes.length > MAX_NOTES) {
      const old = this._notes.shift();
      old.el.remove();
    }
  }

  banner(text, duration = 2.2) {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.add('visible');
    this._bannerT = duration;
  }

  hitmarker(headshot = false) {
    this._hitT = 0.24;
    this.hitmarkerEl.classList.toggle('headshot', !!headshot);
  }

  damage(intensity = 1) {
    this._hurtT = Math.max(this._hurtT, 0.5 + intensity * 0.4);
  }

  /* --------------------------------------------------------- overlays */

  setBuyMenu(open, crates, coins) {
    this._buyOpen = open;
    this.buyMenu.classList.toggle('hidden', !open);
    if (open) {
      this.buyCoins.textContent = `${coins} COINS`;
      this.buyList.innerHTML = '';
      const order = ['basic', 'medical', 'weapon', 'premium'];
      order.forEach((key, i) => {
        const c = crates[key];
        if (!c) return;
        const row = this.#el('div', 'buy-row', this.buyList);
        row.dataset.tier = key;
        this.#el('span', 'buy-key', row, String(i + 1));
        const mid = this.#el('div', 'buy-mid', row);
        this.#el('div', 'buy-name', mid, c.label);
        this.#el('div', 'buy-desc', mid, c.desc);
        this.#el('span', 'buy-cost', row, `${c.cost} COINS`);
        row.classList.toggle('unaffordable', coins < c.cost);
      });
    }
  }

  setAdminPanel(open, { time, weather, difficulty } = {}) {
    this._adminOpen = open;
    this.adminPanel.classList.toggle('hidden', !open);
    if (!open) return;
    const body = this.adminBody;
    body.innerHTML = '';
    const info = this.#el('div', 'admin-row', body);
    this.#el('span', '', info, `THREAT ${Number(difficulty ?? 1).toFixed(1)}`);
    // time slider
    const timeRow = this.#el('div', 'admin-row', body);
    this.#el('span', 'admin-label', timeRow, 'TIME OF DAY');
    const slider = this.#el('input', 'admin-slider', timeRow);
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = String(time ?? 0.12);
    slider.dataset.cmd = 'time';
    // weather buttons
    const wRow = this.#el('div', 'admin-row', body);
    this.#el('span', 'admin-label', wRow, 'WEATHER');
    for (const w of ['CLEAR', 'CLOUDY', 'FOG', 'HEAVY_FOG', 'RAIN', 'STORM']) {
      const b = this.#el('button', `admin-btn${weather === w ? ' active' : ''}`, wRow, w);
      b.dataset.cmd = 'weather';
      b.dataset.value = w;
    }
    const unpin = this.#el('button', 'admin-btn', body, 'RESUME NATURAL CYCLE');
    unpin.dataset.cmd = 'unpin';
  }

  showDeath(stats) {
    this._deathOpen = true;
    this.deathEl.classList.remove('hidden');
    this.deathStats.innerHTML = '';
    const rows = [
      ['SURVIVED', stats.time],
      ['KILLS', stats.kills],
      ['HEADSHOTS', stats.headshots],
      ['ACCURACY', `${stats.accuracy}%`],
      ['DISTANCE', `${stats.distance} m`],
      ['COINS EARNED', stats.coinsEarned],
      ['FINAL THREAT', stats.difficulty],
    ];
    for (const [k, v] of rows) {
      const r = this.#el('div', 'death-row', this.deathStats);
      this.#el('span', 'death-k', r, k);
      this.#el('span', 'death-v', r, String(v));
    }
    if (stats.killsByType) {
      const brk = this.#el('div', 'death-breakdown', this.deathStats);
      for (const [type, n] of Object.entries(stats.killsByType)) {
        if (n > 0) this.#el('span', 'death-tag', brk, `${type.toUpperCase()} ×${n}`);
      }
    }
  }

  hideDeath() {
    this._deathOpen = false;
    this.deathEl.classList.add('hidden');
  }

  hideOverlays() {
    this.setBuyMenu(false);
    this.setAdminPanel(false);
    this.prompt('');
  }

  /* ------------------------------------------------------------ update */

  update(s, force = false) {
    const c = this._cache;
    const set = (el, v) => this.#set(el, String(v));

    if (force || c.health !== s.health) {
      c.health = s.health;
      set(this.hpNum, s.health);
      const pct = clamp(s.health / s.maxHealth, 0, 1) * 100;
      this.hpFill.style.width = `${pct}%`;
      this.hpFill.classList.toggle('critical', pct < 30);
    }
    if (force || c.stamina !== s.stamina) {
      c.stamina = s.stamina;
      this.stFill.style.width = `${clamp(s.stamina, 0, 100)}%`;
    }
    if (force || c.ammo !== s.ammoLabel) {
      c.ammo = s.ammoLabel;
      set(this.ammoEl, s.ammoLabel);
      this.ammoEl.classList.toggle('low', /RELOAD|NO AMMO/.test(s.ammoLabel));
    }
    if (force || c.weapon !== s.weaponName) {
      c.weapon = s.weaponName;
      set(this.weaponNameEl, s.weaponName);
    }
    if (force || c.slots !== s.weaponSlots) {
      c.slots = s.weaponSlots;
      this.slotsEl.innerHTML = '';
      for (const w of s.weaponSlots ?? []) {
        const el = this.#el('span', `slot${w.active ? ' active' : ''}`, this.slotsEl, `${w.key} ${w.name}`);
        void el;
      }
    }
    if (force || c.coins !== s.coins) {
      c.coins = s.coins;
      set(this.coinsEl, s.coins);
    }
    if (force || c.clock !== s.clock) {
      c.clock = s.clock;
      set(this.clockEl, s.clock);
    }
    if (force || c.phase !== s.phase) {
      c.phase = s.phase;
      set(this.phaseEl, s.phase);
      this.phaseEl.classList.toggle('night', !!s.isNight);
    }
    if (force || c.weather !== s.weather || c.diff !== s.difficulty || c.kills !== s.kills) {
      c.weather = s.weather;
      c.diff = s.difficulty;
      c.kills = s.kills;
      set(this.weatherEl, s.weather);
      set(this.diffEl, `THREAT ${Number(s.difficulty).toFixed(1)}`);
      set(this.killsEl, `KILLS ${s.kills}`);
    }
    if (force || c.inTower !== s.inTower) {
      c.inTower = s.inTower;
      this.safeZoneEl.classList.toggle('visible', !!s.inTower);
    }
    if (force || c.night !== s.isNight) {
      c.night = s.isNight;
      this.nightEl.classList.toggle('visible', !!s.isNight);
    }

    // ---- crosshair hidden while in tower / overlays
    const showCross = s.state === 'playing' && !s.inTower && !s.buyMenuOpen;
    if (c.showCross !== showCross) {
      c.showCross = showCross;
      this.crosshair.classList.toggle('hidden', !showCross);
    }

    // ---- decay timers
    if (this._bannerT > 0) {
      this._bannerT -= 1 / 60;
      if (this._bannerT <= 0) this.bannerEl.classList.remove('visible');
    }
    if (this._hitT > 0) {
      this._hitT -= 1 / 60;
      this.hitmarkerEl.classList.toggle('visible', this._hitT > 0);
      if (this._hitT <= 0) this.hitmarkerEl.classList.remove('visible');
    }
    if (this._hurtT > 0) {
      this._hurtT -= 1 / 60;
      this.hurtEl.style.opacity = String(clamp(this._hurtT, 0, 1) * 0.85);
      if (this._hurtT <= 0) this.hurtEl.style.opacity = '0';
    }
    const lowHp = s.state === 'playing' && s.health < s.maxHealth * 0.3;
    this.lowhpEl.classList.toggle('visible', lowHp);

    // ---- notes
    for (let i = this._notes.length - 1; i >= 0; i--) {
      const n = this._notes[i];
      n.life -= 1 / 60;
      if (n.life < 0.6) n.el.style.opacity = String(clamp(n.life / 0.6, 0, 1));
      if (n.life <= 0) {
        n.el.remove();
        this._notes.splice(i, 1);
      }
    }

    // ---- compass
    this.#updateCompass(s);
  }

  #updateCompass(s) {
    if (!s.compassYaw && s.compassYaw !== 0) return;
    // heading in atan2(dx, dz) space: yaw 0 faces −z (north)
    const yaw = s.compassYaw;
    const headingDeg = ((Math.atan2(-Math.sin(yaw), -Math.cos(yaw)) * 180 / Math.PI) % 360 + 360) % 360;
    const halfRange = 90; // degrees visible across the strip
    const place = (bearingDeg, el) => {
      let d = ((bearingDeg - headingDeg + 540) % 360) - 180;
      const off = clamp(d / halfRange, -1, 1);
      el.style.left = `${50 + off * 48}%`;
      el.style.opacity = Math.abs(d) > halfRange * 0.9 ? '0' : '1';
    };
    if (!this._cardinals) {
      this._cardinals = [];
      for (const [label, bearing] of [['N', 180], ['E', 90], ['S', 0], ['W', 270]]) {
        const el = this.#el('span', 'compass-card', this.compassTrack, label);
        this._cardinals.push({ el, bearing });
      }
    }
    for (const c of this._cardinals) place(c.bearing, c.el);

    // markers: nearest threat (red) + supply crates (amber)
    this.compassMarks.innerHTML = '';
    if (s.threatBearing != null && s.threatDist != null && s.threatDist < 80) {
      const t = this.#el('span', 'compass-mark threat', this.compassMarks, '▲');
      place(s.threatBearing, t);
    }
    for (const crate of s.crates ?? []) {
      const m = this.#el('span', 'compass-mark crate', this.compassMarks, '◆');
      const dx = crate.x - (this.camera?.position.x ?? 0);
      const dz = crate.z - (this.camera?.position.z ?? 0);
      place(Math.atan2(dx, dz) * 180 / Math.PI, m);
    }
  }
}
