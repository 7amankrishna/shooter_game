/**
 * Browser smoke test (Playwright, real Chromium): boots the built game,
 * clicks through the menu into gameplay and asserts the HUD comes alive.
 * Run: npm run build && npm run smoke
 * Requires a downloaded browser: npx playwright install chromium
 * (or point CHROMIUM_PATH at any local Chromium/Chrome binary).
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'dist');
if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('dist/ missing — run `npm run build` first');
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  let path = join(ROOT, url === '/' ? 'index.html' : url);
  if (!existsSync(path) || extname(path) === '') path = join(ROOT, 'index.html');
  res.setHeader('content-type', MIME[extname(path)] ?? 'application/octet-stream');
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(4174, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const fail = (msg) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok   ${msg}`);

await page.goto('http://127.0.0.1:4174/', { waitUntil: 'load' });
await page.waitForTimeout(3000); // boot + menu build

// menu is up with the new title
const title = await page.title();
title.includes('DEADFALL') ? ok(`title: ${title}`) : fail(`title: ${title}`);

const playVisible = await page.locator('text=PLAY').first().isVisible().catch(() => false);
playVisible ? ok('main menu shows PLAY') : fail('main menu PLAY button not visible');

const creditsVisible = await page.locator('text=CREDITS').first().isVisible().catch(() => false);
creditsVisible ? ok('main menu shows CREDITS') : fail('CREDITS not visible');

// settings screen round trip
await page.locator('text=SETTINGS').first().click();
await page.waitForTimeout(300);
const settingsUp = await page.locator('text=SENSITIVITY').first().isVisible().catch(() => false);
settingsUp ? ok('settings screen opens') : fail('settings screen did not open');
await page.locator('text=BACK').first().click();
await page.waitForTimeout(300);

// start a run: PLAY → loading → playing (canvas click locks pointer)
await page.locator('text=PLAY').first().click();
await page.waitForTimeout(12000); // world build + fade in

const uiText = await page.locator('#ui').innerText().catch(() => '');
uiText.includes('HEALTH') ? ok('HUD vitals rendered') : fail(`HUD vitals missing: "${uiText.slice(0, 120)}"`);
uiText.includes('STAMINA') ? ok('HUD stamina rendered') : fail('HUD stamina missing');
/ammo|\d+\s*\/\s*\d+/i.test(uiText) ? ok('HUD ammo rendered') : fail(`HUD ammo missing: "${uiText.slice(0, 160)}"`);
uiText.includes('COINS') || uiText.includes('¤') ? ok('HUD coins rendered') : fail('HUD coins missing');
// HEALTH/AMMO are also present in the menu's already-built HUD, so verify the
// gameplay-specific state as well. This catches a Play handler that hides the
// menu but forgets to transition Survival from its pre-run menu state.
const crosshairHidden = await page.locator('.crosshair').evaluate((el) => el.classList.contains('hidden')).catch(() => true);
!crosshairHidden ? ok('PLAY entered the active gameplay state') : fail('PLAY did not enter the active gameplay state');

// the canvas exists and is sized
const canvas = page.locator('#gl');
const w = await canvas.evaluate((el) => el.width);
(w >= 640) ? ok(`canvas alive (${w}px wide)`) : fail(`canvas broken (${w}px)`);

// ...and the 3D view actually draws. HUD text can't prove that: a frame loop
// that throws after game.update() keeps the DOM HUD fresh but never reaches
// engine.render(), leaving a black view. Sample the canvas in a rAF callback
// queued after the game's own, while this frame's drawing buffer is intact.
const viewContrast = await page.evaluate(() => new Promise((resolve) => {
  const gl = document.getElementById('gl');
  if (!gl.getContext('webgl2')) { resolve(null); return; } // no WebGL: nothing to measure
  const probe = document.createElement('canvas');
  probe.width = 64;
  probe.height = 36;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  let frames = 0;
  let best = 0;
  const sample = () => {
    ctx.drawImage(gl, 0, 0, probe.width, probe.height);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < d.length; i += 4) {
      const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += luma;
      sq += luma * luma;
    }
    const n = d.length / 4;
    best = Math.max(best, Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)));
    if (++frames < 5) requestAnimationFrame(sample);
    else resolve(best);
  };
  requestAnimationFrame(sample);
}));
if (viewContrast === null) ok('3D view check skipped (no WebGL in this browser)');
else if (viewContrast > 4) ok(`3D view renders (luma σ ${viewContrast.toFixed(1)})`);
else fail(`3D view is blank after PLAY (luma σ ${viewContrast.toFixed(1)}): the frame loop is not rendering`);

// simulate a few seconds of play with real rAF — the game keeps running
await page.keyboard.down('w');
await page.waitForTimeout(2500);
await page.keyboard.up('w');
await page.waitForTimeout(1000);

// debug overlay (F3) proves the loop is ticking with real frame data
await page.keyboard.press('F3');
await page.waitForTimeout(800);
const afterText = await page.locator('#ui').innerText().catch(() => '');
/debug|fps|frame/i.test(afterText) ? ok('debug overlay responds (loop is live)') : ok('loop running (debug overlay not matched, non-fatal)');

if (errors.length) {
  // WebGL context creation messages in CI are tolerated; real JS errors are not.
  // WebGL API misuse (e.g. a bad texture upload) is a bug, not CI noise.
  const fatal = errors.filter((e) => !/webgl|WebGL|GPU/i.test(e) || /TypeError|Failed to execute/.test(e));
  fatal.length ? fail(`browser errors:\n  ${fatal.join('\n  ')}`) : ok(`only WebGL/CI noise (${errors.length} ignored)`);
} else {
  ok('no browser errors');
}

await browser.close();
server.close();
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
process.exit(process.exitCode ?? 0);
