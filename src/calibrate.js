import * as THREE from 'three';

// Automatic rig calibration for the airliner glTF models.  Works out, from the geometry itself:
// which end of each clip is "gear down", "trailing edge down", "rudder right", "suspension
// extended", "nose-wheel right"; the wheel groups and their ground contact points; engines,
// tail, wing tips, belly and cockpit positions; and a rest pose for every other clip.
// No DOM use: runs in the browser and in Node tests.

const box = (o) => new THREE.Box3().setFromObject(o, true);
const center = (o) => box(o).getCenter(new THREE.Vector3());

export function calibrate(gltf, type = {}) {
  const root = gltf.scene;
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play(); a.paused = true;
    actions[clip.name] = a;
  }
  const has = (n) => !!actions[n];
  const set = (n, t) => { const a = actions[n]; if (a) a.time = Math.min(Math.max(t, 0), 1) * a.getClip().duration; };
  const eval_ = () => { mixer.update(0); root.updateMatrixWorld(true); };
  const targets = (clipName) => {
    const clip = actions[clipName]?.getClip(); if (!clip) return [];
    const names = [...new Set(clip.tracks.map(t => t.name.slice(0, t.name.lastIndexOf('.'))))];
    return names.map(n => root.getObjectByName(n)).filter(Boolean);
  };
  const isVisibility = (clip) => clip.tracks.length > 0 && clip.tracks.every(t => t.name.endsWith('.scale'));

  // ---------- rest pose: snapshot node transforms before any clip is applied
  root.updateMatrixWorld(true);
  const rest = new Map();
  root.traverse(o => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  const poseDiff = (nodes) => {
    let d = 0;
    for (const o of nodes) {
      const r = rest.get(o); if (!r) continue;
      d += o.position.distanceTo(r.p) + (1 - Math.abs(o.quaternion.dot(r.q))) * 10 + o.scale.distanceTo(r.s);
    }
    return d;
  };

  // ---------- classify clips
  const C = {};
  const find = (re) => Object.keys(actions).find(n => re.test(n));
  C.gear = find(/^LandingGear$/i);
  C.ailL = find(/^LeftAileron$/i); C.ailR = find(/^RightAileron$/i);
  C.elev = find(/^Elevator$/i); C.rud = find(/^Rudder$/i);
  C.flapL = find(/^LeftFlap$/i); C.flapR = find(/^RightFlap$/i);
  C.spoil = find(/^Spoilers$/i); C.rev = find(/^Reverse$/i);
  C.flexL = find(/^WingFlexLeft$/i); C.flexR = find(/^WingFlexRight$/i);
  C.steer = find(/^wheel-steering-0$/i);
  C.slats = Object.keys(actions).filter(n => /slat/i.test(n));
  C.engSpin = Object.keys(actions).filter(n => /^engine-spin-\d+$/i.test(n)).sort();
  const susp = {}, spin = {};
  for (const n of Object.keys(actions)) {
    let m = n.match(/^wheel-suspension-(\d+)$/i); if (m) susp[+m[1]] = n;
    m = n.match(/^wheel-spinning-(\d+)$/i); if (m) spin[+m[1]] = n;
  }
  const known = new Set([C.gear, C.ailL, C.ailR, C.elev, C.rud, C.flapL, C.flapR, C.spoil, C.rev, C.flexL, C.flexR, C.steer,
    ...C.slats, ...C.engSpin, ...Object.values(susp), ...Object.values(spin)].filter(Boolean));

  // ---------- neutral starting pose
  const vis = [];
  for (const [n, a] of Object.entries(actions)) {
    const clip = a.getClip();
    if (isVisibility(clip)) { vis.push(n); continue; }
    if (known.has(n)) continue;
    // other clips (doors, windows, wipers, cockpit levers...): pick the time matching the rest pose
    const nodes = targets(n);
    let best = 0, bd = Infinity;
    for (const t of [0, 0.5, 1]) { set(n, t); eval_(); const d = poseDiff(nodes); if (d < bd - 1e-6) { bd = d; best = t; } }
    set(n, best);
  }
  // visibility variants: explicit list from the type config, otherwise the first of each family
  const show = new Set(type.show || []);
  let shownAuto = false;
  for (const n of vis) {
    const pilot = /captain|first officer|^visibility-fo$|pilot/i.test(n);
    let on;
    if (pilot) on = true;
    else if (type.show) on = show.has(n);
    else { on = !shownAuto; shownAuto = true; }
    set(n, on ? 1 : 0);
  }
  [C.ailL, C.ailR, C.elev, C.rud, C.steer].forEach(n => n && set(n, 0.5));
  [C.flapL, C.flapR, C.spoil, C.rev, ...C.slats, C.flexL, C.flexR].forEach(n => n && set(n, 0));
  eval_();

  // ---------- sign calibration
  const sign = {};
  const measure = (clip, fn) => { set(clip, 0); eval_(); const a = fn(); set(clip, 1); eval_(); const b = fn(); set(clip, 0.5); eval_(); return [a, b]; };
  const centroid = (nodes, axis) => nodes.reduce((s, o) => s + center(o)[axis], 0) / Math.max(nodes.length, 1);
  if (C.ailL) { const t = targets(C.ailL); const [a, b] = measure(C.ailL, () => centroid(t, 'y')); sign.ailLDownAt = b < a ? 1 : 0; }
  if (C.ailR) { const t = targets(C.ailR); const [a, b] = measure(C.ailR, () => centroid(t, 'y')); sign.ailRDownAt = b < a ? 1 : 0; }
  if (C.elev) { const t = targets(C.elev); const [a, b] = measure(C.elev, () => centroid(t, 'y')); sign.elevUpAt = b > a ? 1 : 0; }
  if (C.rud) { const t = targets(C.rud); const [a, b] = measure(C.rud, () => centroid(t, 'x')); sign.rudRightAt = b > a ? 1 : 0; }
  if (C.steer) {
    const t = targets(C.steer)[0];
    const fwd = () => new THREE.Vector3(0, 0, -1).applyQuaternion(t.getWorldQuaternion(new THREE.Quaternion())).x;
    const [a, b] = measure(C.steer, fwd);
    sign.steerRightAt = b > a ? 1 : 0;
    // full deflection angle of the clip (degrees, each side)
    set(C.steer, 1); eval_(); const q1 = t.getWorldQuaternion(new THREE.Quaternion());
    set(C.steer, 0.5); eval_(); const q5 = t.getWorldQuaternion(new THREE.Quaternion());
    sign.steerRange = Math.max(5, q1.angleTo(q5) * 180 / Math.PI);
  }

  // ---------- wheel groups
  const groupIds = [...new Set([...Object.keys(susp), ...Object.keys(spin)].map(Number))].sort((a, b) => a - b);
  const hasGeom = (o) => o && !box(o).isEmpty();
  const groups = groupIds.map(i => {
    const wheel = spin[i] ? targets(spin[i])[0] : null;
    const sNode = susp[i] ? targets(susp[i])[0] : null;
    return { i, susp: susp[i] || null, spin: spin[i] || null, node: hasGeom(wheel) ? wheel : hasGeom(sNode) ? sNode : null };
  }).filter(g => g.node);
  if (!groups.length) {   // fallback: wheels by name
    let k = 0;
    root.traverse(o => { if (/wheel/i.test(o.name) && !/well|pant|door|bay/i.test(o.name) && o.children.length + (o.isMesh ? 1 : 0)) groups.push({ i: k++, susp: null, spin: null, node: o }); });
  }
  const lowest = (o) => box(o).min.y;

  // gear down: the end of the LandingGear clip where the wheels hang lowest
  if (C.gear) {
    set(C.gear, 0); eval_(); const a = Math.min(...groups.map(g => lowest(g.node)));
    set(C.gear, 1); eval_(); const b = Math.min(...groups.map(g => lowest(g.node)));
    sign.gearDownAt = a < b ? 0 : 1;
    set(C.gear, sign.gearDownAt);
  } else sign.gearDownAt = 0;
  // suspension: extended end + travel per group
  for (const g of groups) {
    if (!g.susp) { g.extendedAt = 1; g.travel = 0.25; continue; }
    set(g.susp, 0); eval_(); const a = lowest(g.node);
    set(g.susp, 1); eval_(); const b = lowest(g.node);
    g.extendedAt = b < a ? 1 : 0; g.travel = Math.min(0.6, Math.max(0.08, Math.abs(a - b)));
  }
  groups.forEach(g => g.susp && set(g.susp, g.extendedAt));
  eval_();

  const whole = box(root);
  const L = whole.max.z - whole.min.z;
  for (const g of groups) {
    const b = box(g.node);
    g.contact = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
    g.radius = Math.max(0.2, (b.max.y - b.min.y) / 2);
  }
  const noseG = groups.reduce((m, g) => (g.contact.z < m.contact.z ? g : m), groups[0]);
  groups.forEach(g => { g.nose = g === noseG; });
  const mains = groups.filter(g => !g.nose);
  const mainZ = mains.reduce((s, g) => s + g.contact.z, 0) / Math.max(mains.length, 1);
  const cg = new THREE.Vector3(0, 0, mainZ - 0.075 * (mainZ - noseG.contact.z));

  // ---------- body, engines, tips, cockpit
  const gearNodes = new Set();
  groups.forEach(g => g.node.traverse(o => gearNodes.add(o)));
  if (C.gear) targets(C.gear).forEach(n => n.traverse(o => gearNodes.add(o)));
  const engines = [];
  // fuselage profile by vertical ray casts on the centreline (independent of mesh density)
  const body = [];
  root.traverse(o => {
    if (!o.isMesh || gearNodes.has(o) || !o.visible) return;
    for (let p = o; p; p = p.parent) if (p.scale.x === 0 || p.scale.y === 0) return;
    body.push(o);
  });
  const rc = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0), down = new THREE.Vector3(0, -1, 0);
  const section = (z) => {
    for (const x of [0, 0.25, -0.25, 0.6]) {
      rc.set(new THREE.Vector3(x, whole.min.y - 20, z), up); rc.far = 1e4;
      const lo = rc.intersectObjects(body, false)[0];
      rc.set(new THREE.Vector3(x, whole.max.y + 20, z), down);
      const hi = rc.intersectObjects(body, false)[0];
      if (lo && hi) return { lo: lo.point.y, hi: hi.point.y, ok: hi.point.y > lo.point.y };
    }
    return { lo: whole.min.y, hi: whole.min.y + 0.1 * L, ok: false };
  };
  const zFwd = noseG.contact.z + 0.09 * L;
  const sec = section(zFwd);
  const diam = Math.min(Math.max(sec.hi - sec.lo, 0.05 * L), 0.14 * L);
  const fus = new THREE.Box3(new THREE.Vector3(-diam / 2, sec.lo, whole.min.z), new THREE.Vector3(diam / 2, sec.lo + diam, whole.max.z));
  const bottomAt = (z) => { const r = section(z); return r.ok ? r.lo : fus.min.y; };
  // engines: nacelles, fans or blades away from the centreline
  const engRe = type.engineRe || /engine(?!_pylon|.*pylon|.*cone|.*disk|.*revers)|nacelle|fan_(static|spin)|blades/i;
  const engBoxes = [];
  root.traverse(o => {
    if (!engRe.test(o.name) || gearNodes.has(o) || /cpu|pylon|reverse|revers/i.test(o.name)) return;
    const b = box(o); if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    if (Math.abs(c.x) < 1.5 || Math.max(s.y, s.z) < 0.8 || s.z > 0.4 * L) return;
    // a fan disc alone: grow it to an approximate nacelle
    if (s.z < 0.6 * s.y) { b.expandByVector(new THREE.Vector3(s.x * 0.08, s.y * 0.1, 0)); b.max.z += s.y * 1.6; }
    engBoxes.push(b);
  });
  // merge overlapping boxes into one per engine
  for (const b of engBoxes) {
    const e = engines.find(x => x.intersectsBox(b));
    if (e) e.union(b); else engines.push(b.clone());
  }
  engines.sort((a, b) => a.getCenter(new THREE.Vector3()).x - b.getCenter(new THREE.Vector3()).x);

  let tipL = new THREE.Vector3(whole.min.x + 0.3, fus.min.y + diam * 0.3, mainZ), tipR = tipL.clone().setX(-tipL.x);
  root.traverse(o => {
    if (!o.isMesh || gearNodes.has(o)) return;
    const b = box(o);
    if (b.min.x <= whole.min.x + 0.05) tipL = new THREE.Vector3(b.min.x + 0.2, b.min.y, (b.min.z + b.max.z) / 2);
    if (b.max.x >= whole.max.x - 0.05) tipR = new THREE.Vector3(b.max.x - 0.2, b.min.y, (b.min.z + b.max.z) / 2);
  });

  const capNode = root.getObjectByName('captain_head') || (vis.find(n => /captain/i.test(n)) && targets(vis.find(n => /captain/i.test(n)))[0]);
  let cockpit;
  if (capNode) { const c = center(capNode); cockpit = new THREE.Vector3(c.x, c.y + 0.12, c.z + 0.15); }
  else {
    const z = whole.min.z + Math.max(1.8, 0.075 * L), s = section(z);
    cockpit = new THREE.Vector3(-0.45, s.ok ? s.lo + 0.68 * (s.hi - s.lo) : fus.min.y + diam * 0.7, z + 0.3);
  }

  const rel = (v) => v.clone().sub(cg);
  const tailZ = whole.max.z - 0.18 * L;
  const hard = [
    { name: 'tail', label: 'kuyruk', p: rel(new THREE.Vector3(0, bottomAt(tailZ) + 0.05, tailZ)), fatal: false },
    ...engines.map((b, i) => ({ name: 'eng' + i, label: (b.getCenter(new THREE.Vector3()).x < 0 ? 'sol' : 'sağ') + ' motor',
      p: rel(new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2)), fatal: true })),
    { name: 'tipL', label: 'sol kanat ucu', p: rel(tipL), fatal: true },
    { name: 'tipR', label: 'sağ kanat ucu', p: rel(tipR), fatal: true },
    { name: 'belly', label: 'gövde', p: rel(new THREE.Vector3(0, bottomAt((mainZ + noseG.contact.z) / 2) + 0.1, (mainZ + noseG.contact.z) / 2)), fatal: true },
    { name: 'belly', label: 'gövde', p: rel(new THREE.Vector3(0, bottomAt(mainZ - 0.05 * L) + 0.15, mainZ - 0.05 * L)), fatal: true },
  ];

  return {
    mixer, actions, clips: C, sign, set, eval: eval_,
    groups, cg, rel, hard, cockpit: rel(cockpit), length: L, span: whole.max.x - whole.min.x,
    engines: engines.map(b => rel(b.getCenter(new THREE.Vector3()))), engineBoxes: engines,
    fuselage: fus, diam, whole,
  };
}
