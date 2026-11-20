import * as THREE from 'three';
import { World } from './world.js';
import { Clouds } from './clouds.js';
import { Aircraft, loadStatic } from './aircraft.js';
import { FlightModel } from './physics.js';
import { Input, bindCommands } from './controls.js';
import { CameraRig, CAMERA_MODES } from './camera.js';
import { HUD } from './hud.js';
import { Sound } from './audio.js';
import { Menu, MENU_HTML } from './menu.js';
import { MiniMap } from './minimap.js';
import { Autopilot } from './autopilot.js';
import { MCP } from './mcp.js';

const startEl = document.getElementById('start');
startEl.innerHTML = MENU_HTML;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 200000);
const hud = new HUD(document.getElementById('hud'));
const sound = new Sound();
const rig = new CameraRig(camera, renderer.domElement);
const input = new Input();

// ---------------------------------------------------------------- menu
const airports = await fetch('/assets/airports.json').then(r => r.json());
let world = null, clouds = null, minimap = null, running = false, paused = false, startMode = 'to';
const menu = new Menu(startEl, airports, (site, mode) => startWorld(site, mode));
menu.setStatus('Boeing 737-900 yükleniyor…');

const aircraft = await new Aircraft().load('/assets/b739_thy.glb', p => menu.setStatus(`Boeing 737-900 yükleniyor… ${(p * 100).toFixed(0)}%`));
scene.add(aircraft.group);
const fm = new FlightModel({ gearPoints: aircraft.geometry.gear, hardPoints: aircraft.geometry.hard });
const ap = new Autopilot(fm);
hud.ap = ap;
ap.onChange((text, color) => { if (text) hud.message(text, color || 'white', 3); });
let mcp = null;
window.sim = { ap, fm, aircraft, rig, camera, renderer, scene, get world() { return world; } };
menu.setReady(true);
menu.setStatus('Hazır. Havalimanı ve pist seç, ya da haritaya tıklayıp serbest uç.');

// deep link: ?apt=LTFM&rw=4&end=he&mode=to  |  ?lat=..&lon=..  |  ?world=synthetic
const qs = new URLSearchParams(location.search);
if (qs.get('auto') === '1') {
  if (qs.get('world') === 'synthetic') startWorld({ kind: 'synthetic' }, qs.get('mode') || 'to');
  else if (qs.get('lat')) startWorld({ kind: 'free', lat: +qs.get('lat'), lon: +qs.get('lon') }, 'free');
  else {
    const a = airports.find(x => x.icao === qs.get('apt'));
    if (a) startWorld({ kind: 'airport', airport: a, rwIndex: Math.min(+qs.get('rw') || 0, a.rw.length - 1), end: qs.get('end') === 'he' ? 'he' : 'le' }, qs.get('mode') || 'to');
  }
}

function siteToQuery(site, mode) {
  const p = new URLSearchParams({ auto: '1', mode });
  if (site.kind === 'synthetic') p.set('world', 'synthetic');
  else if (site.kind === 'free') { p.set('lat', site.lat.toFixed(5)); p.set('lon', site.lon.toFixed(5)); }
  else { p.set('apt', site.airport.icao); p.set('rw', site.rwIndex); p.set('end', site.end); }
  return '?' + p.toString();
}

async function startWorld(site, mode) {
  sound.init();
  if (world) { location.search = siteToQuery(site, mode); return; }   // a new place -> clean rebuild
  history.replaceState(null, '', siteToQuery(site, mode).replace('auto=1&', ''));
  menu.setReady(false);
  try {
    world = new World(scene, renderer, site);
    await world.init(t => menu.setStatus(t));
  } catch (e) {
    console.error(e);
    menu.setStatus('Dünya yüklenemedi: ' + e.message + ' (internet bağlantısını kontrol et)');
    return;
  }
  clouds = new Clouds(scene, world.sunDir, scene.fog, { base: world.cloudBase });
  hud.attribution = world.attribution;
  if (world.parkingSpots) addParkedTraffic();
  if (world.frame) minimap = new MiniMap(world);
  startMode = mode;
  spawn(mode);
  onResize();
  if (!mcp) mcp = new MCP(ap);
  menu.show(false);
  running = true;
}

const D2R = Math.PI / 180;
function spawn(mode) {
  const sp = world.spawn;
  const dx = Math.sin(sp.heading * D2R), dz = -Math.cos(sp.heading * D2R);
  rig.setMode(rig.mode);
  minimap?.reset();
  ap.runway = sp.free ? null : { x: sp.x, z: sp.z, elev: sp.elev, heading: sp.heading };
  const curFt = (h) => Math.round(h * 3.28084 / 100) * 100;
  if (sp.free || mode === 'free') ap.preset({ spd: 250, hdg: sp.heading, alt: curFt(sp.elev + 1220) });
  else if (mode === 'app') ap.preset({ spd: 145, hdg: sp.heading, alt: curFt(sp.elev + 2 + 9000 * Math.tan(3 * D2R)), vs: -800 });
  else ap.preset({ spd: 250, hdg: sp.heading, alt: Math.max(5000, curFt(sp.elev) + 5000), vs: 2000 });
  if (sp.free || mode === 'free') {
    fm.resetApproach(sp.x, sp.elev + 1220, sp.z, sp.heading, 250, { flapIndex: 0, gearDown: false, gammaDeg: 0 });
    hud.message(`SERBEST UÇUŞ · ${sp.name} · 4000 ft AGL`, 'white', 5);
  } else if (mode === 'app') {
    const D = 9000, ax = sp.x + dx * 300, az = sp.z + dz * 300;
    fm.resetApproach(ax - dx * D, sp.elev + 2 + D * Math.tan(3 * D2R), az - dz * D, sp.heading, 145);
    hud.message(`${sp.name} · 9 km FİNAL · FLAPS 30`, 'white', 5);
  } else {
    fm.resetOnGround(sp.x + dx * 45, sp.z + dz * 45, sp.heading);
    hud.message(`${sp.name} · P ile park frenini bırak, R ile gaz ver`, 'white', 6);
  }
}

async function addParkedTraffic() {
  const parked = [['/assets/a320_thy.glb', -180], ['/assets/a321_thy.glb', -60], ['/assets/b77w_thy.glb', 120]];
  for (const [url, z] of parked) {
    try {
      const m = await loadStatic(url, { shadows: true });
      m.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(m, true);
      const g = new THREE.Group(); g.add(m);
      m.position.y = -b.min.y;
      g.rotation.y = -Math.PI / 2;
      g.position.set(448 + b.min.z, world.spawn.elev + 0.05, z);
      scene.add(g);
    } catch (e) { console.warn('parked aircraft failed', url, e); }
  }
}

// ---------------------------------------------------------------- input & UI
bindCommands(input, fm, hud);
input.on('KeyC', () => { rig.setMode(rig.mode + 1); hud.message('KAMERA: ' + CAMERA_MODES[rig.mode]); });
['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].forEach((k, i) => input.on(k, () => { rig.setMode(i); hud.message('KAMERA: ' + CAMERA_MODES[i]); }));
input.on('KeyV', () => { if (minimap) hud.message(minimap.toggle() ? 'HARİTA AÇIK' : 'HARİTA KAPALI'); });
input.on('KeyO', () => { aircraft.setReflections(!aircraft.reflections); hud.message(aircraft.reflections ? 'CANLI YANSIMA AÇIK' : 'CANLI YANSIMA KAPALI (performans)'); });
input.on('KeyI', (e) => { if (running) ap.button(e && e.shiftKey ? 'AT' : 'AP'); mcp?.render(); });
input.on('KeyH', () => { hud.showHelp = !hud.showHelp; });
input.on('KeyU', () => { hud.visible = !hud.visible; });
input.on('KeyM', () => { hud.message(sound.toggleMute() ? 'SES KAPALI' : 'SES AÇIK'); });
input.on('Escape', () => { if (!running) return; paused = !paused; hud.message(paused ? 'DURAKLATILDI' : 'DEVAM', 'white', 1.5); });
input.on('KeyK', () => { if (running) spawn(world.spawn.free ? 'free' : 'to'); });
input.on('KeyJ', () => { if (running && !world.spawn.free) spawn('app'); });
input.on('KeyN', () => { if (!running) return; paused = true; menu.setReady(true); menu.show(true); menu.setStatus('Yeni bir yer seç (sayfa yeniden yüklenir) · Esc: uçuşa dön'); });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && running && startEl.style.display !== 'none') { menu.show(false); paused = false; e.stopImmediatePropagation(); }
}, true);
window.addEventListener('pointerdown', () => sound.init(), { once: true });

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  world?.onResize(window.innerHeight * renderer.getPixelRatio(), camera.fov);
  hud.resize();
}
window.addEventListener('resize', onResize);

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!running) return;
  const menuOpen = startEl.style.display !== 'none';
  if (!paused && !menuOpen) {
    input.update(dt, fm);
    ap.update(dt, input.override || {});
    fm.inCloud = clouds.densityAt(fm.pos);
    fm.step(dt);
    for (const e of fm.consumeEvents()) {
      if (e === 'touchdown') {
        const fpm = fm.lastTouchdownFpm;
        hud.message(`TOUCHDOWN ${fpm.toFixed(0)} fpm${fpm > -120 ? ' · butter!' : ''}`, fpm > -240 ? 'green' : fpm > -600 ? 'amber' : 'red', 6);
        sound.thump(Math.min(1.5, -fpm / 300));
        rig.shake += Math.min(1.5, -fpm / 250);
      } else if (e === 'crash') { sound.thump(2); rig.shake += 3; }
      else if (e === 'tailstrike') hud.message('TAIL STRIKE', 'amber', 4);
    }
  }
  aircraft.group.position.copy(fm.pos);
  aircraft.group.quaternion.copy(fm.quat);
  aircraft.update(dt, fm, { cockpitView: rig.mode === 1 });
  rig.update(dt, fm, aircraft.geometry);
  world.onResize(window.innerHeight * renderer.getPixelRatio(), camera.fov);
  world.followShadow(fm.pos);
  world.update(dt, camera, clouds.densityAt(camera.position));
  clouds.update(dt, camera);
  minimap?.update(dt, fm);
  sound.update(fm, rig.mode, camera.position.distanceTo(fm.pos));
  aircraft.updateReflections(dt, renderer, scene);
  renderer.render(scene, camera);
  hud.lastDt = dt;
  hud.draw(dt, fm, rig);
}
frame();
