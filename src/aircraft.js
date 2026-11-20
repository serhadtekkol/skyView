import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { calibrate } from './calibrate.js';

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

/** Spins `node` about an axis (given in model space) through its own bounding-box centre. */
function makePivot(model, node, modelAxis) {
  const parent = node.parent;
  const c = new THREE.Box3().setFromObject(node, true).getCenter(new THREE.Vector3());
  const pivot = new THREE.Object3D();
  pivot.name = node.name + '_pivot';
  pivot.position.copy(parent.worldToLocal(c.clone()));
  parent.add(pivot);
  pivot.updateMatrixWorld(true);
  pivot.attach(node);
  const pq = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  const mq = model.getWorldQuaternion(new THREE.Quaternion());
  const axis = modelAxis.clone().applyQuaternion(mq).applyQuaternion(pq).normalize();
  return { pivot, axis };
}

function wrap01(x) { return ((x % 1) + 1) % 1; }

/** Parked aircraft: materials + a gear-down static pose. */
export async function loadStatic(url, type = {}, { shadows = true } = {}) {
  const gltf = await loader.loadAsync(url);
  stripLights(gltf.scene);
  fixMaterials(gltf.scene, { shadows });
  const cal = calibrate(gltf, type);
  cal.eval();
  return gltf.scene;
}

export class Aircraft {
  async load(url, type = {}, onProgress) {
    const gltf = await loader.loadAsync(url, e => onProgress?.(e.total ? e.loaded / e.total : 0));
    this.type = type;
    this.model = gltf.scene;
    this.lightInfo = stripLights(this.model);
    this.materials = fixMaterials(this.model);
    const cal = this.cal = calibrate(gltf, type);
    this.mixer = cal.mixer; this.actions = cal.actions;

    // CG-centred group
    this.group = new THREE.Group();
    this.model.position.copy(cal.cg).negate();
    this.group.add(this.model);
    this.model.updateMatrixWorld(true);

    // ---- gear points for the flight model: ~7.5% of the weight on the nose gear, rest shared
    const mass = type.mass || 66000, W = mass * 9.81;
    const mains = cal.groups.filter(g => !g.nose);
    const gear = cal.groups.map(g => {
      const share = g.nose ? 0.075 : 0.925 / mains.length;
      const k = share * W / 0.15;
      return { name: g.nose ? 'nose' : 'main' + g.i, p: cal.rel(g.contact), k, c: 2 * 0.55 * Math.sqrt(k * share * mass),
        steer: g.nose, brake: !g.nose, radius: g.radius, group: g };
    });
    this.geometry = { cg: cal.cg, gear, hard: cal.hard, cockpit: cal.cockpit, length: cal.length, span: cal.span, engines: cal.engines };

    // ---- spinning parts
    const C = cal.clips;
    this.fanPivots = [];
    if (!C.engSpin.length) {
      const fans = [];
      this.model.traverse(o => {
        if (/blades|fan_(spin|static)|fan_spining|spinner/i.test(o.name) && !/cpu|pitch_lever/i.test(o.name)) fans.push(o);
      });
      // only outermost matches (a blade group and its child mesh would double-spin)
      const top = fans.filter(o => !fans.some(p => p !== o && p.getObjectById(o.id)));
      for (const o of top) {
        if (!new THREE.Box3().setFromObject(o, true).isEmpty()) this.fanPivots.push(makePivot(this.model, o, new THREE.Vector3(0, 0, 1)));
      }
    }
    this.wheelPivots = [];
    gear.forEach((g, gi) => {
      if (g.group.spin) return;
      let w = null;
      g.group.node.traverse(o => {
        if (!w && o !== g.group.node && /wheel|tire|tyre/i.test(o.name) && !/well|pant|door|leg|bay/i.test(o.name)) w = o;
      });
      if (!w && /wheel/i.test(g.group.node.name)) w = g.group.node;
      if (w) this.wheelPivots.push({ gi, ...makePivot(this.model, w, new THREE.Vector3(1, 0, 0)) });
    });
    this.pilots = [];
    this.model.traverse(o => { if (/captain|first_?officer|pilot_head|copilot/i.test(o.name)) this.pilots.push(o); });

    // ---- lights: replace glTF punctual lights by glow sprites
    this.lights = [];
    for (const l of this.lightInfo) {
      const n = l.name.toLowerCase();
      let kind = null; const color = new THREE.Color(1, 1, 1); let size = 1.6;
      if (n.includes('beacon')) { kind = 'beacon'; color.setRGB(1, 0.1, 0.05); size = 2.2; }
      else if (n.includes('strobe')) { kind = n.includes('tail') ? 'tailstrobe' : 'strobe'; size = 3.5; }
      else if (n.includes('navlight') || n.includes('nav_light')) {
        if (n.includes('aft') || n.includes('tail')) kind = 'nav';
        else if (n.includes('left') || n.includes('_lh')) { kind = 'nav'; color.setRGB(1, 0.12, 0.08); }
        else { kind = 'nav'; color.setRGB(0.15, 1, 0.3); }
        size = 1.4;
      } else if (n.includes('landing')) { kind = 'landing'; size = 3.0; color.setRGB(1, 0.97, 0.9); }
      if (!kind) continue;
      const mat = new THREE.SpriteMaterial({ map: GLOW, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true });
      const sp = new THREE.Sprite(mat);
      const ws = l.node.getWorldScale(new THREE.Vector3());
      sp.userData = { kind, size, inv: 1 / Math.max(Math.abs(ws.x), 1e-6) };
      sp.scale.setScalar(size * sp.userData.inv);
      l.node.add(sp);
      this.lights.push(sp);
    }
    this.time = 0; this.fanAngle = 0;
    // real landing / taxi light: a spot from the nose pointing ahead and down (night only)
    const nose = gear.find(g => g.steer)?.p || new THREE.Vector3(0, -2, -0.4 * cal.length);
    this.spot = new THREE.SpotLight(0xfff1dd, 0, 1600, 0.3, 0.6, 2);
    this.spot.position.set(0, nose.y + 1.2, nose.z - 0.5);
    this.spot.target.position.set(0, nose.y - 40, nose.z - 260);
    this.group.add(this.spot, this.spot.target);
    this.nightK = 0;

    // ---- live reflection probe
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.cubeCam = new THREE.CubeCamera(0.5, 160000, this.cubeRT);
    this.reflectTimer = 1e9;
    this.reflections = true;
    this.interior = false;
    this.materials.forEach(m => { m.userData.base = { cc: m.clearcoat, ei: m.envMapIntensity, op: m.opacity, r: m.roughness }; });
    this.setReflections(true);
    return this;
  }

  set(name, t) { if (name) this.cal.set(name, t); }

  setReflections(on) {
    this.reflections = on;
    const env = on && !this.interior ? this.cubeRT.texture : null;
    for (const m of this.materials) { if ('envMap' in m) { m.envMap = env; m.needsUpdate = true; } }
  }

  /** Inside the cockpit: no exterior reflections / clear-coat glare on the inner faces. */
  setInterior(on) {
    if (on === this.interior) return;
    this.interior = on;
    for (const m of this.materials) {
      const b = m.userData.base; if (!b) continue;
      if (on) {
        if (m.clearcoat !== undefined) m.clearcoat = 0;
        if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.15;
        if (m.roughness !== undefined && /paint|metal|fan|hot/.test(m.name)) m.roughness = Math.max(b.r, 0.85);
        if (/glass/.test(m.name)) m.opacity = 0.08;
      } else {
        if (b.cc !== undefined) m.clearcoat = b.cc;
        if (b.ei !== undefined) m.envMapIntensity = b.ei;
        if (b.r !== undefined) m.roughness = b.r;
        if (b.op !== undefined) m.opacity = b.op;
      }
    }
    this.setReflections(this.reflections);
  }

  updateReflections(dt, renderer, scene) {
    if (!this.reflections || this.interior) return;
    this.reflectTimer += dt;
    if (this.reflectTimer < 0.3) return;
    this.reflectTimer = 0;
    const vis = this.group.visible;
    this.group.visible = false;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.group.getWorldPosition(this.cubeCam.position);
    this.cubeCam.update(renderer, scene);
    renderer.shadowMap.autoUpdate = shadowAuto;
    this.group.visible = vis;
  }

  update(dt, fm, { cockpitView = false } = {}) {
    this.time += dt;
    this.setInterior(cockpitView);
    const s = fm.surf, C = this.cal.clips, S = this.cal.sign;
    const dir = (at) => (at ? 1 : -1);
    this.set(C.ailL, 0.5 + 0.5 * s.aileron * dir(S.ailLDownAt));     // roll right: left aileron down
    this.set(C.ailR, 0.5 - 0.5 * s.aileron * dir(S.ailRDownAt));     //             right aileron up
    this.set(C.elev, 0.5 + 0.5 * s.elevator * dir(S.elevUpAt));      // pull: trailing edge up
    this.set(C.rud, 0.5 + 0.5 * s.rudder * dir(S.rudRightAt));       // right pedal: trailing edge right
    this.set(C.flapL, fm.flapPos / 40); this.set(C.flapR, fm.flapPos / 40);
    C.slats.forEach(n => this.set(n, fm.slatPos));
    this.set(C.spoil, fm.spoilerPos);
    this.set(C.rev, fm.reverserPos);
    this.set(C.gear, S.gearDownAt ? fm.gearPos : 1 - fm.gearPos);
    const flex = fm.onGround ? 0.05 : THREE.MathUtils.clamp(0.5 * fm.nz, 0, 1);
    this.set(C.flexL, flex); this.set(C.flexR, flex);
    if (C.steer) this.set(C.steer, 0.5 + 0.5 * THREE.MathUtils.clamp(fm.steerDeg / (S.steerRange || 60), -1, 1) * dir(S.steerRightAt));
    this.geometry.gear.forEach((g, i) => {
      const grp = g.group;
      if (grp.susp) { const c = Math.min(1, (fm.compression[i] || 0) / grp.travel); this.set(grp.susp, grp.extendedAt ? 1 - c : c); }
      if (grp.spin) this.set(grp.spin, wrap01(-(fm.wheelSpin[i] || 0) / (2 * Math.PI)));
    });
    // fans: slowed, aliasing-friendly rate
    const n1 = fm.n1.reduce((a, b) => a + b, 0) / fm.n1.length;
    this.fanAngle += dt * (n1 / 100) * 38;
    C.engSpin.forEach(n => this.set(n, wrap01(this.fanAngle / (2 * Math.PI))));
    this.mixer.update(0);
    for (const f of this.fanPivots) f.pivot.quaternion.setFromAxisAngle(f.axis, this.fanAngle);
    for (const w of this.wheelPivots) w.pivot.quaternion.setFromAxisAngle(w.axis, -(fm.wheelSpin[w.gi] || 0));
    for (const p of this.pilots) p.visible = !cockpitView;

    const landingOn = fm.gearPos > 0.5 && fm.agl < 3000;
    this.spot.intensity = landingOn ? 30000 * this.nightK : 0;
    const t = this.time;
    for (const sp of this.lights) {
      const u = sp.userData;
      let on = 1;
      if (u.kind === 'beacon') on = (t % 1.1) < 0.12 ? 1 : 0.05;
      else if (u.kind === 'strobe') { const p = t % 1.3; on = (p < 0.05 || (p > 0.15 && p < 0.2)) ? 1 : 0; }
      else if (u.kind === 'tailstrobe') on = (t % 1.3) < 0.05 ? 1 : 0;
      else if (u.kind === 'landing') on = (fm.gearPos > 0.5 && fm.agl < 3000) ? 1 : 0;
      sp.visible = on > 0.01 && !(cockpitView && u.kind !== 'landing');
      sp.material.opacity = on;
      sp.scale.setScalar(u.size * u.inv * (u.kind.includes('strobe') ? 1.6 : 1));
    }
  }
}
