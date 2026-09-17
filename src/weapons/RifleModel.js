/**
 * RifleModel — the single "AK-01" assault rifle, authored from primitives.
 *
 * The same factory builds the first-person viewmodel (with animated magazine,
 * bolt and muzzle device) and the AI's weapon, so the gun the player holds and
 * the gun being fired at them are literally the same asset.
 */
import * as THREE from 'three';

/**
 * @param {object} opts
 * @param {boolean} opts.viewmodel  viewmodel gets a slimmer profile + flash mount
 * @param {THREE.Material} opts.body  receiver/handguard material
 * @param {THREE.Material} opts.grip  furniture material
 * @param {THREE.Material} opts.metal dark hardware material
 */
export function createRifle({ viewmodel = false, body, grip, metal } = {}) {
  const bodyMat = body ?? new THREE.MeshStandardMaterial({ color: 0x35383d, roughness: 0.52, metalness: 0.72 });
  const gripMat = grip ?? new THREE.MeshStandardMaterial({ color: 0x4a3a29, roughness: 0.72, metalness: 0.1 });
  const metalMat = metal ?? new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.42, metalness: 0.85 });

  const group = new THREE.Group();
  group.name = 'rifle';
  const add = (geo, mat, x = 0, y = 0, z = 0, rot = null) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = false;
    m.receiveShadow = false;
    group.add(m);
    return m;
  };

  const L = viewmodel ? 0.02 : 0; // viewmodel guns read longer when foreshortened

  // ---- receiver (milled look: main tube + top cover rail)
  add(new THREE.BoxGeometry(0.075, 0.085, 0.42 + L), bodyMat, 0, 0, -0.05);
  add(new THREE.BoxGeometry(0.055, 0.022, 0.34 + L), metalMat, 0, 0.053, -0.05);
  // rivet band
  add(new THREE.BoxGeometry(0.079, 0.016, 0.05), metalMat, 0, 0.012, 0.11);

  // ---- handguard with vent slots
  const hg = new THREE.Group();
  const hgMat = gripMat;
  const hgBody = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.26), hgMat);
  hg.add(hgBody);
  for (let i = 0; i < 3; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.074, 0.014, 0.045), metalMat);
    slot.position.set(0, 0.012, -0.08 + i * 0.08);
    hg.add(slot);
    const slot2 = slot.clone();
    slot2.position.y = -0.014;
    hg.add(slot2);
  }
  hg.position.set(0, -0.004, -0.29);
  group.add(hg);

  // ---- gas tube + front sight
  add(new THREE.CylinderGeometry(0.013, 0.013, 0.3, 6), metalMat, 0, 0.045, -0.44, [Math.PI / 2, 0, 0]);
  add(new THREE.BoxGeometry(0.012, 0.055, 0.02), metalMat, 0, 0.072, -0.56);
  add(new THREE.BoxGeometry(0.05, 0.008, 0.02), metalMat, 0, 0.09, -0.56);

  // ---- barrel + muzzle device
  const barrelLen = 0.3;
  add(new THREE.CylinderGeometry(0.014, 0.016, barrelLen, 8), metalMat, 0, 0.018, -0.66, [Math.PI / 2, 0, 0]);
  const muzzle = new THREE.Group();
  muzzle.position.set(0, 0.018, -0.83);
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.028, 0.075, 10), metalMat);
  brake.rotation.x = Math.PI / 2;
  muzzle.add(brake);
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.05), new THREE.MeshBasicMaterial({ color: 0x0a0a0a }));
  slit.position.z = 0.008;
  muzzle.add(slit);
  group.add(muzzle);

  // ---- rear sight / optic
  if (viewmodel) {
    const dot = new THREE.Group();
    dot.position.set(0, 0.086, -0.16);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.033, 0.06, 12), metalMat);
    housing.rotation.x = Math.PI / 2;
    dot.add(housing);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.024, 16),
      new THREE.MeshBasicMaterial({ color: 0x2a3742, transparent: true, opacity: 0.85 }),
    );
    lens.position.z = -0.032;
    dot.add(lens);
    const emitter = new THREE.Mesh(new THREE.CircleGeometry(0.0045, 8), new THREE.MeshBasicMaterial({ color: 0xff4d4d }));
    emitter.position.set(0, 0, -0.0315);
    dot.add(emitter);
    dot.visible = false;
    group.add(dot);
    group.userData.dot = dot;
    group.userData.emitter = emitter;
  } else {
    add(new THREE.BoxGeometry(0.045, 0.02, 0.03), metalMat, 0, 0.07, -0.2);
  }

  // ---- magazine (animated during reload)
  const mag = new THREE.Group();
  const curve = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.17, 0.09), bodyMat);
  curve.position.set(0, -0.11, 0.005);
  curve.rotation.x = 0.16;
  mag.add(curve);
  const magRibs = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.02, 0.093), metalMat);
  magRibs.position.set(0, -0.06, 0.005);
  magRibs.rotation.x = 0.16;
  mag.add(magRibs);
  mag.position.set(0, -0.05, -0.04);
  group.add(mag);

  // ---- pistol grip + trigger guard
  const gripMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06), gripMat);
  gripMesh.position.set(0, -0.1, 0.115);
  gripMesh.rotation.x = -0.3;
  group.add(gripMesh);
  add(new THREE.TorusGeometry(0.032, 0.006, 6, 10, Math.PI), metalMat, 0, -0.055, 0.07, [0, 0, Math.PI]);
  add(new THREE.BoxGeometry(0.008, 0.028, 0.008), metalMat, 0, -0.062, 0.062, [0.2, 0, 0]);

  // ---- charging handle (animated on every shot)
  const bolt = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.014, 0.02), metalMat);
  handle.position.set(0.045, 0.03, -0.02);
  bolt.add(handle);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 6), metalMat);
  knob.rotation.z = Math.PI / 2;
  knob.position.set(0.09, 0.03, -0.02);
  bolt.add(knob);
  group.add(bolt);

  // ---- stock
  const stock = new THREE.Group();
  const stockBody = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.075, 0.26), gripMat);
  stockBody.position.set(0, -0.01, 0.29);
  stock.add(stockBody);
  const comb = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.03, 0.12), gripMat);
  comb.position.set(0, 0.04, 0.2);
  stock.add(comb);
  const butt = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.115, 0.028), metalMat);
  butt.position.set(0, -0.005, 0.425);
  stock.add(butt);
  group.add(stock);

  // ---- sling swivels (small silhouette details)
  add(new THREE.TorusGeometry(0.012, 0.0035, 4, 8), metalMat, -0.04, -0.03, -0.42, [0, Math.PI / 2, 0]);
  add(new THREE.TorusGeometry(0.012, 0.0035, 4, 8), metalMat, -0.04, -0.02, 0.3, [0, Math.PI / 2, 0]);

  group.userData.mag = mag;
  group.userData.bolt = bolt;
  group.userData.muzzle = muzzle;
  group.userData.receiver = group.children[0];
  group.userData.handguard = hg;
  return group;
}

/**
 * First-person arms: two forearms + gloved hands, posed on the rifle.
 * Kept deliberately light — the player never sees their own body, so all we
 * render is what crosses the field of view.
 */
export function createArms({ sleeve, skin } = {}) {
  const sleeveMat = sleeve ?? new THREE.MeshStandardMaterial({ color: 0x46503c, roughness: 0.86, metalness: 0.05 });
  const skinMat = skin ?? new THREE.MeshStandardMaterial({ color: 0x2f3134, roughness: 0.7, metalness: 0.05 });
  const group = new THREE.Group();

  const makeArm = (side) => {
    const arm = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.046, 0.34, 8), sleeveMat);
    upper.rotation.x = Math.PI / 2.35;
    upper.position.set(0, -0.02, 0.16);
    arm.add(upper);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.038, 0.3, 8), sleeveMat);
    fore.rotation.x = Math.PI / 3.1;
    fore.position.set(0, 0.02, -0.06);
    arm.add(fore);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 8), skinMat);
    cuff.rotation.x = Math.PI / 3.1;
    cuff.position.set(0, 0.07, -0.19);
    arm.add(cuff);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.05, 0.1), skinMat);
    hand.position.set(0, 0.075, -0.25);
    hand.rotation.x = 0.25;
    arm.add(hand);
    for (let i = 0; i < 3; i++) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.014, 0.06), skinMat);
      finger.position.set(-0.02 + i * 0.02, 0.05, -0.3);
      arm.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.05), skinMat);
    thumb.position.set(side * 0.032, 0.072, -0.28);
    thumb.rotation.y = side * 0.5;
    arm.add(thumb);
    return arm;
  };

  const left = makeArm(-1);
  left.position.set(-0.085, -0.045, -0.16);
  left.rotation.set(0.1, 0.42, -0.22);
  const right = makeArm(1);
  right.position.set(0.1, -0.09, 0.06);
  right.rotation.set(0.02, -0.5, 0.3);
  group.add(left, right);
  group.userData.left = left;
  group.userData.right = right;
  return group;
}

/** Soft additive sprite + point light pair used for the muzzle flash. */
export function createMuzzleFlash({ map, lightColor = 0xffb45a, lightIntensity = 3.2 }) {
  const group = new THREE.Group();
  const spriteMat = new THREE.SpriteMaterial({
    map,
    color: 0xffd28a,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(0.34, 0.34, 0.34);
  group.add(sprite);
  const star = new THREE.Sprite(
    new THREE.SpriteMaterial({ map, color: 0xfff0c0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  star.scale.set(0.5, 0.16, 1);
  star.rotation.z = 0.6;
  group.add(star);
  const light = new THREE.PointLight(lightColor, lightIntensity, 14, 2);
  group.add(light);
  group.userData.sprite = sprite;
  group.userData.star = star;
  group.userData.light = light;
  group.userData.materials = [spriteMat, star.material];
  group.visible = false;
  return group;
}
