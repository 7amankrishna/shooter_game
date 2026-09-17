/**
 * Menu — main menu, difficulty select, controls, pause and results screens.
 *
 * Screens are declarative (a spec table + one builder) so the flow
 * MENU → DIFFICULTY → LOAD → … → RESULTS → PLAY AGAIN is just transitions, and
 * every screen stays keyboard navigable as well as clickable.
 */
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../config/DifficultyConfig.js';
import { formatScore, formatTime, clamp } from '../core/math.js';

const CONTROLS = [
  ['W / ↑', 'Move forward'],
  ['S / ↓', 'Move backward'],
  ['A / ←', 'Strafe left'],
  ['D / →', 'Strafe right'],
  ['Mouse', 'Look / aim'],
  ['Left Mouse', 'Fire (hold for full-auto)'],
  ['Right Mouse', 'Aim down sights — tighter group, zoom, slower move'],
  ['R', 'Reload'],
  ['Shift', 'Sprint (cancels ADS)'],
  ['Space', 'Jump'],
  ['C', 'Crouch — smaller profile, quieter, slower'],
  ['Esc', 'Pause'],
  ['F3', 'Perf overlay (draw calls, LOD buckets, ray stats)'],
  ['M', 'Mute audio'],
  ['Alt + Arrows', 'Turn with the keyboard (only when mouse capture is blocked)'],
];

export class Menu {
  constructor({ root, handlers = {} }) {
    this.root = root;
    this.h = handlers;
    this.difficulty = 'MEDIUM';
    this.current = null;
    this.screens = {};
    this.#build();
  }

  #el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  #btn(label, cls, onClick, hint) {
    const b = this.#el('button', `btn ${cls ?? ''}`.trim(), null);
    b.labelEl = this.#el('span', '', b, label);
    if (hint) b.hintEl = this.#el('span', 'k', b, hint);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick?.();
    });
    return b;
  }

  #screen(name, buildFn) {
    const el = this.#el('div', 'screen', this.root);
    el.dataset.screen = name;
    const card = this.#el('div', 'card', el);
    buildFn(card, el);
    this.screens[name] = el;
    return el;
  }

  #build() {
    /* ---------------- main ---------------- */
    this.#screen('main', (card) => {
      this.#el('h1', '', card, 'BLACKLINE');
      this.#el('div', 'sub', card, 'ARENA // 1v1 COMBAT TRIAL');
      this.#el('p', '', card,
        'One rifle. One machine. An abandoned supply quarter with sightlines you have to earn. Read its footsteps, take the angle, and score the hits — headshots pay ten times what a leg does.');
      const list = this.#el('div', 'menu-list', card);
      list.appendChild(this.#btn('Play', 'primary', () => this.h.play?.(), 'ENTER'));
      list.appendChild(this.#btn(`Difficulty · ${this.difficulty}`, '', () => {
        this.h.difficulty?.();
      }, 'ENTER'));
      this.mainDifficultyRow = list.children[1];
      list.appendChild(this.#btn('Controls', '', () => this.h.controls?.(), 'C'));
      list.appendChild(this.#btn('Restart match', '', () => this.h.restart?.(), 'R'));
      list.appendChild(this.#btn('Quit', 'danger', () => this.h.quit?.(), 'Q'));
      this.#el('div', 'hint', card,
        'Tip: the machine learns nothing, but it does hunt — breaking line of sight only buys you a reposition, not a rest.');
      this.#el('div', 'hint', card, 'Mouse capture is used when the browser allows it. If it is blocked, the view still turns at the edge of the window.');
    });

    /* ---------------- difficulty ---------------- */
    this.#screen('difficulty', (card) => {
      this.#el('h1', '', card, 'DIFFICULTY');
      this.#el('div', 'sub', card, 'AI TACTICAL PROFILE');
      const grid = this.#el('div', 'diff-grid', card);
      this.diffCards = {};
      for (const key of DIFFICULTY_ORDER) {
        const cfg = DIFFICULTIES[key];
        const btn = this.#el('button', 'diff', grid);
        btn.type = 'button';
        this.#el('div', 'key', btn, `${DIFFICULTY_ORDER.indexOf(key) + 1} · ${key}`);
        this.#el('div', 't', btn, cfg.title);
        this.#el('div', 'd', btn, cfg.blurb);
        const bars = this.#el('div', 'bars', btn);
        const metric = (label, value) => {
          const row = this.#el('div', 'b', bars);
          this.#el('div', '', row, label);
          const track = this.#el('div', 't2', row);
          this.#el('i', '', track).style.width = `${clamp(value, 0, 1) * 100}%`;
        };
        metric('REACTION', 1 - (cfg.reaction[0] + cfg.reaction[1]) / 2 / 1.6);
        metric('ACCURACY', 1 - cfg.aimErrorDeg / 4);
        metric('COVER USE', cfg.coverChance);
        metric('AGGRESSION', cfg.aggression);
        metric('MOVEMENT', (cfg.moveSpeed - 2) / 3);
        bars.appendChild(this.#el('div', '', null, cfg.tagline)).style.cssText = 'margin-top:8px;color:rgba(200,226,238,.55);text-transform:none;font-size:10px;line-height:1.5';
        btn.addEventListener('click', () => {
          this.difficulty = key;
          this.#reflectDifficulty();
          this.h.pickDifficulty?.(key);
        });
        this.diffCards[key] = btn;
      }
      const row = this.#el('div', 'row-btns', card);
      row.appendChild(this.#btn('Back', '', () => this.h.back?.(), 'ESC'));
      this.#reflectDifficulty();
    });

    /* ---------------- controls ---------------- */
    this.#screen('controls', (card) => {
      this.#el('h1', '', card, 'CONTROLS');
      this.#el('div', 'sub', card, 'FIELD DOCTRINE');
      const table = this.#el('table', 'keys', card);
      const body = this.#el('tbody', '', table);
      for (const [k, v] of CONTROLS) {
        const tr = this.#el('tr', '', body);
        const td = this.#el('td', '', tr);
        k.split(' / ').forEach((part, i) => {
          if (i) td.appendChild(document.createTextNode(' / '));
          const key = this.#el('kbd', '', td, part);
          void key;
        });
        this.#el('td', '', tr, v);
      }
      this.#el('h2', '', card, 'Scoring');
      this.#el('p', '', card,
        'Head +100 · Chest +50 · Lower torso +40 · Arm +25 · Leg +20 · Graze +10. Consecutive hits raise the multiplier (×1.5 → ×3.0), headshot streaks and sustained accuracy pay flat bonuses, and a miss only breaks the combo if you do not land another hit within 3.2 seconds.');
      this.#el('p', '', card,
        'Damage is scored separately: head 100, chest 40, lower torso 30, arm 20, leg 15, graze 5. One clean headshot ends the match — which is why the machine keeps its armour angled at cover, not at you.');
      const row = this.#el('div', 'row-btns', card);
      row.appendChild(this.#btn('Back', '', () => this.h.back?.(), 'ESC'));
    });

    /* ---------------- pause ---------------- */
    this.#screen('pause', (card) => {
      this.#el('h1', '', card, 'PAUSED');
      this.#el('div', 'sub', card, 'MATCH SUSPENDED');
      this.pauseInfo = this.#el('p', '', card, '');
      const list = this.#el('div', 'menu-list', card);
      list.appendChild(this.#btn('Resume', 'primary', () => this.h.resume?.(), 'ESC'));
      list.appendChild(this.#btn('Restart match', '', () => this.h.restart?.(), 'R'));
      list.appendChild(this.#btn('Change difficulty', '', () => this.h.difficulty?.(), 'D'));
      list.appendChild(this.#btn('Controls', '', () => this.h.controls?.(), 'C'));
      list.appendChild(this.#btn('Quit to main menu', 'danger', () => this.h.quit?.(), 'Q'));
    });

    /* ---------------- results ---------------- */
    this.#screen('results', (card) => {
      const head = this.#el('div', 'headline', card, 'MATCH COMPLETE');
      void head;
      this.resOutcome = this.#el('div', 'outcome', card, 'VICTORY');
      const grid = this.#el('div', 'stat-grid', card);
      this.resStats = {};
      const stat = (key, label, big = false) => {
        const s = this.#el('div', `stat ${big ? 'big' : ''}`, grid);
        this.#el('div', 'k', s, label);
        const v = this.#el('div', 'v', s, '—');
        this.resStats[key] = v;
      };
      stat('score', 'SCORE', true);
      stat('accuracy', 'ACCURACY', true);
      stat('headshots', 'HEADSHOTS');
      stat('hits', 'HITS');
      stat('misses', 'MISSES');
      stat('shots', 'SHOTS FIRED');
      stat('best', 'BEST COMBO');
      stat('time', 'TIME');
      stat('grazes', 'GRAZES');
      this.resBreakdown = this.#el('div', 'breakdown', card);
      const row = this.#el('div', 'row-btns', card);
      row.appendChild(this.#btn('Play again', 'primary', () => this.h.playAgain?.(), 'ENTER'));
      row.appendChild(this.#btn('Change difficulty', '', () => this.h.difficulty?.(), 'D'));
      row.appendChild(this.#btn('Main menu', '', () => this.h.mainMenu?.(), 'ESC'));
    });

    /* ---------------- loading ---------------- */
    this.#screen('loading', (card, el) => {
      el.style.backdropFilter = 'blur(2px)';
      this.#el('h1', '', card, 'DEPLOYING');
      this.#el('div', 'sub', card, 'OPEN WORLD BUILD');
      this.loadBar = this.#el('div', 'bar2', card);
      this.loadFill = this.#el('i', '', this.loadBar);
      this.loadTask = this.#el('div', 'task', card, 'INITIALISING');
      this.loadDetail = this.#el('p', '', card, 'Generating terrain, structures, nav mesh and cover volumes. No asset downloads — the whole quarter is procedural.');
    });

    const brand = this.#el('div', 'brand', this.root, 'BLACKLINE PROTOTYPE · ONE MAP · ONE RIFLE · ONE MACHINE');
    void brand;
  }

  #reflectDifficulty() {
    for (const [key, el] of Object.entries(this.diffCards ?? {})) el.classList.toggle('sel', key === this.difficulty);
    const label = this.mainDifficultyRow?.labelEl ?? this.mainDifficultyRow?.firstChild;
    if (label && DIFFICULTIES[this.difficulty]) {
      label.textContent = `Difficulty · ${this.difficulty} · ${DIFFICULTIES[this.difficulty].title}`;
    }
  }

  setDifficulty(key) {
    this.difficulty = key;
    this.#reflectDifficulty();
  }

  show(name) {
    this.current = name;
    for (const [key, el] of Object.entries(this.screens)) {
      const on = key === name;
      el.classList.toggle('on', on);
      el.style.display = on ? 'flex' : 'none';
    }
    if (name === 'difficulty') this.#reflectDifficulty();
  }

  hide() {
    this.show(null);
  }

  setLoading(task, progress) {
    if (this.loadTask) this.loadTask.textContent = task;
    if (this.loadFill) this.loadFill.style.width = `${Math.round(progress * 100)}%`;
  }

  setPauseInfo(text) {
    if (this.pauseInfo) this.pauseInfo.textContent = text;
  }

  showResults(summary) {
    const win = summary.outcome === 'WIN';
    this.resOutcome.textContent = win ? 'TARGET NEUTRALISED' : 'PLAYER DOWN';
    this.resOutcome.className = `outcome ${win ? 'win' : 'lose'}`;
    const set = (k, v) => {
      this.resStats[k].textContent = v;
    };
    set('score', formatScore(summary.score));
    set('accuracy', `${Math.round(summary.accuracy * 100)}%`);
    set('headshots', String(summary.headshots));
    set('hits', String(summary.hits));
    set('misses', String(summary.misses));
    set('shots', String(summary.shots));
    set('best', `×${summary.bestStreak}`);
    set('time', formatTime(summary.elapsed));
    set('grazes', String(summary.grazes ?? 0));
    const bd = this.resBreakdown;
    bd.innerHTML = '';
    const line = (a, b) => {
      const row = this.#el('div', 'line', bd);
      this.#el('span', '', row, a);
      this.#el('span', '', row, b);
    };
    line('DIFFICULTY', summary.difficulty ?? '—');
    line('AI HEALTH REMAINING', `${summary.aiHealth ?? 0}%`);
    line('YOUR HEALTH', String(summary.playerHealth ?? 0));
    if (summary.killBonus) line('ELIMINATION BONUS', `+${formatScore(summary.killBonus)}`);
    if (summary.speedBonus) line('SPEED BONUS', `+${formatScore(summary.speedBonus)}`);
    line('SCORING', win ? 'FULL PAYOUT' : '50% PARTIAL PAYOUT');
    if (!win) line('NOTE', 'Match lost — hits still scored at half value.');
    this.show('results');
  }
}
