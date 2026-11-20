import * as THREE from 'three';
import { groundHeight } from './world.js';

export const CAMERA_MODES = ['Takip', 'Kokpit', 'Yolcu penceresi', 'Kule / geçiş', 'Serbest yörünge'];

const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.mode = 0;
    this.orbitYaw = 0; this.orbitPitch = 0.16; this.dist = 62;
    this.lookYaw = 0; this.lookPitch = -0.12;
    this.freeYaw = 0.8; this.freePitch = 0.25; this.freeDist = 55;
    this.smoothYaw = null;
    this.flyby = new THREE.Vector3(1e9, 0, 0);   // placed on first use
    this.shake = 0;
    this.dragging = false;
    dom.addEventListener('pointerdown', (e) => { this.dragging = true; this.lx = e.clientX; this.ly = e.clientY; dom.setPointerCapture(e.pointerId); });
    dom.addEventListener('pointerup', (e) => { this.dragging = false; dom.releasePointerCapture(e.pointerId); });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = (e.clientX - this.lx) * 0.005, dy = (e.clientY - this.ly) * 0.005;
      this.lx = e.clientX; this.ly = e.clientY;
      if (this.mode === 0) { this.orbitYaw -= dx; this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy, -0.4, 1.4); }
      else if (this.mode === 1 || this.mode === 2) { this.lookYaw -= dx; this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy, -1.2, 1.2); }
      else if (this.mode === 4) { this.freeYaw -= dx; this.freePitch = THREE.MathUtils.clamp(this.freePitch + dy, -0.3, 1.5); }
    });
    dom.addEventListener('dblclick', () => { this.orbitYaw = 0; this.orbitPitch = 0.16; this.lookYaw = 0; this.lookPitch = -0.12; });
    dom.addEventListener('wheel', (e) => {
      const k = Math.exp(e.deltaY * 0.001);
      if (this.mode === 0) this.dist = THREE.MathUtils.clamp(this.dist * k, 22, 400);
      else if (this.mode === 4) this.freeDist = THREE.MathUtils.clamp(this.freeDist * k, 18, 600);
      else if (this.mode === 1 || this.mode === 2) this.camera.fov = THREE.MathUtils.clamp(this.camera.fov * k, 25, 90), this.camera.updateProjectionMatrix();
    }, { passive: true });
  }

  setMode(m) {
    this.mode = (m + CAMERA_MODES.length) % CAMERA_MODES.length;
    this.lookYaw = this.mode === 2 ? 1.25 : 0; this.lookPitch = this.mode === 2 ? -0.18 : -0.12;
    this.camera.fov = this.mode === 1 ? 68 : this.mode === 2 ? 60 : 55;
    this.camera.near = this.mode === 1 || this.mode === 2 ? 0.08 : 0.5;
    this.camera.updateProjectionMatrix();
    this.smoothYaw = null;
  }

  update(dt, fm, geo) {
    const cam = this.camera, pos = fm.pos, q = fm.quat;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const yaw = Math.atan2(-fwd.x, -fwd.z);

    // shake: ground roll, buffet, touchdown thumps
    const gs = Math.hypot(fm.vel.x, fm.vel.z);
    let sh = this.shake;
    if (fm.onGround) sh += Math.min(gs / 80, 1) * 0.035;
    sh += fm.stall * 0.12 + fm.inCloud * 0.03;
    this.shake *= Math.exp(-dt * 4);
    const t = performance.now() * 0.001;
    const jx = Math.sin(t * 37.1) * sh * 0.5, jy = Math.sin(t * 43.7 + 1) * sh * 0.5;

    if (this.mode === 0) {
      if (this.smoothYaw === null) this.smoothYaw = yaw;
      let d = yaw - this.smoothYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.smoothYaw += d * (1 - Math.exp(-dt * 2.5));
      const a = this.smoothYaw + this.orbitYaw, p = this.orbitPitch;
      const off = new THREE.Vector3(Math.sin(a) * Math.cos(p), Math.sin(p), Math.cos(a) * Math.cos(p)).multiplyScalar(this.dist);
      cam.position.copy(pos).add(off);
      const minY = groundHeight(cam.position.x, cam.position.z) + 1.5;
      if (cam.position.y < minY) cam.position.y = minY;
      cam.up.copy(UP);
      cam.lookAt(pos.x, pos.y + 2.5, pos.z);
      cam.rotateX(jy * 0.01); cam.rotateY(jx * 0.01);
    } else if (this.mode === 1 || this.mode === 2) {
      const local = this.mode === 1 ? geo.cockpit.clone() : new THREE.Vector3(-1.85, 0.75, -4.5);
      cam.position.copy(local.applyQuaternion(q).add(pos));
      cam.quaternion.copy(q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.lookPitch + jy * 0.02, this.lookYaw + jx * 0.02, 0, 'YXZ')));
    } else if (this.mode === 3) {
      // tower near the runway; reposition ahead of the aircraft when far away
      if (this.flyby.distanceTo(pos) > 4500) {
        const v = fm.vel.clone(); if (v.lengthSq() < 1) v.copy(fwd);
        v.normalize();
        const side = new THREE.Vector3(-v.z, 0, v.x).normalize();
        this.flyby.copy(pos).addScaledVector(v, 1800).addScaledVector(side, 90);
        this.flyby.y = Math.max(groundHeight(this.flyby.x, this.flyby.z) + 3, pos.y - 25);
      }
      cam.position.copy(this.flyby);
      cam.up.copy(UP);
      cam.lookAt(pos);
      const d = this.flyby.distanceTo(pos);
      cam.fov = THREE.MathUtils.clamp(2 * Math.atan(60 / d) * 180 / Math.PI * 1.4, 4, 55);
      cam.updateProjectionMatrix();
    } else {
      const a = this.freeYaw, p = this.freePitch;
      cam.position.set(pos.x + Math.sin(a) * Math.cos(p) * this.freeDist, pos.y + Math.sin(p) * this.freeDist, pos.z + Math.cos(a) * Math.cos(p) * this.freeDist);
      const minY = groundHeight(cam.position.x, cam.position.z) + 1.2;
      if (cam.position.y < minY) cam.position.y = minY;
      cam.up.copy(UP);
      cam.lookAt(pos);
    }
  }
}
