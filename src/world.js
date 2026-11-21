import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createNoise2D, fbm, smoothstep, clamp, lerp, mulberry32 } from './noise.js';
import { canvasTex, noiseFill, buildRunway, updateRunwayLights, makeGlowMaterial as makeGlowMat, makePoints as makePts } from './airport.js';

/** Emissive mask: lit (warm) windows on black, some dark at random. */
function windowGlow(size, cols, rows, litShare = 0.6) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  const rnd = mulberry32(size + cols * 7 + rows);
  const cw = size / cols, rh = size / rows;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (rnd() > litShare) continue;
    const v = 150 + rnd() * 105;
    g.fillStyle = `rgb(${v}, ${v * (0.8 + rnd() * 0.15)}, ${v * (0.45 + rnd() * 0.3)})`;
    g.fillRect(x * cw + cw * 0.12, y * rh + rh * 0.3, cw * 0.76, rh * 0.5);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
import { LocalFrame } from './geo.js';
import { RealTerrain, IMAGERY_ATTRIBUTION } from './realterrain.js';

export { makeGlowMaterial } from './airport.js';
export const AIRPORT_ELEV = 30;            // synthetic world airport elevation
export const RWY = { length: 3200, width: 45, halfLen: 1600 };

// ---------------------------------------------------------------- ground provider
let provider = null;   // real terrain when active
const TERRAIN_SIZE = 100000, TERRAIN_N = 640, STEP = TERRAIN_SIZE / TERRAIN_N, HALF = TERRAIN_SIZE / 2;
let heights = null;
const noiseA = createNoise2D(1337), noiseB = createNoise2D(4242), noiseC = createNoise2D(99);

function analyticHeight(x, z) {
  const dx = Math.max(0, Math.abs(x - 150) - 800), dz = Math.max(0, Math.abs(z) - 2700);
  const dist = Math.hypot(dx, dz);
  const blend = smoothstep(200, 5000, dist);
  const base = fbm(noiseA, x * 0.000085, z * 0.000085, 6);
  const ridge = 1 - Math.abs(fbm(noiseB, x * 0.00004 + 7.3, z * 0.00004 - 2.1, 5));
  const mountainMask = smoothstep(9000, 26000, dist) * smoothstep(-0.2, 0.4, noiseC(x * 0.00002, z * 0.00002));
  return lerp(AIRPORT_ELEV, base * 220 + 70 + Math.pow(ridge, 2.6) * 2600 * mountainMask, blend);
}
function ensureSynthetic() {
  if (heights) return;
  heights = new Float32Array((TERRAIN_N + 1) * (TERRAIN_N + 1));
  for (let iz = 0; iz <= TERRAIN_N; iz++) for (let ix = 0; ix <= TERRAIN_N; ix++)
    heights[iz * (TERRAIN_N + 1) + ix] = analyticHeight(ix * STEP - HALF, iz * STEP - HALF);
}
function synthHeight(x, z) {
  ensureSynthetic();
  const gx = clamp((x + HALF) / STEP, 0, TERRAIN_N - 1e-4), gz = clamp((z + HALF) / STEP, 0, TERRAIN_N - 1e-4);
  const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, W = TERRAIN_N + 1;
  const h00 = heights[iz * W + ix], h10 = heights[iz * W + ix + 1], h01 = heights[(iz + 1) * W + ix], h11 = heights[(iz + 1) * W + ix + 1];
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}
/** Raw terrain height (negative = under water). */
export function terrainHeight(x, z) { return provider ? provider.rawHeight(x, z) : synthHeight(x, z); }
/** Solid surface height (water surface at 0). */
export function groundHeight(x, z) { return provider ? provider.groundHeight(x, z) : Math.max(synthHeight(x, z), 0); }

// ---------------------------------------------------------------- World
/**
 * site: { kind: 'synthetic' } | { kind: 'airport', airport, rwIndex, end: 'le'|'he' } | { kind: 'free', lat, lon }
 */
export class World {
  constructor(scene, renderer, site = { kind: 'synthetic' }) {
    this.scene = scene; this.renderer = renderer; this.site = site;
    this.glowMats = []; this.runways = []; this.time = 0; this.attribution = '';
    const elev = THREE.MathUtils.degToRad(36), azim = THREE.MathUtils.degToRad(215);
    this.sunDir = new THREE.Vector3(Math.cos(elev) * Math.sin(azim), Math.sin(elev), -Math.cos(elev) * Math.cos(azim)).normalize();
    this.fogColor = new THREE.Color(0xb9cbdd);
    this.baseFogDensity = 0.000028;
    scene.fog = new THREE.FogExp2(this.fogColor.clone(), this.baseFogDensity);
    this.buildSky();
    this.buildLights();
  }

  async init(onStatus = () => {}) {
    const s = this.site;
    if (s.kind === 'synthetic') {
      provider = null;
      onStatus('Hayali arazi oluşturuluyor…');
      await new Promise(r => setTimeout(r, 10));
      this.buildTerrain(); this.buildWater();
      const r = buildRunway({ len: RWY.length, wid: RWY.width, leId: '36', heId: '18' }, 'le');
      r.group.position.set(0, AIRPORT_ELEV, 0);
      this.addRunway(r);
      this.buildTaxiways(); this.buildAirportBuildings(); this.buildVegetation(); this.buildTown();
      if (this.env) this.env.decorateTerrain(this.synthTerrainMat);
      if (this.streetMat && this.townLights) { this.townLights.material = this.streetMat; this.scene.add(this.townLights); }
      this.spawn = { x: 0, z: RWY.halfLen, heading: 0, elev: AIRPORT_ELEV, name: 'Hayali dünya · RWY 36' };
      this.parkingSpots = true;
      return;
    }
    const lat0 = s.kind === 'airport' ? s.airport.lat : s.lat, lon0 = s.kind === 'airport' ? s.airport.lon : s.lon;
    this.frame = new LocalFrame(lat0, lon0);
    const elevGuess = s.kind === 'airport' && s.airport.elev != null ? s.airport.elev * 0.3048 : 0;
    this.terrain = new RealTerrain(this.scene, this.frame, { originElev: elevGuess });
    provider = this.terrain;
    if (this.streetMat) this.terrain.lightMat = this.streetMat;
    if (this.env) { this.terrain.onMaterial = (m) => this.env.decorateTerrain(m); this.terrain.setNight(this.env.night); }
    this.attribution = IMAGERY_ATTRIBUTION;
    onStatus('Yükseklik verisi indiriliyor…');
    await this.terrain.preloadElevation(0, 0, 9000);

    this.airportRunways = new Map();
    if (s.kind === 'airport') {
      const list = await this.addAirport(s.airport, s.rwIndex, s.end);
      const rw = s.airport.rw[s.rwIndex];
      const endMeta = list[s.rwIndex][s.end === 'he' ? 'he' : 'le'];
      this.spawn = { x: endMeta.x, z: endMeta.z, heading: endMeta.heading, elev: endMeta.elev,
        name: `${s.airport.icao} · RWY ${s.end === 'le' ? rw.le.id : rw.he.id}` };
    } else {
      const ll = this.frame.toLatLon(0, 0);
      const h = Math.max(0, this.terrain.demAtLatLon(ll.lat, ll.lon) ?? 0);
      this.spawn = { x: 0, z: 0, heading: 0, elev: h, name: `${lat0.toFixed(3)}, ${lon0.toFixed(3)}`, free: true };
    }
    onStatus('Uydu görüntüleri indiriliyor…');
    const p = new THREE.Vector3(this.spawn.x, this.spawn.elev + (s.kind === 'free' ? 1500 : 30), this.spawn.z);
    await this.terrain.preload(p, n => onStatus(`Uydu görüntüleri indiriliyor… ${n} karo`));
  }

  async ensureRouteCoverage(points) {
    if (!this.terrain || !this.frame || !points?.length) return;
    for (const pt of points) {
      if (Number.isFinite(pt.lat) && Number.isFinite(pt.lon)) this.terrain.ensureCoverage(pt.lat, pt.lon, 80000);
    }
  }

  async addAirport(airport, activeRwIndex = -1, activeEnd = null) {
    if (!this.terrain || !this.frame || !airport) return null;
    if (!this.airportRunways) this.airportRunways = new Map();
    if (this.airportRunways.has(airport.icao)) return this.airportRunways.get(airport.icao);
    this.terrain.ensureCoverage(airport.lat, airport.lon, 80000);
    const c0 = this.frame.toLocal(airport.lat, airport.lon);
    await this.terrain.preloadElevation(c0.x, c0.z, 9000);
    const list = [];
    airport.rw.forEach((rw, i) => {
      const le = this.frame.toLocal(rw.le.lat, rw.le.lon), he = this.frame.toLocal(rw.he.lat, rw.he.lon);
      const dx = he.x - le.x, dz = he.z - le.z, len = Math.hypot(dx, dz);
      const ux = dx / len, uz = dz / len;
      const c = { x: (le.x + he.x) / 2, z: (le.z + he.z) / 2 };
      const zone = this.terrain.addRunwayZone(c, ux, uz, len / 2, rw.wid / 2);
      const active = i === activeRwIndex ? activeEnd : null;
      const r = buildRunway({ len, wid: rw.wid, leId: rw.le.id, heId: rw.he.id }, active);
      const heading = Math.atan2(ux, -uz);
      r.group.rotation.set(Math.atan(zone.slope), -heading, 0, 'YXZ');
      r.group.position.set(c.x, zone.e0, c.z);
      this.addRunway(r);
      const hdgLe = (heading * 180 / Math.PI + 360) % 360;
      const hdgHe = (hdgLe + 180) % 360;
      list.push({
        le: { id: rw.le.id, x: c.x - ux * len / 2, z: c.z - uz * len / 2, elev: zone.e0 - zone.slope * len / 2, heading: hdgLe },
        he: { id: rw.he.id, x: c.x + ux * len / 2, z: c.z + uz * len / 2, elev: zone.e0 + zone.slope * len / 2, heading: hdgHe },
      });
    });
    this.airportRunways.set(airport.icao, list);
    if (activeRwIndex < 0) this.terrain.refreshArea(c0.x, c0.z, 7000);
    return list;
  }

  addRunway(r) {
    this.scene.add(r.group);
    r.group.updateMatrixWorld(true);
    this.runways.push(r);
    this.glowMats.push(...r.glowMats);
  }

  get cloudBase() { return (this.spawn?.elev || 0) + 1500; }

  buildSky() {
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.2; u.rayleigh.value = 1.5; u.mieCoefficient.value = 0.002; u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(this.sunDir);
    // Scale Preetham raw radiance so the sky keeps deep azure zenith & rich golden horizon at normal exposure (~0.9)
    u.uSkyGain = { value: 0.44 };
    sky.material.fragmentShader = sky.material.fragmentShader
      .replace('void main() {', 'uniform float uSkyGain;\nvoid main() {')
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb *= uSkyGain;\n#include <tonemapping_fragment>');
    sky.material.depthWrite = false; sky.renderOrder = -10; sky.frustumCulled = false;
    this.sky = sky; this.scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky(); sky2.scale.setScalar(1000);
    sky2.material.uniforms.uSkyGain = { value: 0.44 };
    sky2.material.fragmentShader = sky2.material.fragmentShader
      .replace('void main() {', 'uniform float uSkyGain;\nvoid main() {')
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb *= uSkyGain;\n#include <tonemapping_fragment>');
    Object.keys(u).forEach(k => { if (sky2.material.uniforms[k]) sky2.material.uniforms[k].value = u[k].value; });
    envScene.add(sky2);
    this.envGround = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3b4636, side: THREE.BackSide }));
    envScene.add(this.envGround);
    this.pmrem = pmrem; this.envScene = envScene; this.sky2 = sky2;
    this.envRT = pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.85;
    this.nightMats = [];
  }

  /** Re-renders the image-based lighting after the sun / weather changed. */
  rebuildEnvironment(night = 0, clarity = 1) {
    const u = this.sky.material.uniforms;
    Object.keys(u).forEach(k => { if (!this.sky2.material.uniforms[k]) return; const v = u[k].value; this.sky2.material.uniforms[k].value = v?.clone ? v.clone() : v; });
    this.envGround.material.color.setRGB(0.23, 0.27, 0.21).multiplyScalar((1 - night * 0.92) * (0.6 + 0.4 * clarity));
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    old?.dispose();
  }

  /** Street-light glow shared by real terrain tiles and the synthetic town. */
  attachNightLights(env) {
    if (this.streetMat) return;
    this.streetMat = makeGlowMat({ size: 0.9, minPx: 0.9, intensity: 0 });
    this.glowMats.push(this.streetMat);
    if (this.terrain) this.terrain.lightMat = this.streetMat;
    if (this.townLights) { this.townLights.material = this.streetMat; this.scene.add(this.townLights); }
  }

  setNight(k) {
    this.terrain?.setNight(k);
    if (this.streetMat) this.streetMat.uniforms.intensity.value = 1.45 * smoothstep(0.15, 0.8, k);
    for (const { mat, max } of this.nightMats) mat.emissiveIntensity = max * k;
  }

  /** Runway / taxiway surface: dry, wet (mirror-like), or snow-dusted. */
  setSurface(kind) {
    for (const r of this.runways) r.group.traverse(o => {
      if (!o.isMesh || !o.material?.isMeshStandardMaterial) return;
      const m = o.material;
      if (m.userData.r0 === undefined) { m.userData.r0 = m.roughness; m.userData.c0 = m.color.clone(); m.userData.e0 = m.envMapIntensity; }
      const isPaint = m.color.r > 0.8 && !m.map;
      m.roughness = kind === 'wet' ? (isPaint ? 0.35 : 0.22) : kind === 'snow' ? 0.85 : m.userData.r0;
      m.envMapIntensity = kind === 'wet' ? 2.2 : m.userData.e0;
      m.color.copy(m.userData.c0);
      if (kind === 'wet' && m.map) m.color.multiplyScalar(0.72);
      if (kind === 'snow') m.color.lerp(new THREE.Color(0xdde3ea), m.map ? 0.35 : 0.1);
    });
  }

  buildLights() {
    const sun = new THREE.DirectionalLight(0xfff1dc, 3.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const s = sun.shadow.camera;
    s.left = -45; s.right = 45; s.top = 45; s.bottom = -45; s.near = 10; s.far = 1200;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x4a5a3a, 0.35);
    this.scene.add(this.hemi);
  }

  followShadow(target) {
    this.sun.position.copy(target).addScaledVector(this.sunDir, 600);
    this.sun.target.position.copy(target);
  }

  // ---------------------------------------------------------------- synthetic world parts
  buildTerrain() {
    ensureSynthetic();
    const W = TERRAIN_N + 1;
    const pos = new Float32Array(W * W * 3), col = new Float32Array(W * W * 3), uv = new Float32Array(W * W * 2);
    const c = new THREE.Color();
    const grassA = new THREE.Color(0x4f6b2f), grassB = new THREE.Color(0x6d7d3a), grassC = new THREE.Color(0x3d5a2a);
    const field = new THREE.Color(0x8a8350), forest = new THREE.Color(0x2c4222), rock = new THREE.Color(0x77706a);
    const snow = new THREE.Color(0xf2f5f8), sand = new THREE.Color(0xb8a77a), seabed = new THREE.Color(0x5a5a48);
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const i = iz * W + ix, x = ix * STEP - HALF, z = iz * STEP - HALF, h = heights[i];
      pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
      uv[i * 2] = x / 24; uv[i * 2 + 1] = z / 24;
      const hx = heights[iz * W + Math.min(ix + 1, W - 1)] - heights[iz * W + Math.max(ix - 1, 0)];
      const hz = heights[Math.min(iz + 1, W - 1) * W + ix] - heights[Math.max(iz - 1, 0) * W + ix];
      const slope = Math.hypot(hx, hz) / (2 * STEP);
      const v1 = noiseA(x * 0.0006, z * 0.0006) * 0.5 + 0.5, v2 = noiseB(x * 0.0021, z * 0.0021) * 0.5 + 0.5;
      c.copy(grassA).lerp(grassB, v1).lerp(grassC, v2 * 0.6);
      if (noiseC(x * 0.0012, z * 0.0012) > 0.35 && h < 600) c.lerp(field, 0.55);
      if (noiseB(x * 0.0009 + 3, z * 0.0009) > 0.25) c.lerp(forest, 0.6);
      c.lerp(rock, smoothstep(0.35, 0.75, slope) * 0.9);
      c.lerp(rock, smoothstep(1200, 1700, h) * 0.8);
      c.lerp(snow, smoothstep(1900, 2300, h + v2 * 200) * (1 - smoothstep(0.7, 1.1, slope)));
      if (h < 4) c.lerp(sand, 1 - smoothstep(-2, 4, h));
      if (h < -2) c.copy(seabed);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const idx = new Uint32Array(TERRAIN_N * TERRAIN_N * 6);
    let k = 0;
    for (let iz = 0; iz < TERRAIN_N; iz++) for (let ix = 0; ix < TERRAIN_N; ix++) {
      const a = iz * W + ix, b = a + 1, d = a + W, e = d + 1;
      idx[k++] = a; idx[k++] = d; idx[k++] = b; idx[k++] = d; idx[k++] = e; idx[k++] = b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const detail = canvasTex(256, (ctx, s) => noiseFill(ctx, s, 0.72, 1.0, [1, 1, 1], 7, 0.25));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0 });
    this.synthTerrainMat = mat;
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 t1 = texture2D( map, vMapUv );
          vec4 t2 = texture2D( map, vMapUv * 0.071 + 0.37 );
          diffuseColor.rgb *= mix(t1.rgb, vec3(1.0), 0.15) * (0.75 + 0.35 * t2.r);
        #endif`);
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildWater() {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(TERRAIN_SIZE * 1.6, TERRAIN_SIZE * 1.6).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1b4560, roughness: 0.12, metalness: 0.0, envMapIntensity: 1.2 }));
    w.receiveShadow = true;
    this.scene.add(w);
  }

  buildTaxiways() {
    const E = AIRPORT_ELEV, L = RWY.halfLen, grp = new THREE.Group();
    const asphalt = canvasTex(512, (ctx, s) => noiseFill(ctx, s, 0.20, 0.30, [1, 1, 1.03], 11, 0.5));
    const twMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.93, color: 0xcfcfcf });
    asphalt.repeat.set(1, 60);
    const tw = new THREE.Mesh(new THREE.PlaneGeometry(23, RWY.length).rotateX(-Math.PI / 2), twMat);
    tw.position.set(190, E + 0.05, 0); tw.receiveShadow = true; grp.add(tw);
    for (const z of [-L + 60, -500, 500, L - 60]) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(165, 23).rotateX(-Math.PI / 2), twMat);
      l.position.set(105, E + 0.045, z); l.receiveShadow = true; grp.add(l);
    }
    const apronTex = canvasTex(256, (ctx, s) => noiseFill(ctx, s, 0.8, 1, [1, 1, 1], 21, 0.3));
    apronTex.repeat.set(10, 35);
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 900).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.9, map: apronTex }));
    apron.position.set(330, E + 0.04, 0); apron.receiveShadow = true; grp.add(apron);
    const yP = [], yI = [];
    const yrect = (cx, cz, w, l) => { const b = yP.length / 3, y = E + 0.1; yP.push(cx - w / 2, y, cz - l / 2, cx + w / 2, y, cz - l / 2, cx + w / 2, y, cz + l / 2, cx - w / 2, y, cz + l / 2); yI.push(b, b + 2, b + 1, b, b + 3, b + 2); };
    yrect(190, 0, 0.3, RWY.length);
    for (const z of [-L + 60, -500, 500, L - 60]) yrect(110, z, 160, 0.3);
    const yg = new THREE.BufferGeometry(); yg.setAttribute('position', new THREE.Float32BufferAttribute(yP, 3)); yg.setIndex(yI); yg.computeVertexNormals();
    grp.add(new THREE.Mesh(yg, new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.7 })));
    this.scene.add(grp);
  }

  buildAirportBuildings() {
    const E = AIRPORT_ELEV, grp = new THREE.Group();
    const facade = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#c9ccd0'; ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
        ctx.fillStyle = '#2b3d52'; ctx.fillRect(x * 32 + 3, y * 64 + 18, 26, 34);
        ctx.fillStyle = 'rgba(160,200,240,0.35)'; ctx.fillRect(x * 32 + 3, y * 64 + 18, 26, 8);
      }
    });
    facade.repeat.set(12, 2);
    const termMat = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.6, metalness: 0.2 });
    termMat.emissiveMap = windowGlow(256, 8, 4); termMat.emissiveMap.repeat.set(12, 2); termMat.emissive.setRGB(1, 0.85, 0.6); termMat.emissiveIntensity = 0;
    this.nightMats.push({ mat: termMat, max: 1.6 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8d9298, roughness: 0.8 });
    const term = new THREE.Mesh(new THREE.BoxGeometry(60, 22, 520), [termMat, termMat, roofMat, roofMat, termMat, termMat]);
    term.position.set(500, E + 11, 0); term.castShadow = term.receiveShadow = true; grp.add(term);
    const brMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.5, metalness: 0.4 });
    for (const z of [-180, -60, 60, 180]) { const br = new THREE.Mesh(new THREE.BoxGeometry(34, 3.4, 3.2), brMat); br.position.set(455, E + 5, z); br.castShadow = true; grp.add(br); }
    const towMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.6 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 48, 20), towMat); shaft.position.set(420, E + 24, 520); shaft.castShadow = true; grp.add(shaft);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 6, 6, 16), new THREE.MeshStandardMaterial({ color: 0x1e3347, roughness: 0.05, metalness: 0.9 }));
    cab.position.set(420, E + 51, 520); cab.castShadow = true; grp.add(cab);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 1, 16), towMat); cap.position.set(420, E + 54.5, 520); grp.add(cap);
    const hMat = new THREE.MeshStandardMaterial({ color: 0x9fa7ae, roughness: 0.55, metalness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const h = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 90, 24, 1, false, 0, Math.PI), hMat);
      h.rotation.z = Math.PI / 2; h.rotation.y = Math.PI / 2; h.scale.set(1, 1, 0.55);
      h.position.set(480, E, -700 - i * 110); h.castShadow = h.receiveShadow = true; grp.add(h);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 8), towMat); pole.position.set(-70, E + 4, RWY.halfLen - 300); grp.add(pole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.7, 5, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xff5a1a, side: THREE.DoubleSide }));
    sock.rotation.z = Math.PI / 2; sock.position.set(-67.5, E + 7.6, RWY.halfLen - 300); grp.add(sock);
    this.scene.add(grp);
  }

  buildVegetation() {
    const rnd = mulberry32(5);
    const conifer = new THREE.ConeGeometry(3.2, 13, 7).translate(0, 7.5, 0);
    const broad = new THREE.IcosahedronGeometry(5, 1).scale(1, 0.9, 1).translate(0, 7, 0);
    const mats = [new THREE.MeshStandardMaterial({ color: 0x24391d, roughness: 0.95 }), new THREE.MeshStandardMaterial({ color: 0x3e5a28, roughness: 0.95, flatShading: true })];
    const N = 9000;
    const meshes = [new THREE.InstancedMesh(conifer, mats[0], N), new THREE.InstancedMesh(broad, mats[1], N)];
    const counts = [0, 0];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    let tries = 0;
    while ((counts[0] + counts[1]) < N * 2 - 2 && tries++ < 200000) {
      const x = (rnd() - 0.5) * 22000 + 150, z = (rnd() - 0.5) * 22000;
      if (Math.abs(x - 150) < 750 && Math.abs(z) < 2750) continue;
      if (Math.abs(x) < 120 && z > 0 && z < 4000) continue;
      if (noiseB(x * 0.0009 + 3, z * 0.0009) < 0.15 && rnd() > 0.08) continue;
      const h = synthHeight(x, z);
      if (h < 2 || h > 1500) continue;
      const type = rnd() < 0.55 ? 0 : 1;
      if (counts[type] >= N) continue;
      const sc = 0.7 + rnd() * 0.8;
      p.set(x, h - 0.5, z); q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6.28); s.set(sc, sc * (0.8 + rnd() * 0.5), sc);
      m4.compose(p, q, s);
      meshes[type].setMatrixAt(counts[type], m4);
      col.setHSL(0.24 + rnd() * 0.08, 0.35 + rnd() * 0.2, 0.75 + rnd() * 0.35);
      meshes[type].setColorAt(counts[type], col);
      counts[type]++;
    }
    meshes.forEach((m, i) => { m.count = counts[i]; m.receiveShadow = true; m.frustumCulled = false; this.scene.add(m); });
  }

  buildTown() {
    const rnd = mulberry32(77);
    const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const facade = canvasTex(128, (ctx, s) => {
      ctx.fillStyle = '#d6d2c8'; ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) { ctx.fillStyle = '#3a4656'; ctx.fillRect(x * 32 + 8, y * 16 + 4, 16, 9); }
    });
    const townMat = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.75, emissiveMap: windowGlow(128, 4, 8, 0.45), emissive: new THREE.Color(1, 0.8, 0.5), emissiveIntensity: 0 });
    this.nightMats.push({ mat: townMat, max: 1.3 });
    const lights = [];
    const N = 1400, mesh = new THREE.InstancedMesh(g, townMat, N);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    let n = 0;
    for (const [cx, cz, r] of [[5200, -4200, 1500], [-4800, 3500, 1100], [2500, 7500, 900]]) {
      for (let i = 0; i < N / 3 && n < N; i++) {
        const a = rnd() * 6.28, d = Math.pow(rnd(), 0.7) * r;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        const h = synthHeight(x, z); if (h < 2) continue;
        const tall = (1 - d / r);
        p.set(Math.round(x / 30) * 30, h - 1, Math.round(z / 30) * 30); q.identity();
        s.set(12 + rnd() * 20, 6 + rnd() * 14 + Math.pow(tall, 3) * rnd() * 70, 10 + rnd() * 20);
        m4.compose(p, q, s); mesh.setMatrixAt(n, m4);
        for (let k = 0; k < 3; k++) lights.push({ p: [p.x + (rnd() - 0.5) * 40, p.y + 7, p.z + (rnd() - 0.5) * 40], c: rnd() < 0.7 ? [1, 0.6, 0.22] : [1, 0.93, 0.8] });
        col.setHSL(0.08 + rnd() * 0.05, 0.1 + rnd() * 0.15, 0.6 + rnd() * 0.35); mesh.setColorAt(n, col); n++;
      }
    }
    mesh.count = n; mesh.receiveShadow = true; mesh.frustumCulled = false;
    this.townLights = makePts(lights, null);
    this.scene.add(mesh);
  }

  onResize(heightPx, fovDeg) {
    const scale = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    this.glowMats.forEach(m => { m.uniforms.scale.value = scale; });
  }

  update(dt, camera, cloudDensity = 0) {
    this.time += dt;
    this.sky.position.copy(camera.position);
    const f = this.scene.fog;
    f.density = this.baseFogDensity + cloudDensity * cloudDensity * 0.02;
    f.color.copy(this.fogColor).lerp(new THREE.Color(0xd7dde4), Math.min(1, cloudDensity * 1.5));
    for (const r of this.runways) updateRunwayLights(r, camera, this.time);
    this.terrain?.update(camera.position);
  }
}
