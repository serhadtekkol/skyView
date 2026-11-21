import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const STORAGE_KEY = 'skyview.hdr';

// Soft-compresses extreme GGX specular fireflies (> 3.0) before UnrealBloomPass so glossy fuselage
// highlights stay crisp and shiny instead of exploding into a white halo, while sun & lights bloom smoothly.
const FireflyClampShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCap: { value: 2.6 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uCap;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = max(tex.rgb, vec3(0.0));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (l > 1.0) {
        float nl = 1.0 + (uCap - 1.0) * (1.0 - exp(-(l - 1.0) / max(uCap - 1.0, 0.1)));
        c *= nl / l;
      }
      gl_FragColor = vec4(c, tex.a);
    }`,
};

// Subtle filmic vibrance, shadow/highlight balance, and golden-hour warmth in linear HDR space.
const GradingShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.05 },
    uWarmth: { value: 0.0 },
    uVignette: { value: 0.16 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSaturation, uContrast, uWarmth, uVignette;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = max(tex.rgb, vec3(0.0));
      // gentle S-curve contrast around mid-gray in linear space (preserves HDR peaks > 1.0)
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 sat = mix(vec3(luma), col, uSaturation);
      col = max(sat, vec3(0.0));
      // warm highlights / cool shadows during golden hour
      float hi = smoothstep(0.18, 1.4, luma);
      float lo = 1.0 - smoothstep(0.0, 0.35, luma);
      col *= mix(vec3(1.0), vec3(1.06, 1.00, 0.91), uWarmth * hi);
      col *= mix(vec3(1.0), vec3(0.95, 0.98, 1.05), uWarmth * lo * 0.6);
      // mild contrast lift
      col = pow(max(col, vec3(1e-5)), vec3(uContrast));
      // subtle optical vignette
      vec2 p = vUv - 0.5;
      float vig = 1.0 - dot(p, p) * uVignette * 2.2;
      col *= clamp(vig, 0.72, 1.0);
      gl_FragColor = vec4(col, tex.a);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === '0') this.enabled = false;
    } catch { /* ignore */ }

    const size = renderer.getSize(new THREE.Vector2());
    const dpr = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(size.x * dpr));
    const h = Math.max(1, Math.floor(size.y * dpr));

    // HalfFloat HDR render target with WebGL2 MSAA so values > 1.0 bloom cleanly without aliasing
    const isWebGL2 = renderer.capabilities.isWebGL2;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: isWebGL2 ? 4 : 0,
    });

    this.composer = new EffectComposer(renderer, this.rt);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.clampPass = new ShaderPass(FireflyClampShader);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.24, 0.48, 1.35);
    this.gradePass = new ShaderPass(GradingShader);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.clampPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.outputPass);
  }

  /** Tune bloom & color grading for time of day and weather. */
  setEnvironment({ day = 1, golden = 0, night = 0, precip = false } = {}) {
    const clear = precip ? 0.45 : 1.0;
    // Firefly clamp keeps fuselage specular crisp while allowing sun disc, cloud rims & night lights to bloom
    this.clampPass.uniforms.uCap.value = 2.4 + golden * 0.4 + night * 0.8;
    this.bloomPass.strength = (0.18 + golden * 0.12 + night * 0.26) * clear;
    this.bloomPass.radius = 0.46 + golden * 0.18;
    this.bloomPass.threshold = precip ? 1.65 : (1.52 - golden * 0.12 - night * 0.65);

    const u = this.gradePass.uniforms;
    u.uSaturation.value = precip ? 1.02 : (1.14 + golden * 0.12 - night * 0.04);
    u.uContrast.value = precip ? 1.02 : (1.06 + golden * 0.04);
    u.uWarmth.value = golden * (precip ? 0.20 : 0.72);
    u.uVignette.value = 0.14 + golden * 0.05 + night * 0.04;
  }

  setEnabled(v) {
    this.enabled = !!v;
    try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch { /* ignore */ }
    return this.enabled;
  }

  toggle() { return this.setEnabled(!this.enabled); }

  setSize(w, h) {
    const dpr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
  }

  render() {
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.bloomPass.dispose();
    this.rt.dispose();
    this.composer.dispose();
  }
}
