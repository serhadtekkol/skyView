import * as THREE from 'three';
import { createNoise2D, fbm, lerp, mulberry32 } from './noise.js';

// Runway geometry in a runway-local frame: centre at origin, "le" threshold at +Z, "he" at -Z,
// so departing from le travels toward -Z.  Markings, numbers, edge/centre/end lights,
// and (for the active end) approach lights, sequenced flasher and PAPI.

export function canvasTex(size, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function noiseFill(ctx, size, lo, hi, tint = [1, 1, 1], seed = 1, blotch = 0) {
  const img = ctx.createImageData(size, size);
  const n = createNoise2D(seed);
  const rnd = mulberry32(seed);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = (x / size) * Math.PI * 2, b = (y / size) * Math.PI * 2;
    const v = fbm(n, Math.cos(a) * 1.3 + Math.sin(b) * 0.7, Math.sin(a) * 1.3 + Math.cos(b) * 0.9, 4) * 0.5 + 0.5;
    const g = lerp(lo, hi, v * (1 - blotch) + rnd() * blotch);
    const i = (y * size + x) * 4;
    img.data[i] = g * 255 * tint[0]; img.data[i + 1] = g * 255 * tint[1]; img.data[i + 2] = g * 255 * tint[2]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function makeGlowMaterial({ size = 1.2, minPx = 2.5, intensity = 4 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { size: { value: size }, minPx: { value: minPx }, scale: { value: 800 }, intensity: { value: intensity } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      uniform float size; uniform float minPx; uniform float scale;
      varying vec3 vColor; varying float vFade;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = size * scale / max(-mv.z, 0.1);
        gl_PointSize = clamp(max(px, minPx), 0.0, 64.0);
        vFade = clamp(px / minPx, 0.25, 1.0);
        vColor = color;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float intensity;
      varying vec3 vColor; varying float vFade;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float core = exp(-r * r * 9.0);
        float halo = exp(-r * r * 2.5) * 0.35;
        float a = (core + halo) * vFade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor * intensity * (core * 1.5 + halo), a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export function makePoints(list, mat) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(list.length * 3), col = new Float32Array(list.length * 3);
  list.forEach((l, i) => { pos.set(l.p, i * 3); col.set(l.c, i * 3); });
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

let _asphalt = null;
function asphaltTex() {
  if (!_asphalt) _asphalt = canvasTex(512, (ctx, s) => {
    noiseFill(ctx, s, 0.20, 0.30, [1, 1, 1.03], 11, 0.5);
    ctx.globalAlpha = 0.05;
    const r = mulberry32(3);
    for (let i = 0; i < 40; i++) { ctx.fillStyle = i % 2 ? '#000' : '#fff'; ctx.fillRect(r() * s, 0, 1 + r() * 3, s); }
  });
  return _asphalt;
}

function numberTex(id) {
  const num = id.replace(/[^0-9]/g, ''), letter = id.replace(/[0-9]/g, '');
  return canvasTex(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s); ctx.fillStyle = '#ecece6';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.save(); ctx.scale(0.6, 1);
    if (letter) {
      ctx.font = 'bold 128px "Arial Narrow", Arial, sans-serif';
      ctx.fillText(num, s / 2 / 0.6, s * 0.28);
      ctx.fillText(letter, s / 2 / 0.6, s * 0.76);
    } else {
      ctx.font = 'bold 230px "Arial Narrow", Arial, sans-serif';
      ctx.fillText(num, s / 2 / 0.6, s / 2 + 8);
    }
    ctx.restore();
  }, false);
}

/**
 * @param rw { len, wid, leId, heId }
 * @param active 'le' | 'he' | null   end that gets approach lights + PAPI
 * @returns { group, glowMats, papi, rabbit }
 */
export function buildRunway(rw, active = 'le') {
  const grp = new THREE.Group();
  const L = rw.len / 2, Wd = rw.wid;
  const glowMats = [];

  const tex = asphaltTex().clone(); tex.needsUpdate = true;
  tex.repeat.set(1, rw.len / Wd);
  const rwy = new THREE.Mesh(new THREE.PlaneGeometry(Wd, rw.len).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));
  rwy.position.y = 0.06; rwy.receiveShadow = true; grp.add(rwy);
  const sh = new THREE.Mesh(new THREE.PlaneGeometry(Wd + 14, rw.len + 120).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5a5953, roughness: 0.95 }));
  sh.position.y = 0.03; sh.receiveShadow = true; grp.add(sh);

  // markings
  const P = [], I = [];
  const rect = (cx, cz, w, l) => {
    const b = P.length / 3, y = 0.1;
    P.push(cx - w / 2, y, cz - l / 2, cx + w / 2, y, cz - l / 2, cx + w / 2, y, cz + l / 2, cx - w / 2, y, cz + l / 2);
    I.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  rect(-Wd / 2 + 1, 0, 0.9, rw.len - 4); rect(Wd / 2 - 1, 0, 0.9, rw.len - 4);
  const keys = Wd >= 55 ? 8 : Wd >= 44 ? 6 : 4;   // piano keys per side, scaled by width
  const keyGap = (Wd / 2 - 3) / keys;
  for (const s of [1, -1]) {
    const thr = s * L;
    for (let i = 0; i < keys; i++) { const off = 1.5 + i * keyGap; rect(off + 0.9, thr - s * 36, 1.8, 60); rect(-off - 0.9, thr - s * 36, 1.8, 60); }
    rect(0, thr - s * 2, Wd - 2, 1.8);
    if (rw.len > 2000) { rect(Wd * 0.2, thr - s * 400, Math.min(10, Wd * 0.22), 45); rect(-Wd * 0.2, thr - s * 400, Math.min(10, Wd * 0.22), 45); }
    for (const [d, n] of [[150, 3], [300, 2], [500, 2], [600, 1], [750, 1], [900, 1]]) {
      if (d > L - 200) continue;
      for (let j = 0; j < n; j++) { const off = Wd * 0.09 + j * 2.6; rect(off + 0.9, thr - s * d, 1.8, 22.5); rect(-off - 0.9, thr - s * d, 1.8, 22.5); }
    }
  }
  for (let z = -L + 130; z < L - 130; z += 60) rect(0, z + 18, 0.9, 36);
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  mg.setIndex(I); mg.computeVertexNormals();
  const marks = new THREE.Mesh(mg, new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.75 }));
  marks.receiveShadow = true; grp.add(marks);
  for (const [id, z, rot] of [[rw.leId, L - 100, 0], [rw.heId, -L + 100, Math.PI]]) {
    if (!id) continue;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(18, Wd * 0.42), 24).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: numberTex(id), transparent: true, roughness: 0.75, depthWrite: false }));
    m.rotation.y = rot; m.position.set(0, 0.11, z); grp.add(m);
  }

  // lights
  const E = 0.45;
  const white = [1, 0.95, 0.85], yellow = [1, 0.75, 0.25], green = [0.2, 1, 0.35], red = [1, 0.12, 0.08];
  const list = [];
  for (let z = -L; z <= L + 0.1; z += 60) {
    const caution = active === 'le' ? z < -L + 600 : active === 'he' ? z > L - 600 : false;
    list.push({ p: [-Wd / 2 - 1.5, E, z], c: caution ? yellow : white }, { p: [Wd / 2 + 1.5, E, z], c: caution ? yellow : white });
  }
  for (let x = -Wd / 2; x <= Wd / 2; x += 3) {
    const leGreen = active !== 'he';
    list.push({ p: [x, E, L + 2], c: leGreen ? green : red }, { p: [x, E, -L - 2], c: leGreen ? red : green });
  }
  for (let z = -L + 15; z < L; z += 15) {
    const toEnd = active === 'he' ? L - z : z + L;
    list.push({ p: [0, 0.14, z], c: toEnd < 300 ? red : toEnd < 900 ? (Math.round(z / 15) % 2 ? red : white) : white });
  }
  let papi = null, rabbit = null;
  if (active) {
    const s = active === 'le' ? 1 : -1;     // +Z for le
    for (let d = 60; d <= 900; d += 30) for (let x = -6; x <= 6; x += 3) list.push({ p: [x, 1 + d * 0.003, s * (L + d)], c: white });
    for (let x = -24; x <= 24; x += 3) list.push({ p: [x, 1.9, s * (L + 300)], c: white });
    const rl = [];
    for (let d = 900; d >= 330; d -= 30) rl.push({ p: [0, 1.5 + d * 0.003, s * (L + d)], c: [0, 0, 0] });
    const rmat = makeGlowMaterial({ size: 3.5, minPx: 5, intensity: 6 }); glowMats.push(rmat);
    rabbit = makePoints(rl, rmat); grp.add(rabbit);
    // PAPI on the pilot's left
    const pl = [];
    const side = active === 'le' ? -1 : 1;      // left of travel direction
    for (let i = 0; i < 4; i++) pl.push({ p: [side * (Wd / 2 + 15 + i * 9), 1.0, s * (L - 400)], c: white });
    const pmat = makeGlowMaterial({ size: 2.2, minPx: 4, intensity: 5 }); glowMats.push(pmat);
    papi = makePoints(pl, pmat); grp.add(papi);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    for (let i = 0; i < 4; i++) { const b = box.clone(); b.position.set(side * (Wd / 2 + 15 + i * 9), 0.45, s * (L - 399.4)); grp.add(b); }
  }
  const mat = makeGlowMaterial({ size: 1.1, minPx: 2.2, intensity: 3.5 }); glowMats.push(mat);
  grp.add(makePoints(list, mat));
  return { group: grp, glowMats, papi, rabbit };
}

const _v = new THREE.Vector3();
/** Per-frame PAPI colours (from camera glide angle) and rabbit sequencing. */
export function updateRunwayLights(rw, camera, time) {
  if (rw.papi) {
    const pc = rw.papi.geometry.attributes.color, pp = rw.papi.geometry.attributes.position;
    const thresholds = [3.5, 3.17, 2.83, 2.5];   // i=0 nearest the runway
    for (let i = 0; i < 4; i++) {
      _v.fromBufferAttribute(pp, i); rw.papi.localToWorld(_v);
      const ang = Math.atan2(camera.position.y - _v.y, Math.hypot(camera.position.x - _v.x, camera.position.z - _v.z)) * 180 / Math.PI;
      const w = ang > thresholds[i];
      pc.setXYZ(i, 1, w ? 0.95 : 0.1, w ? 0.85 : 0.06);
    }
    pc.needsUpdate = true;
  }
  if (rw.rabbit) {
    const rc = rw.rabbit.geometry.attributes.color, n = rc.count, ph = ((time * 2) % 1) * n | 0;
    for (let i = 0; i < n; i++) { const on = i === ph ? 1 : 0; rc.setXYZ(i, on, on, on); }
    rc.needsUpdate = true;
  }
}
