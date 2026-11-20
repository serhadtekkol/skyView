import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadStatic } from './aircraft.js';
import { fleetUrl } from './fleet.js';

// Turntable 3D preview of the selected aircraft in the start menu (own small renderer).
export class AircraftPreview {
  constructor(canvas, label) {
    this.canvas = canvas; this.label = label;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    const s = this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    s.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.9;
    const sun = this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight(0xcfe3ff, 0x30363c, 0.5));
    // turntable floor
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1b2533, roughness: 0.55, metalness: 0.2 }));
    floor.receiveShadow = true; this.floor = floor; s.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 128).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x31d0ff, transparent: true, opacity: 0.55 }));
    ring.position.y = 0.002; floor.add(ring);
    this.camera = new THREE.PerspectiveCamera(32, 2, 0.1, 2000);
    this.holder = new THREE.Group(); s.add(this.holder);
    this.cache = new Map(); this.current = null; this.token = 0;
    this.yaw = -0.7; this.pitch = 0.32; this.zoom = 1; this.auto = true; this.active = true;

    // interaction
    let drag = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', e => { drag = true; lx = e.clientX; ly = e.clientY; this.auto = false; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', e => { drag = false; canvas.releasePointerCapture(e.pointerId); clearTimeout(this.resume); this.resume = setTimeout(() => (this.auto = true), 2500); });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      this.yaw -= (e.clientX - lx) * 0.01; this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - ly) * 0.006, 0.02, 1.2);
      lx = e.clientX; ly = e.clientY;
    });
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(e.deltaY * 0.001), 0.45, 1.8); }, { passive: false });
    canvas.addEventListener('dblclick', () => { this.yaw = -0.7; this.pitch = 0.32; this.zoom = 1; });

    this.clock = new THREE.Clock();
    const loop = () => { requestAnimationFrame(loop); this.render(); };
    loop();
  }

  async show(type) {
    const tok = ++this.token;
    this.label.textContent = `${type.name} yükleniyor…`;
    try {
      let entry = this.cache.get(type.id);
      if (!entry) {
        const model = await loadStatic(fleetUrl(type), type, { shadows: true });
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model, true);
        const g = new THREE.Group(); g.add(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.set(-c.x, -box.min.y, -c.z);
        entry = { group: g, size: box.getSize(new THREE.Vector3()) };
        this.cache.set(type.id, entry);
      }
      if (tok !== this.token) return;          // a newer selection won
      if (this.current) this.holder.remove(this.current.group);
      this.current = entry;
      this.holder.add(entry.group);
      const R = Math.max(entry.size.x, entry.size.z) * 0.62;
      this.floor.scale.setScalar(R);
      const s = this.sun.shadow.camera;
      s.left = -R; s.right = R; s.top = R; s.bottom = -R; s.near = 1; s.far = R * 6; s.updateProjectionMatrix();
      this.sun.position.set(R * 0.9, R * 2.2, R * 1.2);
      this.label.textContent = `${type.name} · ${type.airline} · uzunluk ${entry.size.z.toFixed(1)} m · açıklık ${entry.size.x.toFixed(1)} m`;
    } catch (e) {
      console.warn(e);
      if (tok === this.token) this.label.textContent = `${type.name}: model yüklenemedi`;
    }
  }

  setActive(v) { this.active = v; }

  render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (!this.active || !this.canvas.isConnected || this.canvas.offsetParent === null) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== Math.floor(w * this.renderer.getPixelRatio())) { this.renderer.setSize(w, h, false); }
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.auto) this.yaw += dt * 0.35;
    const size = this.current?.size || new THREE.Vector3(40, 12, 40);
    const R = Math.max(size.x, size.z);
    // fit the aircraft: distance from the vertical FOV and the aspect ratio
    const fitH = (size.y * 1.6) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const fitW = (R * 0.95) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    const d = Math.max(fitH, fitW) * this.zoom * 1.1;
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * d, Math.sin(this.pitch) * d + size.y * 0.3, Math.cos(this.yaw) * Math.cos(this.pitch) * d);
    this.camera.lookAt(0, size.y * 0.32, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
