import * as THREE from 'three';
import { LANDMARKS } from './landmarks.js';

const D2R = Math.PI / 180;

// Procedural real-scale 3D landmarks with night illumination, spawned dynamically within 120 km.
// Bridges span across water at y = 0; land monuments snap to terrain height as DEM tiles load.

function matStd(color, { rough = 0.65, metal = 0.15, emissive = 0x000000, emInt = 0 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: emInt });
  return m;
}

/** Suspension / cable-stayed bridge (Bosphorus, Osmangazi, 1915 Çanakkale, Golden Gate). */
function buildSuspensionBridge({ span = 1074, totalLen = 1560, deckW = 34, deckH = 64, towerH = 165, towerColor = 0xdce3ec, deckColor = 0x3b424c, ledColor = 0xff4080, aFrame = false, redWhite = false }) {
  const g = new THREE.Group();
  const nightMats = [];
  const halfSpan = span / 2;
  const tMat = matStd(towerColor, { rough: 0.45, metal: 0.45 });
  const redMat = redWhite ? matStd(0xc82828, { rough: 0.45, metal: 0.35 }) : tMat;
  const dMat = matStd(deckColor, { rough: 0.75, metal: 0.25 });
  const cMat = matStd(0x8894a2, { rough: 0.5, metal: 0.6 });
  const ledMat = new THREE.MeshStandardMaterial({ color: ledColor, emissive: ledColor, emissiveIntensity: 0, roughness: 0.3 });
  nightMats.push({ mat: ledMat, max: 2.2 });
  const roadGlow = new THREE.MeshStandardMaterial({ color: 0xffd78a, emissive: 0xffc864, emissiveIntensity: 0, roughness: 0.3 });
  nightMats.push({ mat: roadGlow, max: 1.8 });

  // Roadway deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 3.8, totalLen), dMat);
  deck.position.y = deckH;
  g.add(deck);
  // Subtle glowing road light strips along both deck edges at night
  for (const sx of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, totalLen * 0.98), roadGlow);
    strip.position.set(sx * (deckW * 0.48), deckH + 2.4, 0);
    g.add(strip);
  }

  // Twin main towers at z = ±halfSpan
  const legSep = deckW * 0.54;
  for (const sz of [-1, 1]) {
    const tz = sz * halfSpan;
    // Concrete pier base in water
    const pier = new THREE.Mesh(new THREE.BoxGeometry(deckW * 1.25, 16, 22), matStd(0x8d9399, { rough: 0.9, metal: 0 }));
    pier.position.set(0, 6, tz);
    g.add(pier);

    for (const sx of [-1, 1]) {
      if (aFrame) {
        // Tapered A-frame legs (Yavuz Sultan Selim style)
        const leg = new THREE.Mesh(new THREE.BoxGeometry(6.5, towerH, 8.5), tMat);
        leg.position.set(sx * (legSep * 0.55), towerH / 2, tz);
        leg.rotation.z = sx * 0.085;
        g.add(leg);
      } else {
        // Classic H-frame legs (with red-white bands if 1915 Çanakkale)
        const segs = redWhite ? 4 : 1;
        const sh = towerH / segs;
        for (let k = 0; k < segs; k++) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(6.2, sh, 8.0), (redWhite && k % 2 === 0) ? redMat : tMat);
          leg.position.set(sx * legSep, k * sh + sh / 2, tz);
          g.add(leg);
        }
      }
      // Aviation warning light at tower tip
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 8), ledMat);
      beacon.position.set(sx * (aFrame ? 4 : legSep), towerH + 2, tz);
      g.add(beacon);
    }
    // Crossbeams
    for (const frac of aFrame ? [0.22, 0.52, 0.82] : [0.36, 0.68, 0.95]) {
      const bw = aFrame ? legSep * 2 * (1 - frac * 0.72) : legSep * 2;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(bw, 5.2, 6.2), redWhite && frac > 0.8 ? redMat : tMat);
      beam.position.set(0, towerH * frac, tz);
      g.add(beam);
    }
  }

  // Main catenary cables + vertical suspender cables (both sides of deck)
  const sag = towerH - deckH - 8;
  for (const sx of [-1, 1]) {
    const cx = sx * (aFrame ? deckW * 0.46 : legSep);
    const pts = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const z = -totalLen / 2 + u * totalLen;
      let y;
      if (Math.abs(z) <= halfSpan) {
        const f = z / halfSpan; // -1..1
        y = deckH + 8 + sag * f * f;
      } else {
        const f = Math.min(1, (Math.abs(z) - halfSpan) / (totalLen / 2 - halfSpan));
        y = towerH - (towerH - deckH) * Math.pow(f, 0.85);
      }
      pts.push(new THREE.Vector3(cx, y, z));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 36, 1.15, 6, false), cMat);
    g.add(cable);
    const cableLed = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.55, 4, false), ledMat);
    cableLed.position.y = 0.8;
    g.add(cableLed);

    // Vertical suspenders along main span
    for (let k = -10; k <= 10; k++) {
      const z = (k / 11) * halfSpan;
      const f = z / halfSpan;
      const topY = deckH + 8 + sag * f * f;
      const len = topY - deckH;
      if (len < 3) continue;
      const susp = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, len, 4), cMat);
      susp.position.set(cx, deckH + len / 2, z);
      g.add(susp);
    }
  }
  return { group: g, nightMats, onWater: true };
}

/** Anıtkabir (Ankara) — Ceremonial plaza, grand steps, and colonnaded Hall of Honor (Şeref Holü). */
function buildAnitkabir() {
  const g = new THREE.Group();
  const nightMats = [];
  const trav = matStd(0xd8c7a8, { rough: 0.78, metal: 0.05 });
  const warmStone = matStd(0xc6b18f, { rough: 0.82, metal: 0.05 });
  const floodMat = new THREE.MeshStandardMaterial({ color: 0xffe4b0, emissive: 0xffc970, emissiveIntensity: 0, roughness: 0.4 });
  nightMats.push({ mat: floodMat, max: 1.5 });

  // Ceremonial Plaza (Tören Meydanı)
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(130, 3, 85), warmStone);
  plaza.position.set(0, 1.5, 48);
  g.add(plaza);
  // Surrounding arcade galleries
  for (const sx of [-1, 1]) {
    const gal = new THREE.Mesh(new THREE.BoxGeometry(9, 10, 82), trav);
    gal.position.set(sx * 64, 7, 48);
    g.add(gal);
  }
  // Elevated podium + grand staircase
  const podium = new THREE.Mesh(new THREE.BoxGeometry(82, 8, 62), warmStone);
  podium.position.set(0, 4, -18);
  g.add(podium);
  const stairs = new THREE.Mesh(new THREE.BoxGeometry(46, 5, 16), trav);
  stairs.position.set(0, 3.5, 18);
  g.add(stairs);

  // Hall of Honor (Şeref Holü) — 72m x 52m x 21m with surrounding monumental columns
  const hall = new THREE.Mesh(new THREE.BoxGeometry(50, 18, 34), trav);
  hall.position.set(0, 17, -20);
  g.add(hall);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(66, 3.2, 48), trav);
  roof.position.set(0, 27.2, -20);
  g.add(roof);
  // Colonnade pillars (8 front/back, 10 sides)
  const colGeo = new THREE.BoxGeometry(2.1, 17.5, 2.1);
  for (let i = 0; i < 8; i++) {
    const x = -28 + (i / 7) * 56;
    for (const z of [-42, 2]) {
      const col = new THREE.Mesh(colGeo, trav);
      col.position.set(x, 16.8, z);
      g.add(col);
    }
  }
  for (let j = 1; j < 7; j++) {
    const z = -42 + (j / 7) * 44;
    for (const x of [-28, 28]) {
      const col = new THREE.Mesh(colGeo, trav);
      col.position.set(x, 16.8, z);
      g.add(col);
    }
  }
  // Warm golden architectural floodlight strips at night
  const glow = new THREE.Mesh(new THREE.BoxGeometry(60, 1.2, 42), floodMat);
  glow.position.set(0, 8.6, -20);
  g.add(glow);

  return { group: g, nightMats, onWater: false };
}

/** Eiffel Tower (Paris) — 330 m lattice silhouette with 3 observation decks & golden night glow. */
function buildEiffel() {
  const g = new THREE.Group();
  const nightMats = [];
  const iron = matStd(0x6e5d4f, { rough: 0.6, metal: 0.55 });
  const goldGlow = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb338, emissiveIntensity: 0, roughness: 0.4 });
  nightMats.push({ mat: goldGlow, max: 1.7 });

  // 4 slanted corner legs from base (125m square) to 1st & 2nd decks
  const legGeo = new THREE.BoxGeometry(11, 130, 11);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, iron);
    leg.position.set(sx * 36, 56, sz * 36);
    leg.rotation.z = sx * 0.28;
    leg.rotation.x = -sz * 0.28;
    g.add(leg);
  }
  // 1st deck (57m) & 2nd deck (115m)
  const d1 = new THREE.Mesh(new THREE.BoxGeometry(72, 9, 72), iron); d1.position.y = 57; g.add(d1);
  const d2 = new THREE.Mesh(new THREE.BoxGeometry(42, 8, 42), iron); d2.position.y = 115; g.add(d2);
  // Upper tapered shaft (115m -> 285m)
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(7, 21, 170, 4), iron);
  shaft.rotation.y = Math.PI / 4; shaft.position.y = 200; g.add(shaft);
  // Top deck + spire (to 330m)
  const d3 = new THREE.Mesh(new THREE.BoxGeometry(16, 10, 16), iron); d3.position.y = 280; g.add(d3);
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 3.2, 46, 8), iron); spire.position.y = 307; g.add(spire);
  // Golden night illumination bands + summit beacon
  for (const [y, w] of [[57, 73], [115, 43], [280, 17]]) {
    const ring = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, w), goldGlow);
    ring.position.y = y; g.add(ring);
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 8), goldGlow);
  beacon.position.y = 331; g.add(beacon);

  return { group: g, nightMats, onWater: false };
}

/** Çamlıca Tower (Istanbul, 369m) or Atakule (Ankara, 125m). */
function buildModernTower(height = 369, tulip = true) {
  const g = new THREE.Group();
  const nightMats = [];
  const concrete = matStd(0xe4e8ee, { rough: 0.45, metal: 0.2 });
  const glass = matStd(0x28435c, { rough: 0.15, metal: 0.75 });
  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff3b30, emissiveIntensity: 0 });
  const podGlow = new THREE.MeshStandardMaterial({ color: 0x6ce0ff, emissive: 0x31d0ff, emissiveIntensity: 0 });
  nightMats.push({ mat: beaconMat, max: 2.8 }, { mat: podGlow, max: 1.6 });

  const shaftH = height * 0.62;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.024, height * 0.045, shaftH, 12), concrete);
  shaft.position.y = shaftH / 2; g.add(shaft);

  // Observation pod
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(height * (tulip ? 0.048 : 0.095), height * (tulip ? 0.036 : 0.065), height * (tulip ? 0.14 : 0.12), 16), glass);
  pod.position.y = shaftH; g.add(pod);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(height * (tulip ? 0.05 : 0.098), height * (tulip ? 0.05 : 0.098), 2.5, 16), podGlow);
  ring.position.y = shaftH; g.add(ring);

  // Mast spire
  const mastH = height * 0.34;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, height * 0.014, mastH, 8), concrete);
  mast.position.y = shaftH + mastH / 2; g.add(mast);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 8), beaconMat);
  tip.position.y = height; g.add(tip);

  return { group: g, nightMats, onWater: false };
}

/** Galata Tower (67m) or Maiden's Tower (Kız Kulesi, 28m on water). */
function buildHistoricTower({ h = 67, r = 8.5, roofColor = 0x4b535e, onWater = false }) {
  const g = new THREE.Group();
  const nightMats = [];
  const stone = matStd(onWater ? 0xe8e2d5 : 0xb8ad9b, { rough: 0.82, metal: 0.05 });
  const roof = matStd(roofColor, { rough: 0.55, metal: 0.25 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb338, emissiveIntensity: 0 });
  nightMats.push({ mat: glow, max: 1.8 });

  if (onWater) {
    const quay = new THREE.Mesh(new THREE.CylinderGeometry(r * 2.6, r * 2.9, 4, 12), matStd(0x9a9488, { rough: 0.9 }));
    quay.position.y = 2; g.add(quay);
    const base = new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, h * 0.42, r * 2.4), stone);
    base.position.y = 4 + h * 0.21; g.add(base);
  }
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r, h * 0.72, 16), stone);
  body.position.y = h * 0.36; g.add(body);
  const gal = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.05, 3.5, 16), glow);
  gal.position.y = h * 0.72; g.add(gal);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 1.02, h * 0.28, 16), roof);
  cone.position.y = h * 0.72 + h * 0.14; g.add(cone);

  return { group: g, nightMats, onWater };
}

/** Hagia Sophia (Ayasofya) — central dome + half-domes + 4 minarets. */
function buildHagiaSophia() {
  const g = new THREE.Group();
  const nightMats = [];
  const wall = matStd(0xd8a888, { rough: 0.78, metal: 0.05 });
  const domeMat = matStd(0x6d757e, { rough: 0.55, metal: 0.25 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0xffb84d, emissiveIntensity: 0 });
  nightMats.push({ mat: glow, max: 1.4 });

  const main = new THREE.Mesh(new THREE.BoxGeometry(74, 28, 82), wall);
  main.position.y = 14; g.add(main);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(22, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.y = 28; g.add(dome);
  for (const sz of [-1, 1]) {
    const hd = new THREE.Mesh(new THREE.SphereGeometry(16, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    hd.position.set(0, 22, sz * 22); g.add(hd);
  }
  // 4 corner minarets
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, 58, 10), wall);
    m.position.set(sx * 42, 29, sz * 44); g.add(m);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(1.8, 11, 10), domeMat);
    sp.position.set(sx * 42, 63, sz * 44); g.add(sp);
    const bal = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 1.5, 10), glow);
    bal.position.set(sx * 42, 46, sz * 44); g.add(bal);
  }
  return { group: g, nightMats, onWater: false };
}

/** Great Pyramids of Giza (all 3 pyramids at real relative positions & heights). */
function buildPyramids() {
  const g = new THREE.Group();
  const sand = matStd(0xd9bf8c, { rough: 0.88, metal: 0.02 });
  const list = [[0, 0, 230, 139], [-340, 360, 215, 136], [-620, 700, 105, 65]];
  for (const [x, z, base, h] of list) {
    const p = new THREE.Mesh(new THREE.ConeGeometry(base / Math.SQRT2, h, 4), sand);
    p.rotation.y = Math.PI / 4;
    p.position.set(x, h / 2, z);
    g.add(p);
  }
  return { group: g, nightMats: [], onWater: false };
}

/** Burj Khalifa (Dubai, 828 m) — Y-shaped spiraling setback glass supertall. */
function buildBurjKhalifa() {
  const g = new THREE.Group();
  const nightMats = [];
  const glass = matStd(0x9ab4cc, { rough: 0.18, metal: 0.78 });
  const led = new THREE.MeshStandardMaterial({ color: 0xe6f7ff, emissive: 0x70d8ff, emissiveIntensity: 0 });
  nightMats.push({ mat: led, max: 1.9 });

  const tiers = [[0, 160, 44], [160, 150, 34], [310, 140, 25], [450, 130, 17], [580, 110, 10], [690, 138, 3]];
  for (const [y0, h, r] of tiers) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r, h, 6), glass);
    m.position.y = y0 + h / 2; g.add(m);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.85, 2.4, 6), led);
    ring.position.y = y0 + h; g.add(ring);
  }
  return { group: g, nightMats, onWater: false };
}

/** Colosseum (Rome) — elliptical arched travertine amphitheater. */
function buildColosseum() {
  const g = new THREE.Group();
  const nightMats = [];
  const stone = matStd(0xd4c2a1, { rough: 0.82, metal: 0.05 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xffd280, emissive: 0xffb340, emissiveIntensity: 0 });
  nightMats.push({ mat: glow, max: 1.5 });
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(86, 86, 48, 32, 1, true), stone);
  outer.material.side = THREE.DoubleSide;
  outer.scale.set(1.1, 1, 0.9); outer.position.y = 24; g.add(outer);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(64, 64, 34, 24, 1, true), glow);
  inner.material.side = THREE.DoubleSide;
  inner.scale.set(1.1, 1, 0.9); inner.position.y = 17; g.add(inner);
  return { group: g, nightMats, onWater: false };
}

/** Statue of Liberty (93 m), Big Ben (96 m), Pisa (57 m), Taj Mahal, Sydney Opera House. */
function buildGenericIcon(id) {
  if (id === 'PISA') {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(7.7, 7.7, 57, 16), matStd(0xedeae2, { rough: 0.6 }));
    m.position.y = 28.5; m.rotation.z = -4 * D2R; g.add(m);
    return { group: g, nightMats: [], onWater: false };
  }
  if (id === 'LIBRTY') {
    const g = new THREE.Group();
    const nightMats = [];
    const ped = new THREE.Mesh(new THREE.BoxGeometry(20, 47, 20), matStd(0xc6bba8, { rough: 0.8 })); ped.position.y = 23.5; g.add(ped);
    const stat = new THREE.Mesh(new THREE.CylinderGeometry(4, 7, 46, 10), matStd(0x5fa691, { rough: 0.55, metal: 0.35 })); stat.position.y = 70; g.add(stat);
    const torchMat = new THREE.MeshStandardMaterial({ color: 0xffd566, emissive: 0xffaa22, emissiveIntensity: 0 });
    nightMats.push({ mat: torchMat, max: 2.6 });
    const torch = new THREE.Mesh(new THREE.SphereGeometry(2.8, 8, 8), torchMat); torch.position.set(3, 94, 0); g.add(torch);
    return { group: g, nightMats, onWater: false };
  }
  if (id === 'BIGBEN') {
    const g = new THREE.Group();
    const nightMats = [];
    const stone = matStd(0xcab694, { rough: 0.78 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(12, 72, 12), stone); b.position.y = 36; g.add(b);
    const clockMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffd27a, emissiveIntensity: 0 });
    nightMats.push({ mat: clockMat, max: 2.0 });
    const clk = new THREE.Mesh(new THREE.BoxGeometry(12.6, 8, 12.6), clockMat); clk.position.y = 60; g.add(clk);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(8.5, 24, 4), matStd(0x3b444f, { rough: 0.5 })); sp.rotation.y = Math.PI / 4; sp.position.y = 84; g.add(sp);
    return { group: g, nightMats, onWater: false };
  }
  if (id === 'TAJMAH') {
    const g = new THREE.Group();
    const marble = matStd(0xf5f2ea, { rough: 0.45, metal: 0.05 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(95, 7, 95), marble); base.position.y = 3.5; g.add(base);
    const body = new THREE.Mesh(new THREE.BoxGeometry(57, 32, 57), marble); body.position.y = 23; g.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(18, 20, 14), marble); dome.scale.set(1, 1.25, 1); dome.position.y = 48; g.add(dome);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.8, 42, 10), marble);
      m.position.set(sx * 43, 28, sz * 43); g.add(m);
    }
    return { group: g, nightMats: [], onWater: false };
  }
  if (id === 'OPERA') {
    const g = new THREE.Group();
    const shellMat = matStd(0xf0ece2, { rough: 0.4, metal: 0.1 });
    for (const [x, z, s] of [[-26, 0, 1], [18, -12, 0.85], [46, 10, 0.65]]) {
      const sh = new THREE.Mesh(new THREE.ConeGeometry(28 * s, 56 * s, 6), shellMat);
      sh.scale.set(0.7, 1, 1.3); sh.rotation.x = 0.22; sh.position.set(x, 26 * s, z); g.add(sh);
    }
    return { group: g, nightMats: [], onWater: false };
  }
  return null;
}

const BUILDERS = {
  BOGAZ1: () => ({ ...buildSuspensionBridge({ span: 1074, totalLen: 1560, towerH: 165, ledColor: 0xff3b70 }), heading: 118 }),
  FSMKPR: () => ({ ...buildSuspensionBridge({ span: 1090, totalLen: 1510, towerH: 165, ledColor: 0x31d0ff }), heading: 108 }),
  YSSKPR: () => ({ ...buildSuspensionBridge({ span: 1408, totalLen: 2164, deckW: 58, towerH: 322, aFrame: true, ledColor: 0xffbe3b }), heading: 100 }),
  OSMGZ:  () => ({ ...buildSuspensionBridge({ span: 1550, totalLen: 2682, towerH: 252, ledColor: 0x3cf07a }), heading: 180 }),
  CNK1915:() => ({ ...buildSuspensionBridge({ span: 2023, totalLen: 3563, deckW: 45, towerH: 318, redWhite: true, ledColor: 0xff3b30 }), heading: 132 }),
  GOLDGT: () => ({ ...buildSuspensionBridge({ span: 1280, totalLen: 2737, towerH: 227, towerColor: 0xc0362c, deckColor: 0x9c2c24, ledColor: 0xffb347 }), heading: 15 }),
  TWRBRG: () => ({ ...buildSuspensionBridge({ span: 75, totalLen: 244, deckW: 20, deckH: 12, towerH: 65, towerColor: 0xc4b59d, ledColor: 0x31d0ff }), heading: 22 }),
  ANITKB: () => ({ ...buildAnitkabir(), heading: 38 }),
  CAMLIC: () => ({ ...buildModernTower(369, true), heading: 0 }),
  ATAKUL: () => ({ ...buildModernTower(125, false), heading: 0 }),
  TOKYOT: () => ({ ...buildModernTower(634, true), heading: 0 }),
  GALATA: () => ({ ...buildHistoricTower({ h: 67, r: 8.5 }), heading: 0 }),
  KIZKUL: () => ({ ...buildHistoricTower({ h: 28, r: 6.5, roofColor: 0x607080, onWater: true }), heading: 0 }),
  AYASOF: () => ({ ...buildHagiaSophia(), heading: 122 }),
  EYFEL:  () => ({ ...buildEiffel(), heading: 45 }),
  GIZE:   () => ({ ...buildPyramids(), heading: 0 }),
  BURJKH: () => ({ ...buildBurjKhalifa(), heading: 0 }),
  KOLEZY: () => ({ ...buildColosseum(), heading: 15 }),
  PISA:   () => ({ ...buildGenericIcon('PISA'), heading: 0 }),
  LIBRTY: () => ({ ...buildGenericIcon('LIBRTY'), heading: 135 }),
  BIGBEN: () => ({ ...buildGenericIcon('BIGBEN'), heading: 0 }),
  TAJMAH: () => ({ ...buildGenericIcon('TAJMAH'), heading: 0 }),
  OPERA:  () => ({ ...buildGenericIcon('OPERA'), heading: 35 }),
};

export class Landmark3DManager {
  constructor(world) {
    this.world = world;
    this.spawned = new Map();
    this.acc = 99;
  }

  update(dt, camPos) {
    if (!this.world.frame) return;
    this.acc += dt;
    if (this.acc < 1.5) return;
    this.acc = 0;

    const frame = this.world.frame;
    const terrain = this.world.terrain;
    for (const lm of LANDMARKS) {
      if (!BUILDERS[lm.id]) continue;
      const p = frame.toLocal(lm.lat, lm.lon);
      const dist = Math.hypot(p.x - camPos.x, p.z - camPos.z);
      if (dist > 120000) continue;

      let entry = this.spawned.get(lm.id);
      if (!entry) {
        const built = BUILDERS[lm.id]();
        built.group.rotation.y = -(built.heading || 0) * D2R;
        const y0 = built.onWater ? 0 : (terrain?.groundHeight(p.x, p.z) ?? 0);
        built.group.position.set(p.x, y0, p.z);
        this.world.scene.add(built.group);
        for (const nm of built.nightMats) {
          nm.mat.emissiveIntensity = nm.max * (this.world.env?.night || 0);
          this.world.nightMats.push(nm);
        }
        entry = { ...built, x: p.x, z: p.z, settled: built.onWater };
        this.spawned.set(lm.id, entry);
      } else if (!entry.settled && terrain) {
        // Re-snap height once high-res DEM tile arrives around the landmark
        const h = terrain.demAtLatLon(lm.lat, lm.lon);
        if (h != null) {
          entry.group.position.y = Math.max(0, h) - 0.5;
          entry.settled = true;
        }
      }
    }
  }
}
