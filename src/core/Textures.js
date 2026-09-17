/**
 * Procedurally generated textures.
 *
 * Shipping zero binary assets keeps the prototype tiny and lets the texture
 * budget stay small: one 256px tile per material family, reused everywhere so
 * the renderer can batch draws against a handful of GL textures.
 */
import * as THREE from 'three';

const cache = new Map();

function canvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function toTexture(c, { repeat = 1, srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function grain(ctx, size, amount, alpha) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    if (alpha !== undefined) d[i + 3] = Math.max(0, Math.min(255, d[i + 3] * alpha));
  }
  ctx.putImageData(img, 0, 0);
}

/** Cracked asphalt road surface. */
function makeAsphalt() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a3d41';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const g = 40 + Math.random() * 60;
    ctx.fillStyle = `rgba(${g},${g},${g + 6},${0.15 + Math.random() * 0.35})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  ctx.strokeStyle = 'rgba(18,18,20,0.6)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 14; i++) {
    ctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 7; s++) {
      x += (Math.random() - 0.5) * 60;
      y += (Math.random() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  grain(ctx, size, 22);
  return c;
}

/** Poured concrete for walls, pads and foundations. */
function makeConcrete() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7e7c76';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 220; i++) {
    const r = 6 + Math.random() * 42;
    ctx.fillStyle = `rgba(${110 + Math.random() * 60},${108 + Math.random() * 56},${102 + Math.random() * 52},0.16)`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(60,58,54,0.4)';
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (i + 0.5) * (size / 5));
    ctx.lineTo(size, (i + 0.5) * (size / 5) + (Math.random() - 0.5) * 12);
    ctx.stroke();
  }
  grain(ctx, size, 26);
  return c;
}

/** Warped, bullet-scarred plaster/panel for building exteriors. */
function makeFacade() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, size);
  grd.addColorStop(0, '#9c9182');
  grd.addColorStop(1, '#7d7263');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 40},${36 + Math.random() * 34},${30 + Math.random() * 30},${0.05 + Math.random() * 0.16})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 4 + Math.random() * 70, 3 + Math.random() * 34);
  }
  // scorch / impact marks
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = 'rgba(46,42,38,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, 1 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  grain(ctx, size, 20);
  return c;
}

/** Rusty corrugated shipping container. */
function makeCorrugated() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8a4b32';
  ctx.fillRect(0, 0, size, size);
  for (let x = 0; x < size; x += 8) {
    ctx.fillStyle = x % 16 === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.16)';
    ctx.fillRect(x, 0, 4, size);
  }
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(${60 + Math.random() * 90},${30 + Math.random() * 40},${16 + Math.random() * 22},${0.12 + Math.random() * 0.4})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 3 + Math.random() * 26, 2 + Math.random() * 14);
  }
  grain(ctx, size, 24);
  return c;
}

/** Weathered wood for crates and pallets. */
function makeWood() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7a6042';
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 32) {
    ctx.fillStyle = `rgba(${90 + Math.random() * 40},${70 + Math.random() * 30},${46 + Math.random() * 24},0.9)`;
    ctx.fillRect(0, y, size, 30);
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = `rgba(50,38,26,${0.1 + Math.random() * 0.25})`;
      ctx.beginPath();
      ctx.moveTo(0, y + Math.random() * 30);
      ctx.bezierCurveTo(size * 0.3, y + Math.random() * 30, size * 0.6, y + Math.random() * 30, size, y + Math.random() * 30);
      ctx.stroke();
    }
  }
  grain(ctx, size, 18);
  return c;
}

/** Soft radial sprite used for sparks, smoke, muzzle flash and blood puffs. */
function makeSoftDot(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const size = 64;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** Chain-link fence panel (alpha-mapped). */
function makeChainlink() {
  const size = 128;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(190,196,200,0.85)';
  ctx.lineWidth = 2;
  const step = 16;
  for (let i = -size; i < size * 2; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i + size, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
  }
  return c;
}

/** Subtle dirt/sand ground tile used to break up the terrain. */
function makeGround() {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5e6046';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1600; i++) {
    const r = Math.random();
    const col =
      r > 0.85
        ? `rgba(${120 + Math.random() * 40},${112 + Math.random() * 36},${88 + Math.random() * 30},0.5)`
        : r > 0.4
          ? `rgba(${64 + Math.random() * 40},${74 + Math.random() * 40},${48 + Math.random() * 28},0.55)`
          : `rgba(${44 + Math.random() * 30},${52 + Math.random() * 28},${36 + Math.random() * 20},0.5)`;
    ctx.fillStyle = col;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 5, 1 + Math.random() * 5);
  }
  grain(ctx, size, 14);
  return c;
}

export function getTexture(name, repeat = 1) {
  const key = `${name}#${repeat}`;
  if (cache.has(key)) return cache.get(key);
  let tex;
  switch (name) {
    case 'asphalt':
      tex = makeAsphalt();
      break;
    case 'concrete':
      tex = makeConcrete();
      break;
    case 'facade':
      tex = makeFacade();
      break;
    case 'corrugated':
      tex = makeCorrugated();
      break;
    case 'wood':
      tex = makeWood();
      break;
    case 'chainlink':
      tex = makeChainlink();
      break;
    case 'ground':
      tex = makeGround();
      break;
    case 'dot':
      tex = makeSoftDot();
      break;
    case 'spark':
      tex = makeSoftDot('rgba(255,240,200,1)', 'rgba(255,140,40,0)');
      break;
    default:
      throw new Error(`Unknown texture: ${name}`);
  }
  const out = tex instanceof THREE.Texture ? toTexture(tex, { repeat }) : toTexture(tex, { repeat });
  cache.set(key, out);
  return out;
}

/**
 * Shared material library. Reusing instances across hundreds of props keeps
 * draw calls low and lets the renderer sort by material for better batching.
 */
export function makeMaterials() {
  const M = {};
  const lit = (map, extra = {}) => new THREE.MeshLambertMaterial({ map, ...extra });

  // terrain UVs are baked in world space (1 tile per 8 m) in Heightfield.js
  M.ground = new THREE.MeshLambertMaterial({ map: getTexture('ground', 1), vertexColors: true });
  M.road = new THREE.MeshLambertMaterial({ map: getTexture('asphalt', 1), vertexColors: true });
  // Merged environment props carry a per-vertex tint, so the shared materials
  // that consume them must read the colour attribute.
  M.merged = lit(getTexture('facade', 1), { vertexColors: true });
  M.concrete = lit(getTexture('concrete', 1), { vertexColors: true });
  M.concreteSmooth = lit(getTexture('concrete', 1), { vertexColors: true, color: 0xd8d4cc });
  M.facade = lit(getTexture('facade', 1), { vertexColors: true });
  M.metal = new THREE.MeshLambertMaterial({ color: 0x6d737a, vertexColors: true });
  M.metalDark = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  M.wreck = lit(getTexture('corrugated', 1), { vertexColors: true, color: 0x8d9298 });
  M.corrugated = lit(getTexture('corrugated', 1), { vertexColors: true });
  M.wood = lit(getTexture('wood', 1), { vertexColors: true });
  M.bark = lit(getTexture('wood', 1), { vertexColors: true, color: 0xb9a58c });
  M.foliage = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, vertexColors: true });
  M.rock = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, vertexColors: true });
  M.sandbag = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, vertexColors: true });
  M.chainlink = new THREE.MeshLambertMaterial({
    map: getTexture('chainlink', 1),
    vertexColors: true,
    transparent: true,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    color: 0xa9b0b4,
  });
  M.glassDark = new THREE.MeshLambertMaterial({ color: 0x1d2429 });
  M.rust = new THREE.MeshLambertMaterial({ color: 0x8a5230, flatShading: true });
  M.paintYellow = new THREE.MeshLambertMaterial({ color: 0xc9a437 });
  M.paintRed = new THREE.MeshLambertMaterial({ color: 0xa4402f });

  // Emissive / FX
  M.spark = new THREE.PointsMaterial({
    size: 0.14,
    map: getTexture('spark'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: 0xffffff,
  });
  M.smoke = new THREE.PointsMaterial({
    size: 0.55,
    map: getTexture('dot'),
    transparent: true,
    depthWrite: false,
    opacity: 0.32,
    color: 0xb9b3a8,
  });
  // Coolant / hydraulic spray off armour. Base color stays near white because
  // ParticleField multiplies this by a per-particle color — tinting the material
  // dark is how you end up with a gore-looking effect by accident.
  M.fluid = new THREE.PointsMaterial({
    size: 0.2,
    map: getTexture('dot'),
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    color: 0xfff3e2,
  });
  M.brass = new THREE.MeshLambertMaterial({ color: 0xb08d4a, emissive: 0x1a1206 });
  M.decal = new THREE.MeshBasicMaterial({
    map: getTexture('dot'),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    color: 0x161512,
  });
  M.flash = new THREE.SpriteMaterial({
    map: getTexture('dot'),
    color: 0xffd892,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  M.tracer = new THREE.LineBasicMaterial({
    color: 0xffe6ad,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return M;
}
