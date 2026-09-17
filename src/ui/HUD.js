/**
 * HUD — the tactical overlay.
 *
 * Built as DOM (crisp text at any DPI, no second canvas pass) and updated from
 * one batched `sync()` per frame with per-field dirty checks, so a 144 Hz
 * display does not get 144 layout invalidations a second. Floating score
 * numbers are projected from world space so they sit exactly where the bullet
 * landed, then drift up and out.
 */
import * as THREE from 'three';
import { formatScore, formatTime, clamp } from '../core/math.js';

const POPUP_POOL = 14;

export class HUD {
  constructor({ root, camera }) {
    this.root = root;
    this.camera = camera;
    this._cache = {};
    this._popups = [];
    this._hitmarkEl = null;
    this._tmp = new THREE.Vector3();
    this._build();
  }

  #el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  _build() {
    const R = this.root;
    R.innerHTML = '';

    this.#el('div', 'vignette', R);
    this.#el('div', 'scanlines', R);
    this.scope = this.#el('div', 'scope', R);
    this.hurt = this.#el('div', 'hurt', R);
    this.lowhp = this.#el('div', 'lowhp', R);
    this.popups = this.#el('div', '', R);
    this.popups.id = 'popups';
    for (let i = 0; i < POPUP_POOL; i++) {
      const el = this.#el('div', 'pop', this.popups);
      el.style.opacity = '0';
      this._popups.push({ el, life: 0, max: 1, world: new THREE.Vector3(), drift: 0 });
    }

    // ---- AI strip (top)
    const top = this.#el('div', 'panel', R);
    top.id = 'hud-top';
    const row = this.#el('div', 'row', top);
    this.aiName = this.#el('div', 'ai-name', row, 'AI MACHINE');
    this.aiStatus = this.#el('div', 'ai-status', row, '—');
    this.aiDist = this.#el('div', 'ai-dist', row, '');
    const barRow = this.#el('div', 'row', top);
    const bar = this.#el('div', 'bar ai', barRow);
    bar.style.flex = '1';
    this.aiFill = this.#el('i', '', bar);
    this.aiPct = this.#el('div', 'bar-pct', barRow, '100%');
    const meta = this.#el('div', 'row', top);
    this.aiMag = this.#el('div', 'label', meta, '');
    this.aiAware = this.#el('div', 'label', meta, '');

    const strip = this.#el('div', '', R);
    strip.id = 'strip';
    this.stripTime = this.#el('div', '', strip, 'T <b>00:00</b>');

    // ---- score (left)
    const score = this.#el('div', 'panel', R);
    score.id = 'hud-score';
    this.scoreTotal = this.#el('div', 'score-total', score, '0');
    this.scoreCombo = this.#el('div', 'combo', score, '');
    const kv = (k) => {
      const wrap = this.#el('div', 'kv', score);
      const kk = this.#el('div', 'k', wrap, k);
      const vv = this.#el('div', 'v', wrap, '0');
      void kk;
      return vv;
    };
    this.stHits = kv('HITS');
    this.stMiss = kv('MISSES');
    this.stAcc = kv('ACCURACY');
    this.stHead = kv('HEADSHOTS');

    // ---- player (bottom-left)
    const player = this.#el('div', 'panel', R);
    player.id = 'hud-player';
    const hpRow = this.#el('div', 'hp-row', player);
    this.#el('div', 'label', hpRow, 'PLAYER');
    this.hpValue = this.#el('div', 'hp', hpRow, '100');
    this.hpBar = this.#el('div', 'bar', player);
    this.hpFill = this.#el('i', 'hpfill', this.hpBar);
    const meta2 = this.#el('div', 'meta', player);
    this.playerState = this.#el('div', '', meta2, 'STANDING');
    this.#el('div', '', meta2, 'VITALS NOMINAL');

    // ---- weapon (bottom-right)
    const weapon = this.#el('div', 'panel', R);
    weapon.id = 'hud-weapon';
    this.wName = this.#el('div', 'wname', weapon, 'AK-01');
    const ammo = this.#el('div', 'ammo', weapon);
    this.ammoMag = this.#el('span', '', ammo, '30');
    this.ammoSep = this.#el('span', '', ammo, ' / ');
    this.ammoReserve = this.#el('span', 'reserve', ammo, '120');
    this.reloadBar = this.#el('div', '', weapon);
    this.reloadBar.id = 'reload-bar';
    this.reloadFill = this.#el('i', '', this.reloadBar);
    const modes = this.#el('div', 'modes', weapon);
    this.modeAds = this.#el('span', '', modes, 'ADS');
    this.modeSprint = this.#el('span', '', modes, 'SPRINT');
    this.modeReload = this.#el('span', '', modes, 'RELOAD');

    // ---- reticle + hit feedback (centre)
    const ret = this.#el('div', '', R);
    ret.id = 'reticle';
    this.cross = ret;
    this.ticks = [];
    for (const cls of ['h', 'h', 'v', 'v']) this.ticks.push(this.#el('div', `tick ${cls}`, ret));
    this.#el('div', 'dot', ret);
    this.hitmark = this.#el('div', '', R);
    this.hitmark.id = 'hitmarker';
    for (let i = 0; i < 4; i++) this.#el('span', '', this.hitmark);
    this.hsRing = this.#el('div', '', R);
    this.hsRing.id = 'headshot-ring';

    this.arcs = this.#el('div', '', R);
    this.arcs.id = 'dmg-arcs';
    this.arcEls = [];
    for (let i = 0; i < 4; i++) this.arcEls.push(this.#el('div', 'arc', this.arcs));
    this.arcIndex = 0;

    this.logEl = this.#el('div', '', R);
    this.logEl.id = 'log';

    this.debug = this.#el('div', '', document.body);
    this.debug.id = 'debug';
  }

  setEnabled(on) {
    this.root.classList.toggle('hidden', !on);
  }

  toast(text, ms = 1200) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }

  log(text) {
    const line = document.createElement('div');
    line.textContent = text;
    this.logEl.appendChild(line);
    while (this.logEl.children.length > 4) this.logEl.removeChild(this.logEl.firstChild);
    setTimeout(() => line.remove(), 3500);
  }

  /* ----------------------------------------------------------- reactions */

  showHitmark({ headshot, graze }) {
    const el = this.hitmark;
    el.classList.remove('show', 'head', 'graze');
    // force a reflow so the animation can restart
    void el.offsetWidth;
    el.classList.add('show');
    if (headshot) el.classList.add('head');
    else if (graze) el.classList.add('graze');
    if (headshot) {
      this.hsRing.classList.remove('show');
      void this.hsRing.offsetWidth;
      this.hsRing.classList.add('show');
    }
  }

  /** Pushes a score popup anchored to a world point (or screen centre). */
  pushPopup({ text, kind = 'hit', worldPoint = null, second = null }) {
    const slot = this._popups.find((p) => p.life <= 0) ?? this._popups[0];
    slot.life = second ? 1.5 : 1.15;
    slot.max = slot.life;
    slot.kind = kind;
    slot.drift = Math.random() * 18 - 9;
    if (worldPoint) slot.world.copy(worldPoint);
    else {
      const dir = this.camera.getWorldDirection(this._tmp);
      slot.world.copy(this.camera.position).addScaledVector(dir, 14);
    }
    slot.el.textContent = text;
    slot.el.className = `pop ${kind}`;
    slot.centered = !worldPoint;
  }

  showDamageArc(worldFrom) {
    const el = this.arcEls[this.arcIndex++ % this.arcEls.length];
    const dx = worldFrom.x - this.camera.position.x;
    const dz = worldFrom.z - this.camera.position.z;
    const rel = Math.atan2(dx, dz) - this.camera.rotation.y;
    el.classList.remove('show');
    void el.offsetWidth;
    el.style.transform = `rotate(${(-rel * 180) / Math.PI}deg)`;
    el.classList.add('show');
    this.hurt.classList.add('on');
    clearTimeout(this._hurtTimer);
    this._hurtTimer = setTimeout(() => this.hurt.classList.remove('on'), 150);
  }

  updatePopups(dt) {
    const cam = this.camera;
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    for (const p of this._popups) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.el.style.opacity = '0';
        continue;
      }
      const t = 1 - p.life / p.max;
      this._tmp.copy(p.world).project(cam);
      const behind = this._tmp.z > 1;
      const x = (this._tmp.x * 0.5 + 0.5) * w;
      const y = (-this._tmp.y * 0.5 + 0.5) * h - t * 46 + p.drift * t;
      const scale = p.kind === 'headshot' || p.kind === 'kill' ? 1 + (1 - Math.min(1, t * 5)) * 0.35 : 1;
      p.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${behind ? h / 2 : y.toFixed(1)}px) scale(${scale.toFixed(2)})`;
      p.el.style.opacity = String(clamp(1 - Math.pow(t, 2.4), 0, 1) * (behind ? 0 : 1));
    }
  }

  /* -------------------------------------------------------------- sync */

  _set(node, prop, value) {
    const key = node.__id ?? (node.__id = Math.random().toString(36).slice(2));
    const k = `${key}:${prop}`;
    if (this._cache[k] === value) return false;
    this._cache[k] = value;
    return true;
  }

  sync(snap, perf = null) {
    if (!snap) return;
    const { player, weapon, ai, score, elapsed, difficulty } = snap;

    // AI block
    const aiPct = Math.round((ai.health / ai.max) * 100);
    if (this._set(this.aiFill, 'w', aiPct)) this.aiFill.style.width = `${aiPct}%`;
    if (this._set(this.aiPct, 't', `${aiPct}%`)) this.aiPct.textContent = `${aiPct}%`;
    if (this._set(this.aiStatus, 't', ai.status)) this.aiStatus.textContent = ai.alive ? ai.status : 'DESTROYED';
    if (this._set(this.aiDist, 't', `${Math.round(ai.distance)}m`)) this.aiDist.textContent = ai.alive ? `${Math.round(ai.distance)} m` : '—';
    const magTxt = ai.alive ? `MAG ${ai.mag}${ai.reloading ? ' · RELOADING' : ''}` : '';
    if (this._set(this.aiMag, 't', magTxt)) this.aiMag.textContent = magTxt;
    const awareTxt = ai.alive ? `CONTACT ${'▮'.repeat(clamp(Math.round(ai.awareness * 5), 0, 5)).padEnd(5, '▯')}` : '';
    if (this._set(this.aiAware, 't', awareTxt)) this.aiAware.textContent = awareTxt;

    // player
    const hp = Math.round(player.health);
    if (this._set(this.hpValue, 't', String(hp))) this.hpValue.textContent = String(hp);
    const hpPct = clamp(hp, 0, 100);
    if (this._set(this.hpFill, 'w', hpPct)) this.hpFill.style.width = `${hpPct}%`;
    if (this._set(this.hpBar, 'low', hp <= 35)) this.hpBar.classList.toggle('low', hp <= 35);
    if (this._set(this.hpValue, 'cls', hp <= 35 ? 'hurt' : hp >= 100 ? 'max' : '')) {
      this.hpValue.className = `hp ${hp <= 35 ? 'hurt' : hp >= 100 ? 'max' : ''}`.trim();
    }
    if (this._set(this.lowhp, 'on', hp <= 30 && player.alive)) this.lowhp.classList.toggle('on', hp <= 30 && player.alive);
    const pstate = !player.alive ? 'DOWN' : player.crouching ? 'CROUCHED' : player.sprinting ? 'SPRINTING' : player.alive ? 'STANDING' : 'STANDING';
    if (this._set(this.playerState, 't', pstate)) this.playerState.textContent = pstate;

    // weapon — the spec's "30 / 120" becomes a hard "RELOAD" call when dry
    const dry = weapon.mag === 0;
    const magText = dry ? (weapon.reserve > 0 ? 'RELOAD' : 'NO AMMO') : String(weapon.mag);
    if (this._set(this.ammoMag, 't', magText)) this.ammoMag.textContent = magText;
    const reserveText = dry ? '' : `/ ${weapon.reserve}`;
    if (this._set(this.ammoReserve, 't', reserveText)) this.ammoReserve.textContent = reserveText;
    if (this._set(this.ammoMag.parentNode, 'dry', dry)) this.ammoMag.parentNode.classList.toggle('dry', dry);
    if (this._set(this.ammoMag.parentNode, 'fs', dry ? '24px' : null)) this.ammoMag.parentNode.style.fontSize = dry ? '24px' : '';
    if (this._set(this.reloadFill, 'w', Math.round(weapon.reloadProgress * 100))) {
      this.reloadFill.style.width = `${Math.round(weapon.reloadProgress * 100)}%`;
    }
    if (this._set(this.modeReload, 'on', weapon.reloading)) this.modeReload.classList.toggle('on', weapon.reloading);
    if (this._set(this.modeAds, 'on', weapon.adsT > 0.6)) this.modeAds.classList.toggle('on', weapon.adsT > 0.6);
    if (this._set(this.modeSprint, 'on', player.sprinting)) this.modeSprint.classList.toggle('on', player.sprinting);

    // score
    if (this._set(this.scoreTotal, 't', formatScore(score.total))) this.scoreTotal.textContent = formatScore(score.total);
    const comboTxt = score.multiplier > 1 ? `${score.streak} HIT COMBO  ×${score.multiplier}` : score.streak > 0 ? `${score.streak} HIT${' ·'}` : '';
    if (this._set(this.scoreCombo, 't', comboTxt)) {
      this.scoreCombo.textContent = comboTxt;
      if (comboTxt) {
        this.scoreCombo.classList.remove('pop');
        void this.scoreCombo.offsetWidth;
        this.scoreCombo.classList.add('pop');
      }
    }
    if (this._set(this.stHits, 't', String(score.hits))) this.stHits.textContent = String(score.hits);
    if (this._set(this.stMiss, 't', String(score.misses))) this.stMiss.textContent = String(score.misses);
    const acc = `${Math.round(score.accuracy * 100)}%`;
    if (this._set(this.stAcc, 't', acc)) this.stAcc.textContent = acc;
    if (this._set(this.stHead, 't', String(score.headshots))) this.stHead.textContent = String(score.headshots);

    // time
    const tstr = `T <b>${formatTime(elapsed)}</b> · ${difficulty ?? ''}`;
    if (this._set(this.stripTime, 'h', tstr)) this.stripTime.innerHTML = tstr;

    // crosshair gap follows live bloom so spread is readable without a number
    const adsT = weapon.adsT ?? 0;
    const gap = 3 + weapon.spread * 2.6 * (1 - adsT * 0.55);
    if (this._set(this.cross, 'gap', Math.round(gap * 10))) {
      const g = gap;
      this.ticks[0].style.transform = `translate(${g + 2}px, 0)`;
      this.ticks[1].style.transform = `translate(${-g - 10}px, 0)`;
      this.ticks[2].style.transform = `translate(0, ${g + 2}px)`;
      this.ticks[3].style.transform = `translate(0, ${-g - 10}px)`;
    }
    if (this._set(this.cross, 'ads', adsT > 0.6)) this.cross.classList.toggle('ads', adsT > 0.6);
    if (this._set(this.scope, 'on', adsT > 0.62)) this.scope.classList.toggle('on', adsT > 0.62);

    if (perf && this.debug) {
      const n = (v, d = 0) => (Number.isFinite(v) ? v : d);
      this.debug.textContent =
        `FPS ${n(perf.fps).toFixed(0)}  frame ${n(perf.frameMs).toFixed(2)}ms\n` +
        `draw calls ${n(perf.calls)}   tris ${(n(perf.tris) / 1000).toFixed(1)}k\n` +
        `props near/far ${n(perf.near)}/${n(perf.far)}  culled ${n(perf.culled)}\n` +
        `cells ${n(perf.cellsVis)}/${n(perf.cellsTot)}\n` +
        `particles ${n(perf.particles)}  shadow casters ${n(perf.shadowCasters)}\n` +
        `rays ${n(perf.rays)} (box tests ${n(perf.boxTests)})\n` +
        `ai ${perf.aiState ?? '-'}  aware ${n(perf.aiAware).toFixed(2)}  hp ${n(perf.aiHp)}\n` +
        `res scale ${(n(perf.resScale, 1) * 100).toFixed(0)}%`;
    }
  }
}
