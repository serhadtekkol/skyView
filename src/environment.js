import * as THREE from 'three';
import { smoothstep, clamp, lerp, mulberry32 } from './noise.js';

// Time of day + weather: sun/moon, sky, stars, fog, exposure, precipitation (rain streaks /
// snow flakes), lightning, runway surface, snow cover, night lights, and the physics
// inputs (temperature -> air density, surface friction, wind).

export const WEATHER = {
  clear:     { label: 'Açık',              clouds: { count: 28, storms: 0 }, fog: 0.75, tint: 0xb9cbdd, sun: 1.0,  wind: [330, 6],  turb: 0.35, oat: 18, precip: null, surface: 'dry',  snow: 0 },
  scattered: { label: 'Parçalı bulutlu',   clouds: { count: 110, storms: 5 }, fog: 1.0, tint: 0xb9cbdd, sun: 1.0,  wind: [340, 8],  turb: 0.6,  oat: 15, precip: null, surface: 'dry',  snow: 0 },
  rain:      { label: 'Kapalı · yağmurlu', clouds: { count: 60, storms: 1, deck: { agl: 700, thick: 900, cover: 1 }, rain: 1 }, fog: 3.2, tint: 0x8e979f, sun: 0.32, wind: [250, 14], turb: 0.9, oat: 9, precip: 'rain', surface: 'wet', snow: 0, intensity: 1 },
  storm:     { label: 'Fırtınalı',         clouds: { count: 90, storms: 14, stormNear: true, deck: { agl: 900, thick: 700, cover: 0.85 }, rain: 1.4 }, fog: 2.6, tint: 0x6d757c, sun: 0.4, wind: [220, 24], turb: 1.6, oat: 21, precip: 'rain', surface: 'wet', snow: 0, intensity: 1.6, lightning: true },
  snow:      { label: 'Karlı · soğuk',     clouds: { count: 50, storms: 0, deck: { agl: 600, thick: 1100, cover: 1 }, rain: 0.6 }, fog: 3.6, tint: 0xc2c9d0, sun: 0.38, wind: [20, 11], turb: 0.7, oat: -7, precip: 'snow', surface: 'snow', snow: 0.9, intensity: 1 },
};
export const WEATHER_IDS = Object.keys(WEATHER);
export const TIME_SCALES = [1, 10, 60, 300, 0];
const TIME_SCALE_KEY = 'skyview.timeScale';
const MU = { dry: 1.0, wet: 0.62, snow: 0.36 };

export function hourLabel(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60);
  const part = h < 5 || h >= 21 ? 'Gece' : h < 7 ? 'Şafak' : h < 17 ? 'Gündüz' : h < 19.5 ? 'Akşamüstü' : 'Alacakaranlık';
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${part}`;
}

/** Sun elevation/azimuth (deg) for a local solar hour (simple mid-latitude model). */
function sunAt(hour) {
  const elev = 58 * Math.sin(Math.PI * (hour - 6.3) / 12.6);   // sunrise ~06:20, sunset ~18:50
  const azim = 180 + (hour - 12) * 15;                 // 06h east, 12h south, 18h west
  return { elev: Math.max(elev, -40), azim };
}

class Precip {
  constructor(scene, kind) {
    this.kind = kind;
    const N = kind === 'rain' ? 9000 : 7000;
    const rnd = mulberry32(17);
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(N * (kind === 'rain' ? 2 : 1) * 3), end = new Float32Array(N * (kind === 'rain' ? 2 : 1));
    for (let i = 0; i < N; i++) {
      const s = [rnd(), rnd(), rnd()];
      if (kind === 'rain') { seed.set(s, i * 6); seed.set(s, i * 6 + 3); end[i * 2] = 0; end[i * 2 + 1] = 1; }
      else { seed.set(s, i * 3); end[i] = rnd(); }
    }
    g.setAttribute('position', new THREE.BufferAttribute(seed, 3));   // seeds in [0,1]^3 (position is just storage)
    g.setAttribute('endk', new THREE.BufferAttribute(end, 1));
    this.uniforms = {
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(70, 45, 70) },
      uFall: { value: new THREE.Vector3() }, uRel: { value: new THREE.Vector3() }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0.75, 0.8, 0.88) },
    };
    const common = /* glsl */`
      attribute float endk;
      uniform float uTime; uniform vec3 uCam, uBox, uFall, uRel;
      varying float vA;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      vec3 dropPos(){
        vec3 p = position * uBox + uFall * uTime - uCam + 0.5 * uBox;
        p = mod(p, uBox) - 0.5 * uBox;
        vA = 1.0 - smoothstep(0.30, 0.5, length(p.xz / uBox.xz));        // fade towards the box edge
        return p + uCam;
      }`;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: kind === 'rain' ? /* glsl */`${common}
        void main(){
          vec3 w = dropPos();
          w -= uRel * 0.028 * endk;                       // streak along the relative wind
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
          #include <logdepthbuf_vertex>
        }` : /* glsl */`${common}
        void main(){
          vec3 w = dropPos();
          w.x += sin(uTime * 1.3 + endk * 40.0) * 0.6; w.z += cos(uTime * 1.1 + endk * 31.0) * 0.6;   // flutter
          vec4 mv = viewMatrix * vec4(w, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(40.0 / -mv.z, 1.0, 7.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform vec3 uColor; varying float vA;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          ${kind === 'snow' ? 'vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard; float a = (1.0 - r * 4.0);' : 'float a = 1.0;'}
          gl_FragColor = vec4(uColor, uOpacity * vA * a);
        }`,
    });
    this.obj = kind === 'rain' ? new THREE.LineSegments(g, mat) : new THREE.Points(g, mat);
    this.obj.frustumCulled = false; this.obj.renderOrder = 8;
    scene.add(this.obj);
  }
  dispose() { this.obj.parent?.remove(this.obj); this.obj.geometry.dispose(); this.obj.material.dispose(); }
}

export class Environment {
  constructor(scene, renderer, world, { hour = 14, weather = 'scattered' } = {}) {
    this.scene = scene; this.renderer = renderer; this.world = world;
    this.hour = hour; this.weatherId = WEATHER[weather] ? weather : 'scattered';
    this.timeScale = 1;
    try {
      const saved = Number(localStorage.getItem(TIME_SCALE_KEY));
      if (TIME_SCALES.includes(saved)) this.timeScale = saved;
    } catch { /* ignore */ }
    this._lastIblElev = null;
    this._lastIblNight = null;
    this.uSnow = { value: 0 };
    this.time = 0; this.nextFlash = 3;
    // stars
    const rnd = mulberry32(99), N = 2600, p = new Float32Array(N * 3), c = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const v = new THREE.Vector3(r * Math.cos(t), Math.abs(u) * 0.98 + 0.02, r * Math.sin(t)).normalize().multiplyScalar(15000);
      p.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + Math.pow(rnd(), 3) * 1.6, w = rnd();
      c.set([b * (0.85 + 0.15 * w), b * 0.9, b * (1.1 - 0.2 * w)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(p, 3)); sg.setAttribute('color', new THREE.BufferAttribute(c, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2.0, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.renderOrder = -8; this.stars.frustumCulled = false;
    scene.add(this.stars);

    // smooth twilight / midnight sky dome (replaces Preetham banding below horizon)
    this.moonDir = new THREE.Vector3(-0.42, 0.52, 0.74).normalize();
    this.nightDome = new THREE.Mesh(
      new THREE.SphereGeometry(18000, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
        uniforms: {
          uOpacity: { value: 0 },
          uZenith: { value: new THREE.Color(0x030712) },
          uHorizon: { value: new THREE.Color(0x101c33) },
          uGlowCol: { value: new THREE.Color(0xd96b38) },
          uGlowAmt: { value: 0 },
          uSunDir: { value: new THREE.Vector3(0, 0, -1) },
          uMoonDir: { value: this.moonDir.clone() },
          uMoonVis: { value: 0 },
        },
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform float uOpacity, uGlowAmt, uMoonVis;
          uniform vec3 uZenith, uHorizon, uGlowCol, uSunDir, uMoonDir;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = clamp(d.y, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(h, 0.52));
            // warm dusk/dawn glow concentrated near the sun azimuth along the horizon
            float sunAz = max(0.0, dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-4, 0.0, 0.0))));
            float band = exp(-abs(d.y) * 7.0) * pow(sunAz, 3.0) * uGlowAmt;
            col += uGlowCol * band;
            // crisp moon disc + soft halo
            float md = dot(d, normalize(uMoonDir));
            float disc = smoothstep(0.99935, 0.99955, md);
            float halo = pow(max(md, 0.0), 48.0) * 0.22 + pow(max(md, 0.0), 6.0) * 0.035;
            col += (vec3(0.92, 0.95, 1.0) * disc * 1.4 + vec3(0.45, 0.6, 0.9) * halo) * uMoonVis;
            gl_FragColor = vec4(col, uOpacity);
          }`,
      }),
    );
    this.nightDome.renderOrder = -9;
    this.nightDome.frustumCulled = false;
    scene.add(this.nightDome);

    // HDR sun disc + Mie atmospheric corona + golden-hour horizon scatter (additive over Sky)
    this.sunDome = new THREE.Mesh(
      new THREE.SphereGeometry(18500, 48, 28),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uSunDir: { value: new THREE.Vector3(0, 0.5, -1) },
          uSunCol: { value: new THREE.Color(1.0, 0.94, 0.82) },
          uGlowCol: { value: new THREE.Color(1.0, 0.58, 0.24) },
          uIntensity: { value: 1.0 },
          uGolden: { value: 0.0 },
        },
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uSunDir, uSunCol, uGlowCol;
          uniform float uIntensity, uGolden;
          varying vec3 vDir;
          void main() {
            if (uIntensity <= 0.001) discard;
            vec3 d = normalize(vDir);
            vec3 s = normalize(uSunDir);
            float mu = max(dot(d, s), 0.0);
            // mask below horizon softly so sun/glow doesn't bleed under the earth
            float above = smoothstep(-0.04, 0.03, d.y);
            // crisp HDR solar disc (> 6.0 linear) so high-threshold bloom halos the sun without blooming the fuselage
            float disc = smoothstep(0.99952, 0.99986, mu) * 6.8;
            // tight hot inner corona + warm Mie aureole
            float corona = pow(mu, 240.0) * 1.95 + pow(mu, 32.0) * (0.20 + 0.24 * uGolden);
            float wideMie = pow(mu, 6.0) * (0.03 + 0.09 * uGolden);
            // warm golden-hour atmospheric horizon scatter band concentrated toward sun azimuth
            vec2 dh = normalize(vec2(d.x, d.z) + vec2(1e-5, 0.0));
            vec2 sh = normalize(vec2(s.x, s.z) + vec2(1e-5, 0.0));
            float az = max(dot(dh, sh), 0.0);
            float horizBand = exp(-max(d.y, 0.0) * 8.0) * (0.14 + 0.86 * pow(az, 2.2)) * uGolden * 0.34;
            vec3 col = uSunCol * (disc + corona) + uGlowCol * (wideMie + horizBand);
            gl_FragColor = vec4(col * uIntensity * above, 1.0);
          }`,
      }),
    );
    this.sunDome.renderOrder = -9;
    this.sunDome.frustumCulled = false;
    scene.add(this.sunDome);

    // moonlight
    this.moon = new THREE.DirectionalLight(0xaec6ff, 0);
    this.moon.position.copy(this.moonDir).multiplyScalar(1000);
    scene.add(this.moon);
    // created before World.init(): the world binds terrain / town lights to us as it builds them
    world.env = this;
    world.attachNightLights?.(this);
    this.precip = null;
    this.apply();
  }

  get weather() { return WEATHER[this.weatherId]; }

  /** Clouds constructor options for the current weather. */
  cloudOptions(baseElev) {
    const w = this.weather.clouds;
    return {
      count: w.count, storms: w.storms, stormNear: !!w.stormNear, rain: w.rain || 0, base: baseElev + (w.deck ? w.deck.agl + w.deck.thick + 900 : 1500),
      deck: w.deck ? { base: baseElev + w.deck.agl, top: baseElev + w.deck.agl + w.deck.thick, cover: w.deck.cover } : null,
    };
  }

  /** Physics inputs for the flight model. */
  applyToFlight(fm, elev) {
    const w = this.weather;
    fm.setWind(w.wind[0], w.wind[1]);
    fm.turbulence = w.turb;
    // temperature deviation from ISA at the field -> air density everywhere
    fm.isaDev = w.oat - (15 - 0.0065 * elev);
    fm.surfaceMu = MU[w.surface];
    fm.surface = w.surface;
    fm.oat = w.oat;
  }

  decorateTerrain(mat) {
    const uSnow = this.uSnow, prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.uniforms.uSnow = uSnow;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
            float cover = uSnow * smoothstep(0.04, 0.22, lum) * (0.75 + 0.25 * sin(vViewPosition.x * 0.01));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.93) * (0.75 + 0.35 * lum), clamp(cover, 0.0, 0.95));
          }`);
    };
    mat.customProgramCacheKey = () => 'snowy';
    mat.needsUpdate = true;
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; this.apply({ rebuildIbl: true, updateSurface: false }); }

  setTimeScale(scale) {
    this.timeScale = Math.max(0, Number(scale) || 0);
    try { localStorage.setItem(TIME_SCALE_KEY, String(this.timeScale)); } catch { /* ignore */ }
    return this.timeScale;
  }

  cycleTimeScale() {
    const idx = TIME_SCALES.indexOf(this.timeScale);
    return this.setTimeScale(TIME_SCALES[(idx + 1) % TIME_SCALES.length]);
  }

  apply({ rebuildIbl = true, updateSurface = true } = {}) {
    const w = this.weather, world = this.world;
    const { elev, azim } = sunAt(this.hour);
    this.sunElev = elev;
    const e = THREE.MathUtils.degToRad(Math.max(elev, -12)), a = THREE.MathUtils.degToRad(azim);
    world.sunDir.set(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)).normalize();
    const day = smoothstep(-7, 7, elev), golden = smoothstep(20, 2, elev) * smoothstep(-6, 1, elev);
    const dusk = smoothstep(6, -8, elev) * smoothstep(-14, -2, elev);
    this.day = day; this.night = 1 - smoothstep(-8, 2, elev);
    // sky shader: keep sun clamped near horizon so Preetham never bands into black; nightDome takes over smoothly
    const u = world.sky.material.uniforms;
    const skyElev = THREE.MathUtils.degToRad(Math.max(elev, 0.5));
    u.sunPosition.value.set(Math.cos(skyElev) * Math.sin(a), Math.sin(skyElev), -Math.cos(skyElev) * Math.cos(a)).normalize();
    u.turbidity.value = w.precip ? 8 : 2.1 + golden * 1.8;
    u.rayleigh.value = w.precip ? 0.6 : 1.55 + golden * 1.35;
    u.mieCoefficient.value = w.precip ? 0.012 : 0.0022 + golden * 0.0028;
    u.mieDirectionalG.value = w.precip ? 0.72 : 0.86 + golden * 0.05;
    if (u.uSkyGain) u.uSkyGain.value = w.precip ? 0.50 : lerp(0.38, 0.27, golden);
    // HDR sun disc & golden-hour atmospheric scatter dome
    const su = this.sunDome.material.uniforms;
    su.uSunDir.value.copy(world.sunDir);
    su.uSunCol.value.setRGB(1.0, 0.95, 0.86).lerp(new THREE.Color(1.0, 0.68, 0.30), golden);
    su.uGlowCol.value.setRGB(1.0, 0.80, 0.54).lerp(new THREE.Color(1.0, 0.38, 0.09), golden);
    su.uGolden.value = golden;
    this.sunDomeBase = smoothstep(-1.5, 2.8, elev) * (w.precip ? 0.18 : 1.0);
    su.uIntensity.value = this.sunDomeBase;
    // twilight / night dome
    const nu = this.nightDome.material.uniforms;
    nu.uOpacity.value = smoothstep(3.5, -5.5, elev);
    nu.uZenith.value.setHex(0x030712).lerp(new THREE.Color(0x0f1a36), dusk * 0.65);
    nu.uHorizon.value.setHex(0x0b1528).lerp(new THREE.Color(0x2a253d), dusk * 0.75);
    nu.uGlowAmt.value = (dusk * 0.9 + golden * 0.45) * (w.precip ? 0.25 : 1);
    nu.uSunDir.value.copy(world.sunDir);
    nu.uMoonVis.value = this.night * (w.clouds.deck ? 0.12 : 1);
    const needIbl = rebuildIbl || this._lastIblElev == null
      || Math.abs(elev - this._lastIblElev) >= 0.45
      || Math.abs(this.night - this._lastIblNight) >= 0.04;
    if (needIbl) {
      this._lastIblElev = elev;
      this._lastIblNight = this.night;
      world.rebuildEnvironment?.(this.night, w.precip ? 0.45 : 1);
    }
    // lights
    const sunCol = new THREE.Color().setRGB(1, 0.95, 0.86).lerp(new THREE.Color(1, 0.54, 0.22), golden);
    world.sun.color.copy(sunCol);
    this.sunBase = (3.6 + golden * 0.6) * smoothstep(-1.5, 6, elev);
    world.hemi.intensity = 0.16 + 0.26 * day;
    world.hemi.color.setRGB(0.24, 0.36, 0.64).lerp(new THREE.Color(0.95, 0.68, 0.48), golden * 0.55).lerp(new THREE.Color(0.72, 0.84, 1), day * (1 - golden * 0.35));
    world.hemi.groundColor.setRGB(0.05, 0.06, 0.09).lerp(new THREE.Color(0.32, 0.36, 0.26), day);
    this.moon.intensity = 0.42 * this.night * (w.precip ? 0.35 : 1);
    this.scene.environmentIntensity = 0.28 + 0.82 * day;
    this.renderer.toneMappingExposure = lerp(0.98, 0.92 + golden * 0.08, day) * (w.precip ? 1.05 : 1);
    this.postfx?.setEnvironment({ day, golden, night: this.night, precip: !!w.precip });
    // fog matched to horizon color (warm golden-amber atmospheric haze at sunset/sunrise)
    const dayFog = new THREE.Color(w.tint).lerp(new THREE.Color(0xe09b63), golden * (w.precip ? 0.22 : 0.72));
    const duskFog = new THREE.Color(0x202236);
    const nightFog = new THREE.Color(0x091222);
    world.fogColor.copy(nightFog).lerp(duskFog, dusk * 0.85).lerp(dayFog, day);
    world.baseFogDensity = (w.precip ? 0.000028 : lerp(0.000020, 0.000026, day)) * w.fog;
    // clouds: sculpted sunlit tops + warm golden-hour rim vs deep cool slate shadows
    if (this.clouds) {
      const dayLit = new THREE.Color(1.62, 1.56, 1.48).lerp(new THREE.Color(2.05, 1.12, 0.56), golden * 0.88);
      const daySh = new THREE.Color(0.42, 0.50, 0.64).lerp(new THREE.Color(0.22, 0.22, 0.38), golden * 0.78);
      const nightLit = new THREE.Color(0.18, 0.23, 0.34);
      const nightSh = new THREE.Color(0.04, 0.06, 0.11);
      const lit = nightLit.clone().lerp(dayLit, day);
      const sh = nightSh.clone().lerp(daySh, day);
      if (w.precip) sh.multiplyScalar(0.75);
      const deckTop = lit.clone().multiplyScalar(0.92);
      const deckBot = new THREE.Color(0.06, 0.08, 0.12).lerp(new THREE.Color(0.42, 0.45, 0.5).multiplyScalar(w.precip === 'snow' ? 1.25 : 1), day);
      this.clouds.setLighting(lit, sh, deckTop, deckBot, golden);
      this.clouds.material.uniforms.sunDir.value.copy(this.night > 0.45 ? this.moonDir : world.sunDir);
    }
    this.stars.material.opacity = smoothstep(0.15, 0.95, this.night) * (w.clouds.deck ? 0.12 : 0.95);
    // surface & snow
    this.uSnow.value = w.snow;
    if (updateSurface) world.setSurface?.(w.surface);
    world.setNight?.(this.night);
    // precipitation particles
    if (this.precip?.kind !== w.precip) { this.precip?.dispose(); this.precip = w.precip ? new Precip(this.scene, w.precip) : null; }
  }

  setWeather(id) { if (WEATHER[id]) { this.weatherId = id; this.apply({ rebuildIbl: true, updateSurface: true }); } }

  update(dt, camera, fm, sound, paused = false) {
    this.time += dt;
    if (!paused && this.timeScale > 0 && dt > 0) {
      this.hour = (this.hour + (dt * this.timeScale) / 3600) % 24;
      this.apply({ rebuildIbl: false, updateSurface: false });
    }
    const w = this.weather, world = this.world;
    this.stars.position.copy(camera.position);
    this.nightDome.position.copy(camera.position);
    this.sunDome.position.copy(camera.position);
    // sun dimmed below an overcast deck, full above it
    const deck = this.clouds?.deckCfg;
    const below = deck ? 1 - smoothstep(deck.top - 50, deck.top + 150, camera.position.y) : 0;
    const dim = lerp(1, w.sun, deck ? below : (w.sun < 1 ? 1 : 0));
    world.sun.intensity = this.sunBase * dim;
    this.sunDome.material.uniforms.uIntensity.value = (this.sunDomeBase || 0) * dim;
    world.baseFogDensity = 0.000028 * lerp(1, w.fog, deck ? below : 1);
    // precipitation follows the camera, only below the cloud base
    if (this.precip) {
      const u = this.precip.uniforms;
      u.uTime.value = this.time;
      u.uCam.value.copy(camera.position);
      const fall = this.precip.kind === 'rain' ? 9 : 1.3;
      const wind = fm.wind;
      u.uFall.value.set(wind.x, -fall, wind.z);
      u.uRel.value.set(wind.x - fm.vel.x, -fall - fm.vel.y, wind.z - fm.vel.z);
      const topY = deck ? deck.base + 50 : 4000;
      const vis = camera.position.y < topY ? 1 : 0;
      const light = 0.12 + 0.88 * this.day;
      u.uOpacity.value = vis * (this.precip.kind === 'rain' ? 0.32 : 0.85) * Math.min(1.2, w.intensity || 1);
      u.uColor.value.setRGB(0.72 * light + 0.05, 0.77 * light + 0.05, 0.85 * light + 0.06);
      sound?.setRain?.(vis * (this.precip.kind === 'rain' ? (w.intensity || 1) : 0.15));
    } else sound?.setRain?.(0);
    // lightning in storm cells near the aircraft
    if (w.lightning && this.clouds) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.nextFlash = 2.5 + Math.random() * 7;
        const near = this.clouds.clusters.filter(c => c.storm && Math.hypot(c.x - camera.position.x, c.z - camera.position.z) < 45000);
        if (near.length) {
          const c = near[(Math.random() * near.length) | 0];
          const p = new THREE.Vector3(c.x + (Math.random() - 0.5) * c.r, c.y0 + (c.y1 - c.y0) * (0.25 + Math.random() * 0.4), c.z + (Math.random() - 0.5) * c.r);
          const dist = p.distanceTo(camera.position);
          this.clouds.flashAt(p, 3 + Math.random() * 2);
          this.flash = Math.max(this.flash || 0, clamp(1 - dist / 30000, 0.15, 1));
          sound?.thunder?.(dist);
        }
      }
    }
    if (this.flash > 0) {
      world.hemi.intensity = 0.16 + 0.24 * this.day + this.flash * 1.4 * (Math.random() < 0.7 ? 1 : 0.3);
      this.flash = Math.max(0, this.flash - dt * 6);
    } else world.hemi.intensity = 0.16 + 0.24 * this.day;
  }

  get label() {
    const rate = this.timeScale === 0 ? ' · Sabit' : this.timeScale === 1 ? '' : ` · ${this.timeScale}x`;
    return `${hourLabel(this.hour)} · ${this.weather.label}${rate}`;
  }
}
