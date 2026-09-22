/**
 * Engine — renderer, lighting, sky, shadow budget and the frame loop.
 *
 * Rendering strategy (all of it measurable in the F3 overlay):
 *  • the world is merged geometry + instanced prop families; three.js frustum
 *    culling runs per object and a cell culler hides whole city blocks;
 *  • one shadow-casting light with a shadow camera that snaps to a 4 m grid and
 *    follows the player, and a distance budget so far props never enter the
 *    depth pass;
 *  • the viewmodel lives in its own scene rendered after a depth clear, so the
 *    rifle can never clip into a wall and can keep its own FOV;
 *  • pixel ratio is scaled at runtime to hold frame time in budget.
 */
import * as THREE from 'three';
import { RENDER } from '../config/GameConfig.js';
import { clamp, damp, lerp } from './math.js';

const SKY_VS = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FS = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    float y = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(smoothstep(0.42, 1.0, y), 0.8));
    col = mix(uBottom, col, smoothstep(0.28, 0.52, y));
    float sun = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 220.0);
    float halo = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 6.0) * 0.16;
    col += uSunColor * (sun * 1.4 + halo);
    // banded haze near the ground line so the arena edge never shows a hard seam
    float haze = 1.0 - smoothstep(0.42, 0.56, y);
    col = mix(col, uHorizon * 1.06, haze * 0.75);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Engine {
  constructor({ canvas, onFrame, onResize }) {
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onResize = onResize;
    this.running = false;
    this.clock = new THREE.Clock();
    this.perf = {
      fps: 60,
      frameMs: 16.7,
      calls: 0,
      tris: 0,
      near: 0,
      far: 0,
      culled: 0,
      cellsVis: 0,
      cellsTot: 0,
      particles: 0,
      shadowCasters: 0,
      resScale: 1,
      rays: 0,
      boxTests: 0,
      aiState: '—',
      aiAware: 0,
      aiHp: 100,
    };
    this.resScale = 1;
    this._slow = 0;
    this._fast = 0;
    this.debug = false;
  }

  init() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The shadow map is refreshed on a timer / when the follow-grid snaps,
    // never per frame: the arena is static, so a 10 Hz refresh is invisible.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    this.shadowInterval = 0.09;
    this._shadowT = 0;
    renderer.autoClear = false;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x9fb0ac, RENDER.fogNear, RENDER.fogFar);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(76, window.innerWidth / Math.max(1, window.innerHeight), 0.12, RENDER.farClip);
    scene.add(this.camera);

    // ------------------------------------------------------------- sky
    const skyGeo = new THREE.SphereGeometry(460, 24, 16);
    this.sunDir = new THREE.Vector3(-0.52, 0.34, -0.78).normalize();
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x2e4a63) },
        uHorizon: { value: new THREE.Color(0xbfae90) },
        uBottom: { value: new THREE.Color(0x3a3a33) },
        uSunColor: { value: new THREE.Color(0xffd9a0) },
        uSunDir: { value: this.sunDir },
      },
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(skyGeo, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    // --------------------------------------------------------- lighting
    // Exactly one dynamic light plus two static fills: shadow cost stays flat
    // no matter how much geometry is in view.
    this.sun = new THREE.DirectionalLight(0xffe6c2, 2.35);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.near = 1;
    sc.far = 180;
    sc.left = -44;
    sc.right = 44;
    sc.top = 44;
    sc.bottom = -44;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.055;
    this.sun.shadow.radius = 1.6;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa9c4d8, 0x5a5341, 1.15);
    scene.add(this.hemi);
    this.fill = new THREE.DirectionalLight(0x7ea6c8, 0.42);
    this.fill.position.set(60, 40, 80);
    scene.add(this.fill);
    this.ambient = new THREE.AmbientLight(0x40484f, 0.5);
    scene.add(this.ambient);

    // ------------------------------------------------- viewmodel scene
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(58, this.camera.aspect, 0.01, 12);
    const keyLight = new THREE.DirectionalLight(0xfff0d8, 2.2);
    keyLight.position.set(-0.6, 1.2, 0.8);
    this.vmScene.add(keyLight);
    const rim = new THREE.DirectionalLight(0x8fd0ff, 1.15);
    rim.position.set(1.1, 0.2, -1);
    this.vmScene.add(rim);
    this.vmScene.add(new THREE.AmbientLight(0x515a63, 1.25));
    this.vmKey = keyLight;

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._shadowTargets = [];

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    return this;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / Math.max(1, h);
    this.vmCamera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER.maxPixelRatio) * this.resScale);
    this.renderer.setSize(w, h, false);
    this.onResize?.(w, h);
  }

  /** Registers the meshes whose shadow casting is distance-managed. */
  setShadowCandidates(objects) {
    this._shadowTargets = objects.filter(Boolean);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      const raw = this.clock.getDelta();
      const dt = clamp(raw, 0.0001, 1 / 20);
      const t0 = performance.now();
      let pauseRendering = false;
      if (this.onFrame) pauseRendering = this.onFrame(dt, raw) === false;
      if (!pauseRendering) this.render();
      const ms = performance.now() - t0;
      this.#samplePerf(ms, raw);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  #samplePerf(ms, raw) {
    const p = this.perf;
    p.frameMs = damp(p.frameMs, ms, 0.12, 1 / 60);
    p.fps = damp(p.fps, raw > 0 ? 1 / raw : 60, 0.08, 1 / 60);
    // adaptive resolution: hold a ~55fps budget without ever going below 0.62x
    if (p.frameMs > 21) {
      this._slow++;
      this._fast = 0;
    } else if (p.frameMs < 12) {
      this._fast++;
      this._slow = 0;
    }
    if (this._slow > 45 && this.resScale > 0.62) {
      this.resScale = Math.max(0.62, this.resScale - 0.1);
      this._slow = 0;
      this.resize();
    } else if (this._fast > 180 && this.resScale < 1) {
      this.resScale = Math.min(1, this.resScale + 0.08);
      this._fast = 0;
      this.resize();
    }
  }

  updateFrustum() {
    this.camera.updateMatrixWorld();
    this._projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);
    return this._frustum;
  }

  /** Culling / LOD / shadow pass — throttled by the caller. */
  updateCulling(env, camPos, dt) {
    const frustum = this.updateFrustum();
    const props = env.props.update(camPos, frustum);
    const cells = env.culler.update(frustum, camPos, 240);
    // shadow budget: only near structures enter the depth pass
    const range2 = RENDER.shadowCasterRange * RENDER.shadowCasterRange;
    let casters = 0;
    for (const entry of env.culler.cells.values()) {
      const near = entry.center.distanceToSquared(camPos) < range2;
      for (const o of entry.objects) {
        if (o.castShadow !== near) o.castShadow = near;
        if (near) casters++;
      }
    }
    let shadowDirty = false;
    for (const fam of env.props.families) {
      const want = fam.stats.near > 0 && fam.shadow;
      if (fam.nearMesh.castShadow !== want) {
        fam.nearMesh.castShadow = want;
        shadowDirty = true;
      }
      if (want) casters += fam.stats.near;
    }
    // culling changes which structures are in the depth pass → force a refresh
    if (shadowDirty || this._lastCullVisible !== cells.visible) {
      this._lastCullVisible = cells.visible;
      this._shadowT = 0;
    }
    return { props, cells, casters };
  }

  /**
   * Keeps the shadow map glued to the player on a coarse grid (no crawling)
   * and only flags a re-render when something actually changed.
   */
  updateShadowCamera(target, dt) {
    const snap = 4;
    const sx = Math.round(target.x / snap) * snap;
    const sz = Math.round(target.z / snap) * snap;
    const sy = Math.round((target.y + 6) / snap) * snap;
    this.sun.position.set(sx + this.sunDir.x * 70, sy + this.sunDir.y * 70, sz + this.sunDir.z * 70);
    this.sun.target.position.set(sx, target.y, sz);
    this.sun.target.updateMatrixWorld();
    const snapped = this._snapPos ?? (this._snapPos = new THREE.Vector3());
    const snappedChanged = Math.abs(snapped.x - sx) + Math.abs(snapped.y - sy) + Math.abs(snapped.z - sz) > 0.001;
    snapped.set(sx, sy, sz);
    this._shadowT -= dt ?? 0.1;
    if (snappedChanged) this._shadowT = 0;
    if (this._shadowT <= 0) {
      this.renderer.shadowMap.needsUpdate = true;
      this._shadowT = this.shadowInterval;
    }
  }

  render() {
    const r = this.renderer;
    r.clear(true, true, false);
    this.sky.position.copy(this.camera.position);
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.vmScene, this.vmCamera);
    this.perf.resScale = this.resScale;
    const info = r.info.render;
    this.perf.calls = info.calls;
    this.perf.tris = info.triangles;
  }

  /**
   * Applies the combined day/night + weather atmosphere: sun, sky, fog,
   * exposure, fills. `atm` fields: sunDir, sunColor, sunIntensity, skyTop,
   * skyHorizon, skyBottom, hemiSky, hemiGround, hemiIntensity, fogColor,
   * fogNear, fogFar, exposure, dim, flash.
   */
  applyEnvironment(atm) {
    const dim = atm.dim ?? 1;
    const flash = atm.flash ?? 0;
    this.sunDir.copy(atm.sunDir);
    this.sun.color.copy(atm.sunColor);
    this.sun.intensity = atm.sunIntensity * dim + flash * 1.6;
    this.hemi.color.copy(atm.hemiSky);
    this.hemi.groundColor.copy(atm.hemiGround);
    this.hemi.intensity = atm.hemiIntensity * dim + flash * 0.8;
    this.ambient.intensity = 0.5 * dim + flash * 0.35;
    this.fill.intensity = 0.42 * dim;
    const fog = this.scene.fog;
    fog.color.copy(atm.fogColor);
    fog.near = atm.fogNear;
    fog.far = atm.fogFar;
    const u = this.skyMat.uniforms;
    u.uTop.value.copy(atm.skyTop).multiplyScalar(lerp(1, 0.5, 1 - dim));
    u.uHorizon.value.copy(atm.skyHorizon).multiplyScalar(lerp(1, 0.5, 1 - dim));
    u.uBottom.value.copy(atm.skyBottom);
    u.uSunColor.value.copy(atm.sunColor);
    u.uSunDir.value.copy(atm.sunDir);
    this.renderer.toneMappingExposure = (atm.exposure ?? 1.06) + flash * 0.25;
    // the viewmodel light follows the mood so the gun never glows at night
    this.vmKey.intensity = 0.75 + 1.45 * dim;
  }

  /**
   * Culling + shadow budget for the streamed world: whole chunk groups are
   * frustum-culled by the cell culler; distant chunks leave the shadow pass.
   */
  updateWorldCulling(world, camPos) {
    const frustum = this.updateFrustum();
    const cells = world.culler.update(frustum, camPos, RENDER.fogFar + 40);
    const range2 = RENDER.shadowCasterRange * RENDER.shadowCasterRange;
    let casters = 0;
    for (const entry of world.culler.cells.values()) {
      const near = entry.center.distanceToSquared(camPos) < range2;
      for (const o of entry.objects) {
        if (o.castShadow !== near) o.castShadow = near;
        if (near) casters++;
      }
    }
    return { cells, casters };
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._resize);
    this.renderer?.dispose();
  }
}
