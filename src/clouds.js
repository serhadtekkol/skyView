import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm, smoothstep } from './noise.js';

// Lit, sorted billboard-puff cumulus field + a high cirrus layer.

function puffTexture() {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = createNoise2D(31);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S * 2 - 1, v = y / S * 2 - 1;
    const r = Math.hypot(u, v);
    const warp = fbm(n, u * 2.4 + 5, v * 2.4, 5) * 0.36;
    const detail = fbm(n, u * 5.8 + 11, v * 5.8 - 3, 4);
    let a = 1 - smoothstep(0.22, 0.96, r + warp);
    a = Math.pow(Math.max(0, a), 0.85) * (0.72 + 0.28 * (detail * 0.5 + 0.5));
    // R: vertical top-light, G: horizontal side normal (for sun-side lighting), B: billow crevice detail
    const topL = Math.min(1, Math.max(0, 0.54 - v * 0.48 + detail * 0.24));
    const sideN = Math.min(1, Math.max(0, 0.5 + u * 0.46 + fbm(n, u * 3.8 + 17, v * 3.8, 3) * 0.22));
    const billow = Math.min(1, Math.max(0, 0.5 + detail * 0.55));
    const i = (y * S + x) * 4;
    img.data[i] = topL * 255;
    img.data[i + 1] = sideN * 255;
    img.data[i + 2] = billow * 255;
    img.data[i + 3] = Math.max(0, Math.min(1, a)) * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function cirrusTexture() {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = createNoise2D(8);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const a = x / S * Math.PI * 2, b = y / S * Math.PI * 2;
    const X = Math.cos(a) * 1.0, Y = Math.sin(a) * 1.0, Z = Math.cos(b) * 4, W = Math.sin(b) * 4;
    let v = fbm(n, X + Z * 0.8, Y + W * 0.8, 6) * 0.5 + 0.5;
    v = smoothstep(0.5, 0.85, v);
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = v * 200;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class Clouds {
  constructor(scene, sunDir, fog, { count = 110, seed = 3, base = 1550, storms = 5, deck = null, rain = 0, stormNear = false } = {}) {
    this.scene = scene;
    this.base = base; this.deckCfg = deck; this.rain = rain;
    const rnd = mulberry32(seed);
    const puffs = [];
    this.clusters = [];
    for (let c = 0; c < count; c++) {
      // denser coverage away from the airport so take-off view is open-ish
      const ang = rnd() * Math.PI * 2, dist = 2500 + Math.pow(rnd(), 0.8) * 32000;
      const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
      const R = 350 + rnd() * 900, H = 250 + rnd() * 650 * (R / 900);
      const cb = base + (rnd() - 0.5) * 120;
      // radar reflectivity grows with vertical development (light showers in tall cumulus)
      const start = puffs.length;
      const n = Math.round(14 + (R / 1250) * 40);
      for (let i = 0; i < n; i++) {
        const t = Math.pow(rnd(), 1.4);                // more puffs low (flat base, towering top)
        const y = t * H;
        const rr = R * (1 - 0.65 * t) * Math.sqrt(rnd());
        const a = rnd() * Math.PI * 2;
        const size = (0.32 + rnd() * 0.35) * R * (1 - 0.35 * t) + 80;
        puffs.push({
          x: cx + Math.cos(a) * rr, y: cb + y + size * 0.15, z: cz + Math.sin(a) * rr * 0.8,
          s: size, rot: rnd() * 6.283, shade: 0.25 + 0.75 * (y / H), a: 0.55 + rnd() * 0.35,
        });
      }
      this.clusters.push({ x: cx, z: cz, y0: cb, y1: cb + H, r: R, wx: Math.max(0, (H - 350) / 900) * 0.55, storm: false, start, len: puffs.length - start });
    }
    // ---- storm cells (cumulonimbus): tall dark towers with an anvil, heavy rain and turbulence
    for (let k = 0; k < storms; k++) {
      const ang = rnd() * Math.PI * 2, dist = (stormNear && k < 3 ? 6000 : 14000) + rnd() * (stormNear && k < 3 ? 6000 : 24000);
      const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
      const R = 1300 + rnd() * 1000, H = 4200 + rnd() * 3200;
      const cb = base - 250 + rnd() * 150;
      const start = puffs.length;
      const n = 120;
      for (let i = 0; i < n; i++) {
        const t = i < n * 0.78 ? Math.pow(rnd(), 0.9) * 0.82 : 0.82 + rnd() * 0.18;   // column, then anvil
        const y = t * H;
        const prof = t < 0.82 ? 0.5 + 0.15 * Math.sin(t * 9) : 1.15 + (t - 0.82) * 2.2;   // anvil spreads
        const rr = R * prof * Math.sqrt(rnd());
        const a = rnd() * Math.PI * 2;
        const size = (t < 0.82 ? 0.38 : 0.5) * R * (0.7 + rnd() * 0.6) + 200;
        puffs.push({
          x: cx + Math.cos(a) * rr, y: cb + y, z: cz + Math.sin(a) * rr * (t < 0.82 ? 0.85 : 0.6),
          s: size, rot: rnd() * 6.283, shade: 0.05 + 0.8 * Math.pow(t, 1.5), a: 0.7 + rnd() * 0.25,
        });
      }
      this.clusters.push({ x: cx, z: cz, y0: cb, y1: cb + H, r: R, wx: 1.6 + rnd() * 0.8, storm: true, start, len: puffs.length - start });
    }
    this.count = puffs.length;
    this.puffs = puffs;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 4), 4); // size, rot, shade, alpha
    this.aOffset.setUsage(THREE.DynamicDrawUsage); this.aParams.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('offset', this.aOffset);
    geo.setAttribute('params', this.aParams);
    geo.instanceCount = this.count;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: puffTexture() },
        sunDir: { value: sunDir.clone() },
        litColor: { value: new THREE.Color(1.62, 1.56, 1.48) },
        shadowColor: { value: new THREE.Color(0.42, 0.50, 0.64) },
        fogColor: { value: fog.color },
        fogDensity: { value: fog.density },
        flash: { value: new THREE.Vector4(0, 0, 0, 0) },
        uGolden: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 offset; attribute vec4 params;
        varying vec2 vUv; varying float vShade; varying float vAlpha; varying vec3 vWorld; varying float vSunSide;
        uniform vec3 sunDir;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){
          vec4 mv = viewMatrix * vec4(offset, 1.0);
          float c = cos(params.y), s = sin(params.y);
          vec2 p = vec2(c*position.x - s*position.y, s*position.x + c*position.y) * params.x;
          // keep the baked "top light" pointing up-ish: only small rotations
          p = mix(position.xy * params.x, p, 0.22);
          mv.xy += p;
          vWorld = offset;
          // camera right vector in world space is row 0 of viewMatrix
          vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vSunSide = dot(normalize(sunDir), normalize(camRight));
          float d = length(mv.xyz);
          // keep cloud puffs solid right up to the wings/cockpit so clouds never vanish before entry
          vAlpha = params.w * smoothstep(params.x * 0.03, params.x * 0.28, d);
          vShade = params.z;
          vUv = uv;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform vec3 sunDir, litColor, shadowColor, fogColor; uniform float fogDensity, uGolden; uniform vec4 flash;
        varying vec2 vUv; varying float vShade; varying float vAlpha; varying vec3 vWorld; varying float vSunSide;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          vec4 t = texture2D(map, vUv);
          float a = t.a * vAlpha;
          if (a < 0.004) discard;
          vec3 V = normalize(vWorld - cameraPosition);
          vec3 S = normalize(sunDir);
          float mu = dot(V, S);
          // directional sculpted shading: top light + sun-facing side light + billow crevice contrast
          float sideTerm = (t.g - 0.5) * vSunSide * 0.55;
          float rawLit = vShade * 0.62 + t.r * 0.48 + sideTerm + (t.b - 0.5) * 0.22;
          float lit = smoothstep(0.10, 0.94, clamp(rawLit, 0.0, 1.0));
          // Henyey-Greenstein forward scattering + crisp silver/gold lining on sun-facing edges
          float g = 0.72;
          float hg = (1.0 - g * g) / (4.0 * 3.14159 * pow(max(1.0 + g * g - 2.0 * g * mu, 0.05), 1.5));
          float edgeMask = (1.0 - t.a * 0.78) * (0.45 + 0.55 * t.r);
          float silver = (pow(max(mu, 0.0), 7.0) * 1.45 + hg * 0.32) * edgeMask * (1.0 + uGolden * 0.75);
          // warm golden rim boost on sunlit tops during golden hour
          vec3 col = mix(shadowColor, litColor, lit) + litColor * silver;
          // Beer-powder soft highlight when looking down-sun
          col *= 0.90 + 0.16 * max(-mu, 0.0);
          col += vec3(1.0, 1.0, 1.15) * flash.w * exp(-length(vWorld - flash.xyz) / 2600.0) * (0.55 + 0.45 * t.r);   // lightning
          float d = length(vWorld - cameraPosition);
          float f = 1.0 - exp(-fogDensity * fogDensity * d * d * 0.50);
          col = mix(col, fogColor, f);
          gl_FragColor = vec4(col, a * (1.0 - f * 0.45));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);

    this.order = new Uint32Array(this.count).map((_, i) => i);
    this.dist = new Float32Array(this.count);
    this.drift = new THREE.Vector3(4, 0, 2.5);   // m/s wind drift
    this.offsetT = 0;
    this.frame = 0;
    this.writeBuffers(new THREE.Vector3());

    // high cirrus layer
    const ct = cirrusTexture();
    ct.repeat.set(6, 6);
    const cm = new THREE.MeshBasicMaterial({ map: ct, transparent: true, opacity: 0.55, depthWrite: false, fog: false, color: 0xf4f7ff });
    this.cirrus = new THREE.Mesh(new THREE.PlaneGeometry(160000, 160000).rotateX(Math.PI / 2), cm);
    this.cirrus.position.y = 9500;
    this.cirrus.renderOrder = 4;
    scene.add(this.cirrus);

    // ---- overcast deck: two textured layers (dark base, sunlit top) with whiteout in between
    if (deck) {
      const tex = cirrusTexture();
      tex.repeat.set(14, 14);
      const mk = (y, flip, color, op) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000).rotateX(flip ? Math.PI / 2 : -Math.PI / 2),
          new THREE.MeshBasicMaterial({ map: tex, alphaMap: null, transparent: true, opacity: op, depthWrite: false, color, fog: true }));
        m.position.y = y; m.renderOrder = 3; scene.add(m); return m;
      };
      // solid-ish underlay so the deck is opaque from below, textured layer for structure
      const under = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8a9096, transparent: true, opacity: 0.92 * deck.cover, depthWrite: false, fog: true }));
      under.position.y = deck.base; under.renderOrder = 2; scene.add(under);
      const over = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xf2f4f7, transparent: true, opacity: 0.95 * deck.cover, depthWrite: false, fog: true }));
      over.position.y = deck.top; over.renderOrder = 2; scene.add(over);
      this.deck = { under, over, base: mk(deck.base - 1, true, 0x6f767d, 0.85), top: mk(deck.top + 1, false, 0xffffff, 0.8), tex };
    }
  }

  dispose() {
    const objs = [this.mesh, this.cirrus];
    if (this.deck) objs.push(this.deck.under, this.deck.over, this.deck.base, this.deck.top);
    for (const o of objs) { o.parent?.remove(o); o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); }
  }

  /** Cloud colours for the time of day / weather (linear RGB multipliers). */
  setLighting(lit, shadow, deckLit, deckShadow, golden = 0) {
    this.material.uniforms.litColor.value.copy(lit);
    this.material.uniforms.shadowColor.value.copy(shadow);
    this.material.uniforms.uGolden.value = golden;
    this.cirrus.material.color.copy(lit).multiplyScalar(0.62 + golden * 0.14);
    if (this.deck) {
      this.deck.over.material.color.copy(deckLit); this.deck.top.material.color.copy(deckLit);
      this.deck.under.material.color.copy(deckShadow); this.deck.base.material.color.copy(deckShadow).multiplyScalar(0.85);
    }
  }

  /** Lightning flash at a world position (intensity decays in update). */
  flashAt(p, k = 2.5) { this.material.uniforms.flash.value.set(p.x, p.y, p.z, k); }

  writeBuffers(cam) {
    const n = this.count, P = this.puffs, D = this.dist, O = this.order;
    const ox = this.drift.x * this.offsetT, oz = this.drift.z * this.offsetT;
    for (let i = 0; i < n; i++) { const p = P[i]; const dx = p.x + ox - cam.x, dy = p.y - cam.y, dz = p.z + oz - cam.z; D[i] = dx * dx + dy * dy + dz * dz; }
    O.sort((a, b) => D[b] - D[a]);   // far -> near
    const off = this.aOffset.array, par = this.aParams.array;
    for (let k = 0; k < n; k++) {
      const p = P[O[k]];
      off[k * 3] = p.x + ox; off[k * 3 + 1] = p.y; off[k * 3 + 2] = p.z + oz;
      par[k * 4] = p.s; par[k * 4 + 1] = p.rot; par[k * 4 + 2] = p.shade; par[k * 4 + 3] = p.a;
    }
    this.aOffset.needsUpdate = true; this.aParams.needsUpdate = true;
  }

  /** Returns 0..1 "inside cloud" density at a position. */
  densityAt(pos) {
    const ox = this.drift.x * this.offsetT, oz = this.drift.z * this.offsetT;
    let d = 0;
    if (this.deckCfg) { const k = this.deckCfg; if (pos.y > k.base - 40 && pos.y < k.top + 40) d = k.cover * Math.min(1, Math.min(pos.y - k.base + 40, k.top + 40 - pos.y) / 120); }
    for (const c of this.clusters) {
      if (pos.y < c.y0 - 30 || pos.y > c.y1 + 30) continue;
      const t = (pos.y - c.y0) / (c.y1 - c.y0);
      const r = c.r * (1 - 0.6 * Math.max(0, t)) * 0.85;
      const h = Math.hypot(pos.x - c.x - ox, pos.z - c.z - oz);
      if (h < r) d = Math.max(d, smoothstep(r, r * 0.55, h) * smoothstep(c.y0 - 30, c.y0 + 60, pos.y) * smoothstep(c.y1 + 30, c.y1 - 120, pos.y));
    }
    return d;
  }

  /** Turbulence severity at a position: storm cells are ~3x rougher than fair-weather cumulus. */
  turbAt(pos) {
    const ox = this.drift.x * this.offsetT, oz = this.drift.z * this.offsetT;
    let t = 0;
    for (const c of this.clusters) {
      const h = Math.hypot(pos.x - c.x - ox, pos.z - c.z - oz);
      const reach = c.r * (c.storm ? 1.15 : 0.85);
      const yPad = c.storm ? 150 : 40;
      if (h > reach || pos.y < c.y0 - yPad || pos.y > c.y1 + 80) continue;
      const k = (1 - h / reach) * (c.storm ? 3 : 1);
      t = Math.max(t, k);
    }
    return t;
  }

  /**
   * Weather-radar reflectivity (0 .. ~2.4) at a horizontal point for a beam spanning [yLo, yHi].
   * Rain shafts extend from the cloud base to the ground.
   */
  wxAt(x, z, yLo, yHi) {
    const ox = this.drift.x * this.offsetT, oz = this.drift.z * this.offsetT;
    let best = 0;
    // stratiform rain under an overcast deck: weak, patchy returns
    if (this.rain > 0 && this.deckCfg && yLo < this.deckCfg.top) {
      const n = Math.sin(x * 0.00031 + Math.cos(z * 0.00023)) * Math.cos(z * 0.00041 - x * 0.00013);
      best = Math.max(0, this.rain * (0.32 + 0.38 * n));
    }
    for (const c of this.clusters) {
      if (c.wx <= 0.02) continue;
      const dx = x - c.x - ox, dz = z - c.z - oz;
      const rr = c.r * (c.storm ? 0.85 : 0.7);
      const d2 = dx * dx + dz * dz;
      if (d2 > rr * rr) continue;
      if (yHi < -1e5 || yLo > c.y1 || yHi < (c.storm ? -1e9 : c.y0 - 600)) continue;   // beam misses the cell
      const f = 1 - Math.sqrt(d2) / rr;
      const v = c.wx * (c.storm ? Math.pow(f, 0.6) * (0.6 + 0.4 * Math.sin(dx * 0.004) * Math.cos(dz * 0.005)) : f);
      if (v > best) best = v;
    }
    return best;
  }

  wrapAround(pos) {
    const WRAP = 80000, HALF = 40000;
    const ox = this.drift.x * this.offsetT, oz = this.drift.z * this.offsetT;
    let moved = false;
    for (const c of this.clusters) {
      let sx = 0, sz = 0;
      const dx = c.x + ox - pos.x, dz = c.z + oz - pos.z;
      if (dx < -HALF) sx = Math.ceil((-HALF - dx) / WRAP) * WRAP;
      else if (dx > HALF) sx = -Math.ceil((dx - HALF) / WRAP) * WRAP;
      if (dz < -HALF) sz = Math.ceil((-HALF - dz) / WRAP) * WRAP;
      else if (dz > HALF) sz = -Math.ceil((dz - HALF) / WRAP) * WRAP;
      if (sx || sz) {
        c.x += sx; c.z += sz;
        for (let i = c.start; i < c.start + c.len; i++) { this.puffs[i].x += sx; this.puffs[i].z += sz; }
        moved = true;
      }
    }
    return moved;
  }

  update(dt, camera) {
    this.offsetT += dt;
    const fl = this.material.uniforms.flash.value; if (fl.w > 0) fl.w = Math.max(0, fl.w - dt * 9);
    const cp = camera.position;
    const wrapped = this.wrapAround(cp);
    this.cirrus.position.x = cp.x; this.cirrus.position.z = cp.z;
    this.cirrus.material.map.offset.set(cp.x * (6 / 160000) + this.offsetT * 0.0004, -cp.z * (6 / 160000));
    if (this.deck) {
      for (const m of [this.deck.under, this.deck.over, this.deck.base, this.deck.top]) { m.position.x = cp.x; m.position.z = cp.z; }
      this.deck.tex.offset.set(cp.x * (14 / 200000) + this.offsetT * 0.00015, -cp.z * (14 / 200000) + this.offsetT * 0.00009);
    }
    this.material.uniforms.fogDensity.value = this.scene.fog.density;
    if (wrapped || (this.frame++ % 6) === 0) this.writeBuffers(cp);
  }
}
