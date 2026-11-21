import * as THREE from 'three';

const STORAGE_KEY = 'skyview.traffic';
const D2R = Math.PI / 180;
const M2FT = 3.28084;
const KT2MS = 0.514444;
const CALLSIGNS = ['THY412', 'PGT805', 'SXS214', 'DLH1304', 'AFR1890', 'BAW676', 'KLM1615', 'UAE122', 'AUA821', 'LOT135'];
const LIVERIES = [0xd62828, 0xffb703, 0x1d3557, 0x0077b6, 0x2a9d8f, 0xe63946, 0x457b9d];

// Shared lightweight jetliner mesh builder (low draw-call cost, realistic silhouette + HDR nav/strobe lights)
function buildJetMesh(tailColor) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f4f8, roughness: 0.35, metalness: 0.25 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x6c7a89, roughness: 0.5, metalness: 0.4 });
  const tailM = new THREE.MeshStandardMaterial({ color: tailColor, roughness: 0.4, metalness: 0.2 });

  // Fuselage (length ~38 m along -Z forward)
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 32, 10).rotateX(Math.PI / 2), white);
  g.add(fuse);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.9, 5.5, 10).rotateX(-Math.PI / 2), white);
  nose.position.z = -18.7; g.add(nose);
  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(1.9, 6.5, 10).rotateX(Math.PI / 2), white);
  tailCone.position.z = 19.2; g.add(tailCone);

  // Swept wings
  const wingGeo = new THREE.BoxGeometry(17.5, 0.45, 4.4);
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo, white);
    w.position.set(sx * 9.2, -0.4, 1.8);
    w.rotation.y = -sx * 0.36;
    g.add(w);
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 3.6, 8).rotateX(Math.PI / 2), grey);
    eng.position.set(sx * 6.0, -1.6, -0.4);
    g.add(eng);
  }
  // Vertical & horizontal stabilizer
  const vstab = new THREE.Mesh(new THREE.BoxGeometry(0.45, 7.2, 5.2), tailM);
  vstab.position.set(0, 4.2, 16.5); vstab.rotation.x = 0.28; g.add(vstab);
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.35, 2.8), white);
  hstab.position.set(0, 0.6, 17.6); g.add(hstab);

  // HDR emissive navigation & strobe lights (bloom nicely at dusk/night)
  const mkLight = (col, x, y, z, r = 0.75) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 6, 6),
      new THREE.MeshBasicMaterial({ color: col }),
    );
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  mkLight(new THREE.Color(4, 0.3, 0.2), -17.4, -0.1, 5.1);   // port red
  mkLight(new THREE.Color(0.2, 4, 0.5),  17.4, -0.1, 5.1);   // starboard green
  const strobeL = mkLight(new THREE.Color(5, 5, 5), -17.6, -0.1, 5.4, 0.85);
  const strobeR = mkLight(new THREE.Color(5, 5, 5),  17.6, -0.1, 5.4, 0.85);
  const beacon  = mkLight(new THREE.Color(4.5, 0.2, 0.15), 0, 2.4, 2, 0.7);
  return { group: g, strobes: [strobeL, strobeR], beacon };
}

export class AirTraffic {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.enabled = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === '0') this.enabled = false;
    } catch { /* ignore */ }

    this.root = new THREE.Group();
    this.root.visible = this.enabled;
    scene.add(this.root);

    this.planes = [];
    this.time = 0;
    this.spawnInitial();
  }

  spawnInitial() {
    const sp = this.world.spawn || { x: 0, z: 0, elev: 0, heading: 0, free: true };
    const rwyHdg = sp.heading || 0;
    const dx = Math.sin(rwyHdg * D2R), dz = -Math.cos(rwyHdg * D2R);

    // 1) Runway approach traffic (if airport exists)
    if (!sp.free) {
      const app = this.makePlane(0, 'APP');
      app.along = 9500; // starts 9.5 km on final
      app.hdg = rwyHdg;
      app.kt = 148;
      app.rwy = { x: sp.x, z: sp.z, elev: sp.elev, heading: rwyHdg, dx, dz };
      this.placeOnApproach(app);
      this.planes.push(app);

      // 2) Departing traffic climbing out
      const dep = this.makePlane(1, 'DEP');
      dep.along = 2200;
      dep.hdg = rwyHdg;
      dep.kt = 195;
      dep.rwy = { x: sp.x, z: sp.z, elev: sp.elev, heading: rwyHdg, dx, dz };
      this.placeOnDeparture(dep);
      this.planes.push(dep);
    }

    // 3) 5 En-route cruising jets at varied altitudes & headings
    const alts = [5500, 9000, 14000, 21000, 28000];
    for (let i = 0; i < alts.length; i++) {
      const p = this.makePlane(i + 2, 'CRZ');
      const ang = (i / alts.length) * Math.PI * 2 + 0.4;
      const dist = 8000 + i * 7500;
      p.x = sp.x + Math.cos(ang) * dist;
      p.z = sp.z + Math.sin(ang) * dist;
      p.y = alts[i] / M2FT;
      p.hdg = (i * 73 + 25) % 360;
      p.kt = 240 + i * 38;
      p.pitch = 0;
      this.syncMesh(p);
      this.planes.push(p);
    }
  }

  makePlane(idx, phase) {
    const built = buildJetMesh(LIVERIES[idx % LIVERIES.length]);
    this.root.add(built.group);
    return {
      callsign: CALLSIGNS[idx % CALLSIGNS.length],
      phase,
      x: 0, y: 1000, z: 0, hdg: 0, pitch: 0, kt: 250,
      phaseOffset: idx * 0.37,
      ...built,
    };
  }

  placeOnApproach(p) {
    const r = p.rwy;
    // along > 0: on final before threshold; along < 0: rolling down runway
    p.x = r.x - r.dx * p.along;
    p.z = r.z - r.dz * p.along;
    p.y = r.elev + Math.max(2, p.along * Math.tan(3 * D2R));
    p.hdg = r.heading;
    p.pitch = p.along > 0 ? -3 * D2R : 0;
    this.syncMesh(p);
  }

  placeOnDeparture(p) {
    const r = p.rwy;
    p.x = r.x + r.dx * p.along;
    p.z = r.z + r.dz * p.along;
    p.y = r.elev + 2 + Math.max(0, p.along - 1100) * Math.tan(7.5 * D2R);
    p.hdg = r.heading;
    p.pitch = p.along > 1100 ? 8 * D2R : 0;
    this.syncMesh(p);
  }

  syncMesh(p) {
    p.group.position.set(p.x, p.y, p.z);
    p.group.rotation.set(p.pitch, -p.hdg * D2R, 0, 'YXZ');
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.root.visible = this.enabled;
    try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch { /* ignore */ }
    return this.enabled;
  }

  toggle() { return this.setEnabled(!this.enabled); }

  /** Returns callsign of an AI aircraft occupying the runway or short final (< 4.5 km), else null. */
  runwayOccupant() {
    if (!this.enabled) return null;
    for (const p of this.planes) {
      if (p.phase === 'APP' && p.along < 4500 && p.along > -2400) return p.callsign;
      if (p.phase === 'DEP' && p.along > -100 && p.along < 2600) return p.callsign;
    }
    return null;
  }

  update(dt, playerPos) {
    if (!this.enabled || dt <= 0) return;
    this.time += dt;

    for (const p of this.planes) {
      const v = p.kt * KT2MS;
      if (p.phase === 'APP' && p.rwy) {
        p.along -= v * dt;
        if (p.along < -2600) p.along = 14500; // vacate runway -> next arrival on 14.5 km final
        this.placeOnApproach(p);
      } else if (p.phase === 'DEP' && p.rwy) {
        p.along += v * dt;
        if (p.along > 32000) p.along = 100;   // next departure lines up
        this.placeOnDeparture(p);
      } else {
        p.x += Math.sin(p.hdg * D2R) * v * dt;
        p.z -= Math.cos(p.hdg * D2R) * v * dt;
        // wrap around player within 55 km so sky stays lively anywhere you fly
        if (playerPos) {
          const dx = p.x - playerPos.x, dz = p.z - playerPos.z;
          if (dx * dx + dz * dz > 58000 * 58000) {
            p.x = playerPos.x - dx * 0.85;
            p.z = playerPos.z - dz * 0.85;
          }
        }
        this.syncMesh(p);
      }
      // Realistic strobe & beacon blink
      const st = ((this.time + p.phaseOffset) % 1.35) < 0.08;
      p.strobes[0].visible = st; p.strobes[1].visible = st;
      p.beacon.visible = ((this.time + p.phaseOffset * 1.7) % 1.1) < 0.14;
    }
  }

  /** Traffic targets for MiniMap & ND TCAS display. */
  getTargets(frame) {
    if (!this.enabled) return [];
    return this.planes.map(p => {
      const ll = frame ? frame.toLatLon(p.x, p.z) : null;
      return {
        callsign: p.callsign,
        x: p.x, z: p.z,
        lat: ll?.lat ?? null, lon: ll?.lon ?? null,
        altFt: Math.round(p.y * M2FT),
        hdg: p.hdg,
        kt: p.kt,
        phase: p.phase,
      };
    });
  }
}
