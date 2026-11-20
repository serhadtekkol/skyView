import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Loads the glTF airliner, normalises its pose, and drives its built-in animation
// clips (gear, flaps, slats, ailerons, elevator, rudder, spoilers, reversers, wing flex...)
// from the flight model state.

const loader = new GLTFLoader();

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.15, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.18)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();

// Surface classes from node names (the models use one texture atlas for almost everything,
// so we split materials per part to get paint / rubber / metal / glass right).
function classify(o, m) {
  let n = '';
  for (let p = o, i = 0; p && i < 4; p = p.parent, i++) n += ' ' + (p.name || '').toLowerCase();
  if (m.transmission > 0 || /transparent|glass|window_glass/.test(n.split(' ')[1] || '')) return 'glass';
  if (/head|pilot|captain|interior|seat|panel|cockpit_(?!transparent)/.test(n)) return 'interior';
  if (/blades|spinner|fan/.test(n)) return 'fan';
  if (/wheel(?!_well)|tire|tyre/.test(n.split(' ')[1] || '')) return 'rubber';
  if (/bay|well/.test(n.split(' ')[1] || '')) return 'bay';
  if (/leg|strut(?!_.*door)|suspension|steering|torque|actuator|axle/.test(n.split(' ')[1] || '')) return 'metal';
  if (/engine.*(exhaust|nozzle|plug)|tailpipe/.test(n)) return 'hot';
  return m.map ? 'paint' : 'other';
}

function makeSurface(src, kind) {
  const base = { map: src.map, side: src.side, alphaTest: src.alphaTest, transparent: src.transparent, opacity: src.opacity, vertexColors: src.vertexColors };
  switch (kind) {
    case 'paint': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.38, metalness: 0.08, clearcoat: 1, clearcoatRoughness: 0.07, specularIntensity: 0.9 });
    case 'fan': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.22, metalness: 0.9 });
    case 'metal': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.3, metalness: 0.85 });
    case 'hot': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.55, metalness: 0.7 });
    case 'rubber': return new THREE.MeshStandardMaterial({ ...base, roughness: 0.88, metalness: 0 });
    case 'bay': return new THREE.MeshStandardMaterial({ ...base, roughness: 0.75, metalness: 0.2 });
    case 'glass': return new THREE.MeshPhysicalMaterial({ color: 0x1c242c, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.55,
      depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.0, ior: 1.52, specularIntensity: 1, envMapIntensity: 1.6, side: THREE.DoubleSide });
    default: return null;
  }
}

function fixMaterials(root, { shadows = true } = {}) {
  const cache = new Map();
  const list = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = shadows; o.receiveShadow = shadows;
    const swap = (m) => {
      const kind = classify(o, m);
      if (kind === 'glass') o.castShadow = false;
      const key = m.uuid + kind;
      if (!cache.has(key)) cache.set(key, makeSurface(m, kind) || m);
      const nm = cache.get(key);
      nm.name = m.name + ':' + kind;
      return nm;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  cache.forEach(m => list.push(m));
  return list;
}

function stripLights(root) {
  const lights = [];
  root.traverse(o => { if (o.isLight) lights.push(o); });
  const info = [];
  for (const l of lights) {
    // A light-only glTF node *is* the light object: replace it by an empty placeholder
    const parent = l.parent;
    const ph = new THREE.Object3D();
    ph.name = l.name;
    ph.position.copy(l.position); ph.quaternion.copy(l.quaternion); ph.scale.copy(l.scale);
    [...l.children].forEach(c => ph.add(c));
    parent.add(ph);
    parent.remove(l);
    info.push({ name: l.name || parent.name, node: ph, color: l.color.clone() });
  }
  return info;
}

/** Sets every animation clip to a sensible "parked" pose and returns the mixer + actions. */
function setupActions(root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  let variantShown = false;
  for (const clip of clips) {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
    a.play(); a.paused = true;
    actions[clip.name] = a;
    const n = clip.name.toLowerCase();
    const isVisibility = clip.tracks.every(t => t.name.endsWith('.scale'));
    let t = 0;
    if (n.includes('landinggear')) t = 0;          // in these models t=0 is gear DOWN, t=1 retracted
    else if (/aileron|elevator|rudder|steering/.test(n)) t = 0.5;
    else if (n.includes('wingflex')) t = 0.0;
    else if (n.includes('suspension')) t = 0.5;
    else if (isVisibility) {
      if (n.includes('captain') || n.includes('pilot')) t = 1;
      else if (!variantShown) { t = 1; variantShown = true; }
    }
    a.time = t * clip.duration;
  }
  mixer.update(0);
  return { mixer, actions };
}

export async function loadStatic(url, { shadows = true } = {}) {
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  stripLights(root);
  fixMaterials(root, { shadows });
  setupActions(root, gltf.animations);
  return root;
}

export class Aircraft {
  async load(url, onProgress) {
    const gltf = await loader.loadAsync(url, e => onProgress?.(e.total ? e.loaded / e.total : 0));
    this.model = gltf.scene;
    this.lightInfo = stripLights(this.model);
    this.materials = fixMaterials(this.model);
    const { mixer, actions } = setupActions(this.model, gltf.animations);
    this.mixer = mixer; this.actions = actions;
    const N = (n) => this.model.getObjectByName(n);

    // variant fuselage: make sure the standard -900 is visible, ER variants hidden
    this.setAnim('900_normal', 1); this.setAnim('900_ER1', 0); this.setAnim('900_ER2', 0);
    this.setAnim('visibility-Captain', 1);

    // ---- measure contact geometry in the gear-down, extended pose
    this.setAnim('LandingGear', 0);   // gear down
    ['wheel-suspension-0', 'wheel-suspension-1', 'wheel-suspension-2'].forEach(n => this.setAnim(n, 1));
    this.mixer.update(0);
    this.model.updateMatrixWorld(true);

    const box = (o) => new THREE.Box3().setFromObject(o, true);
    const noseW = N('nose_wheels');
    const mainA = N('main_wheels_lh001'), mainB = N('main_wheels_lh002');
    const bn = box(noseW), ba = box(mainA), bb = box(mainB);
    const [bl, br] = ba.getCenter(new THREE.Vector3()).x < 0 ? [ba, bb] : [bb, ba];
    const contact = (b) => new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
    const nose = contact(bn), mainL = contact(bl), mainR = contact(br);
    const wheelR = (b) => (b.max.y - b.min.y) / 2;

    const whole = box(this.model);
    const engL = box(N('engine_lh')), engR = box(N('engine_rh'));
    const fus = box(N('900_normalfuselage_900') || N('900_normal/fuselage_900') || this.model);

    // centre of gravity: slightly ahead of the main gear (≈8% of weight on the nose wheel)
    const mainZ = (mainL.z + mainR.z) / 2;
    const cg = new THREE.Vector3(0, 0, mainZ - 0.075 * (mainZ - nose.z));
    // put the model inside a CG-centred group
    this.group = new THREE.Group();
    this.model.position.copy(cg).negate();
    this.group.add(this.model);

    const rel = (v) => v.clone().sub(cg);
    const tipL = new THREE.Vector3(whole.min.x + 0.3, 0, 0), tipR = new THREE.Vector3(whole.max.x - 0.3, 0, 0);
    // find wing-tip height/z from the winglet nodes
    const wl = N('wingletwinglet_wing_part_lh_8'), wr = N('wingletwinglet_wing_part_rh_8');
    if (wl) { const b = box(wl); tipL.set(b.min.x + 0.2, b.min.y, (b.min.z + b.max.z) / 2); }
    if (wr) { const b = box(wr); tipR.set(b.max.x - 0.2, b.min.y, (b.min.z + b.max.z) / 2); }

    this.geometry = {
      cg,
      gear: [
        { name: 'nose', p: rel(nose), k: 4.2e5, c: 5.0e4, steer: true, brake: false, radius: wheelR(bn) },
        { name: 'mainL', p: rel(mainL), k: 2.0e6, c: 2.4e5, steer: false, brake: true, radius: wheelR(bl) },
        { name: 'mainR', p: rel(mainR), k: 2.0e6, c: 2.4e5, steer: false, brake: true, radius: wheelR(br) },
      ],
      hard: [
        { name: 'tail', label: 'kuyruk', p: rel(new THREE.Vector3(0, fus.min.y + 1.15, fus.max.z - 7.5)), fatal: false },
        { name: 'engL', label: 'sol motor', p: rel(new THREE.Vector3((engL.min.x + engL.max.x) / 2, engL.min.y, (engL.min.z + engL.max.z) / 2)), fatal: true },
        { name: 'engR', label: 'sağ motor', p: rel(new THREE.Vector3((engR.min.x + engR.max.x) / 2, engR.min.y, (engR.min.z + engR.max.z) / 2)), fatal: true },
        { name: 'tipL', label: 'sol kanat ucu', p: rel(tipL), fatal: true },
        { name: 'tipR', label: 'sağ kanat ucu', p: rel(tipR), fatal: true },
        { name: 'belly', label: 'gövde', p: rel(new THREE.Vector3(0, fus.min.y + 0.1, (mainZ + nose.z) / 2)), fatal: true },
        { name: 'belly', label: 'gövde', p: rel(new THREE.Vector3(0, fus.min.y + 0.2, mainZ)), fatal: true },
      ],
      cockpit: rel(new THREE.Vector3(-0.5, 1.38, -17.0)),
      length: whole.max.z - whole.min.z,
      engines: [rel(engL.getCenter(new THREE.Vector3())), rel(engR.getCenter(new THREE.Vector3()))],
    };
    this.suspTravel = 0.29;

    // ---- spinning parts: fans and main wheels (rotate about their own axis)
    this.fans = ['engine_blades_spinning_1', 'engine_blades_spinning_2', 'engine_blades_1', 'engine_blades_2'].map(N).filter(Boolean)
      .map(o => ({ o, base: o.quaternion.clone(), axis: this.localAxis(o, new THREE.Vector3(0, 0, 1)) }));
    this.mainWheels = [[bl === ba ? mainA : mainB, 1], [bl === ba ? mainB : mainA, 2]]
      .map(([o, gi]) => ({ o, gi, base: o.quaternion.clone(), axis: this.localAxis(o, new THREE.Vector3(1, 0, 0)) }));
    this.captain = N('captain_head');

    // ---- lights: replace glTF punctual lights by glow sprites
    this.lights = [];
    for (const l of this.lightInfo) {
      const n = l.name.toLowerCase();
      let type = null, color = new THREE.Color(1, 1, 1), size = 1.6;
      if (n.includes('beacon')) { type = 'beacon'; color.setRGB(1, 0.1, 0.05); size = 2.2; }
      else if (n.includes('strobe')) { type = n.includes('tail') ? 'tailstrobe' : 'strobe'; size = 3.5; }
      else if (n.includes('navlight')) {
        if (n.includes('aft')) { type = 'nav'; }
        else if (n.includes('left')) { type = 'nav'; color.setRGB(1, 0.12, 0.08); }
        else { type = 'nav'; color.setRGB(0.15, 1, 0.3); }
        size = 1.4;
      } else if (n.includes('landing')) { type = 'landing'; size = 3.0; color.setRGB(1, 0.97, 0.9); }
      if (!type) continue;
      const mat = new THREE.SpriteMaterial({ map: GLOW, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true });
      const sp = new THREE.Sprite(mat);
      // sprites must not inherit the node scale
      const ws = l.node.getWorldScale(new THREE.Vector3());
      sp.userData = { type, size, inv: 1 / Math.max(ws.x, 1e-6) };
      sp.scale.setScalar(size * sp.userData.inv);
      l.node.add(sp);
      this.lights.push(sp);
    }
    this.time = 0;

    // ---- live reflection probe: a cube camera at the aircraft captures the real surroundings
    // (runway, terrain, clouds, sky); three.js turns it into a prefiltered env map (PMREM).
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.cubeCam = new THREE.CubeCamera(0.5, 160000, this.cubeRT);
    this.reflectTimer = 1e9;
    this.reflections = true;
    this.setReflections(true);
    return this;
  }

  /** Axis given in model space, expressed in the object's local (pre-rotation) frame. */
  localAxis(obj, modelAxis) {
    const parentQ = new THREE.Quaternion();
    obj.parent.getWorldQuaternion(parentQ);
    const modelQ = new THREE.Quaternion(); this.model.getWorldQuaternion(modelQ);
    // axis in world = modelQ * modelAxis ; in parent space = parentQ^-1 * world; in object local = base^-1 * that
    const a = modelAxis.clone().applyQuaternion(modelQ).applyQuaternion(parentQ.invert());
    return a.applyQuaternion(obj.quaternion.clone().invert()).normalize();
  }

  setAnim(name, t01) {
    const a = this.actions[name];
    if (!a) return;
    // t01 = 1 must land exactly on the last key (STEP visibility tracks would otherwise stay hidden)
    a.time = Math.min(Math.max(t01, 0), 1) * a.getClip().duration;
  }

  setReflections(on) {
    this.reflections = on;
    for (const m of this.materials) { if ('envMap' in m) { m.envMap = on ? this.cubeRT.texture : null; m.needsUpdate = true; } }
  }

  /** Re-captures the environment around the aircraft a few times per second. */
  updateReflections(dt, renderer, scene) {
    if (!this.reflections) return;
    this.reflectTimer += dt;
    if (this.reflectTimer < 0.3) return;
    this.reflectTimer = 0;
    const vis = this.group.visible;
    this.group.visible = false;                         // don't reflect ourselves
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;              // reuse this frame's shadow map
    this.group.getWorldPosition(this.cubeCam.position);
    this.cubeCam.update(renderer, scene);
    renderer.shadowMap.autoUpdate = shadowAuto;
    this.group.visible = vis;
  }

  update(dt, fm, { cockpitView = false } = {}) {
    this.time += dt;
    const s = fm.surf;
    // control surfaces (signs verified visually)
    this.setAnim('LeftAileron', 0.5 + 0.5 * s.aileron);   // t=1 -> trailing edge down
    this.setAnim('RightAileron', 0.5 - 0.5 * s.aileron);
    this.setAnim('Elevator', 0.5 - 0.5 * s.elevator);
    this.setAnim('Rudder', 0.5 - 0.5 * s.rudder);
    this.setAnim('LeftFlap', fm.flapPos / 40);
    this.setAnim('RightFlap', fm.flapPos / 40);
    this.setAnim('leftslats', fm.slatPos);
    this.setAnim('rightslats', fm.slatPos);
    this.setAnim('Spoilers', fm.spoilerPos);
    this.setAnim('Reverse', fm.reverserPos);
    this.setAnim('LandingGear', 1 - fm.gearPos);
    const flex = fm.onGround ? 0.05 : THREE.MathUtils.clamp(0.5 * fm.nz, 0, 1);
    this.setAnim('WingFlexLeft', flex); this.setAnim('WingFlexRight', flex);
    this.setAnim('wheel-steering-0', 0.5 + 0.5 * THREE.MathUtils.clamp(fm.steerDeg / 61, -1, 1));
    ['wheel-suspension-0', 'wheel-suspension-1', 'wheel-suspension-2'].forEach((n, i) =>
      this.setAnim(n, 1 - fm.compression[i] / this.suspTravel));
    const spin = ((-fm.wheelSpin[0] / (2 * Math.PI)) % 1 + 1) % 1;
    this.setAnim('wheel-spinning-0', spin);
    this.mixer.update(0);

    for (const w of this.mainWheels) {
      w.o.quaternion.copy(w.base).multiply(new THREE.Quaternion().setFromAxisAngle(w.axis, -fm.wheelSpin[w.gi]));
    }
    // fans: N1 100% ~ 5175 rpm; render a slowed, aliasing-friendly rate
    this.fanAngle = (this.fanAngle || 0) + dt * (fm.n1[0] / 100) * 38;
    for (const f of this.fans) f.o.quaternion.copy(f.base).multiply(new THREE.Quaternion().setFromAxisAngle(f.axis, this.fanAngle));
    if (this.captain) this.captain.visible = !cockpitView;

    // lights
    const t = this.time;
    for (const sp of this.lights) {
      const u = sp.userData;
      let on = 1;
      if (u.type === 'beacon') on = (t % 1.1) < 0.12 ? 1 : 0.05;
      else if (u.type === 'strobe') { const p = t % 1.3; on = (p < 0.05 || (p > 0.15 && p < 0.2)) ? 1 : 0; }
      else if (u.type === 'tailstrobe') on = (t % 1.3) < 0.05 ? 1 : 0;
      else if (u.type === 'landing') on = (fm.gearPos > 0.5 && fm.pos.y < 3500) ? 1 : 0;
      sp.visible = on > 0.01;
      sp.material.opacity = on;
      sp.scale.setScalar(u.size * u.inv * (u.type.includes('strobe') ? 1.6 : 1));
    }
  }
}
