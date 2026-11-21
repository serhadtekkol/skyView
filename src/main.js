import * as THREE from 'three';
import { World } from './world.js';
import { Clouds } from './clouds.js';
import { Aircraft, loadStatic } from './aircraft.js';
import { FlightModel } from './physics.js';
import { Input, bindCommands } from './controls.js';
import { CameraRig, CAMERA_MODES } from './camera.js';
import { HUD } from './hud.js';
import { Sound } from './audio.js';
import { CabinAudio } from './cabin.js';
import { VolumePanel } from './volume.js';
import { StatsPanel } from './stats.js';
import { netStats } from './netstats.js';
import { FMS } from './fms.js';
import { Menu, MENU_HTML } from './menu.js';
import { MiniMap } from './minimap.js';
import { Autopilot } from './autopilot.js';
import { MCP } from './mcp.js';
import { FLEET, fleetById, fleetUrl } from './fleet.js';
import { NavDisplay } from './nd.js';
import { Environment, WEATHER, WEATHER_IDS } from './environment.js';
import { PostFX } from './postfx.js';
let env = null;
import { FirLocator } from './fir.js';
import { installTooltips } from './tooltip.js';
import { Layout } from './layout.js';
const layout = new Layout();
installTooltips();
const firsP = FirLocator.load().catch(e => { console.warn('FIR data', e); return null; });
let firs = null, curFir, firTimer = 0, aheadTimer = 0;

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
const postfx = new PostFX(renderer, scene, camera);
const hud = new HUD(document.getElementById('hud'));
hud.layout = layout;
const sound = new Sound();
const cabin = new CabinAudio(sound);
const volPanel = new VolumePanel(sound);
layout.dom('volume', volPanel.el, volPanel.el.querySelector('.vol-grip'));
const statsPanel = new StatsPanel();
layout.dom('stats', statsPanel.el, statsPanel.el.querySelector('.st-grip'));
const rig = new CameraRig(camera, renderer.domElement);
const input = new Input();

// ---------------------------------------------------------------- menu
const airports = await fetch('/assets/airports.json').then(async r => {
  const txt = await r.text();
  netStats.record('assets', txt.length);
  return JSON.parse(txt);
});
let world = null, clouds = null, minimap = null, fms = null, running = false, paused = false, startMode = 'to';
const menu = new Menu(startEl, airports, (site, mode) => startWorld(site, mode));
let aircraft = null, fm = null, ap = null, mcp = null;
window.sim = { rig, camera, renderer, scene, postfx, get world() { return world; }, get env() { return env; }, get fm() { return fm; }, get ap() { return ap; }, get aircraft() { return aircraft; }, get fms() { return fms; }, get sound() { return sound; }, stats: statsPanel, netStats };
menu.setReady(true);
menu.setStatus('Hazır. Havalimanı ve pist seç, ya da haritaya tıklayıp serbest uç.');

// deep link: ?apt=LTFM&rw=4&end=he&mode=to  |  ?lat=..&lon=..  |  ?world=synthetic
const qs = new URLSearchParams(location.search);
if (qs.get('ac')) menu.setAircraft(qs.get('ac'));
if (qs.get('t') || qs.get('wx')) menu.setEnv(qs.get('t') ? +qs.get('t') : menu.hour, qs.get('wx') || menu.weather);
if (qs.get('auto') === '1') {
  if (qs.get('world') === 'synthetic') startWorld({ kind: 'synthetic' }, qs.get('mode') || 'to');
  else if (qs.get('lat')) startWorld({ kind: 'free', lat: +qs.get('lat'), lon: +qs.get('lon') }, 'free');
  else {
    const a = airports.find(x => x.icao === qs.get('apt'));
    if (a) startWorld({ kind: 'airport', airport: a, rwIndex: Math.min(+qs.get('rw') || 0, a.rw.length - 1), end: qs.get('end') === 'he' ? 'he' : 'le' }, qs.get('mode') || 'to');
  }
}

function siteToQuery(site, mode) {
  const p = new URLSearchParams({ auto: '1', mode, ac: menu.acId, t: menu.hour, wx: menu.weather });
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
    const type = fleetById(menu.acId);
    aircraft = await new Aircraft().load(fleetUrl(type), type, p => menu.setStatus(`${type.name} yükleniyor… ${(p * 100).toFixed(0)}%`));
    scene.add(aircraft.group);
    fm = new FlightModel({ gearPoints: aircraft.geometry.gear, hardPoints: aircraft.geometry.hard, spec: type, enginePos: aircraft.geometry.engines });
    fm.typeName = type.name;
    ap = new Autopilot(fm);
    hud.ap = ap;
    ap.onChange((text, color) => { if (text) hud.message(text, color || 'white', 3); });
    bindCommands(input, fm, hud, sound);
    world = new World(scene, renderer, site);
    env = new Environment(scene, renderer, world, { hour: menu.hour, weather: menu.weather });
    env.postfx = postfx;
    await world.init(t => menu.setStatus(t));
  } catch (e) {
    console.error(e);
    menu.setStatus('Dünya yüklenemedi: ' + e.message + ' (internet bağlantısını kontrol et)');
    return;
  }
  clouds = new Clouds(scene, world.sunDir, scene.fog, env.cloudOptions(world.spawn.elev));
  env.clouds = clouds;
  env.apply();
  env.applyToFlight(fm, world.spawn.elev);
  hud.envLabel = env.label;
  hud.attribution = world.attribution;
  hud.clouds = clouds;
  if (!hud.nd) hud.nd = new NavDisplay();
  if (world.parkingSpots) addParkedTraffic();
  if (world.frame) { minimap = new MiniMap(world); layout.dom('minimap', minimap.box, minimap.box.querySelector('.mm-grip')); }
  if (world.frame) {
    fms = new FMS({ airports, world, fm, ap, minimap, hud, onToggle: v => mcp?.setFmsOpen(v) });
    layout.dom('fms', fms.el, fms.el.querySelector('.fms-grip'));
    minimap.onMapClick = (lat, lon, id) => { if (fms?.addPointFromMap(lat, lon, id)) hud.message(`WPT EKLENDİ${id ? ': ' + id : ''}`, 'cyan', 2); };
  }
  if (world.frame) { firs = await firsP; if (firs) { minimap?.setFirs(firs); hud.attribution += ' · FIR: VATSpy (CC BY-SA 4.0)'; } }
  startMode = mode;
  spawn(mode);
  onResize();
  if (!mcp) { mcp = new MCP(ap, { onFms: toggleFms, fmsEnabled: !!world.frame }); layout.dom('mcp', mcp.el, mcp.el.querySelector('.mcp-grip')); }
  menu.show(false);
  running = true;
}

const D2R = Math.PI / 180;
function spawn(mode) {
  const sp = world.spawn;
  const dx = Math.sin(sp.heading * D2R), dz = -Math.cos(sp.heading * D2R);
  rig.setMode(rig.mode);
  minimap?.reset();
  cabin.reset();
  statsPanel.resetFlight();
  curFir = undefined; firTimer = 1e9; aheadTimer = 1e9;
  ap.runway = sp.free ? null : { x: sp.x, z: sp.z, elev: sp.elev, heading: sp.heading };
  const curFt = (h) => Math.round(h * 3.28084 / 100) * 100;
  if (sp.free || mode === 'free') ap.preset({ spd: 250, hdg: sp.heading, alt: curFt(sp.elev + 1220) });
  else if (mode === 'app') ap.preset({ spd: Math.round(145 * fm.speedScale), hdg: sp.heading, alt: curFt(sp.elev + 2 + 9000 * Math.tan(3 * D2R)), vs: -800 });
  else ap.preset({ spd: 250, hdg: sp.heading, alt: Math.max(5000, curFt(sp.elev) + 5000), vs: 2000 });
  if (sp.free || mode === 'free') {
    fm.resetApproach(sp.x, sp.elev + 1220, sp.z, sp.heading, 250, { flapIndex: 0, gearDown: false, gammaDeg: 0 });
    hud.message(`SERBEST UÇUŞ · ${sp.name} · 4000 ft AGL`, 'white', 5);
  } else if (mode === 'app') {
    const D = 9000, ax = sp.x + dx * 300, az = sp.z + dz * 300;
    fm.resetApproach(ax - dx * D, sp.elev + 2 + D * Math.tan(3 * D2R), az - dz * D, sp.heading, Math.round(145 * fm.speedScale));
    hud.message(`${sp.name} · 9 km FİNAL · FLAPS 30`, 'white', 5);
  } else {
    fm.resetOnGround(sp.x + dx * 45, sp.z + dz * 45, sp.heading);
    hud.message(`${sp.name} · P ile park frenini bırak, R ile gaz ver`, 'white', 6);
  }
}

async function addParkedTraffic() {
  const others = FLEET.filter(t => t.id !== menu.acId && ['a320', 'a321', 'b739', 'b789', 'b77w'].includes(t.id)).slice(0, 3);
  const parked = others.map((t, i) => [t, [-180, -60, 120][i]]);
  for (const [t, z] of parked) {
    const url = fleetUrl(t);
    try {
      const m = await loadStatic(url, t, { shadows: true });
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
input.on('KeyC', () => { rig.setMode(rig.mode + 1); hud.message('KAMERA: ' + CAMERA_MODES[rig.mode]); });
['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].forEach((k, i) => input.on(k, () => { rig.setMode(i); hud.message('KAMERA: ' + CAMERA_MODES[i]); }));
input.on('Digit0', () => { if (hud.nd) { hud.nd.visible = !hud.nd.visible; hud.message(hud.nd.visible ? 'RADAR / ND AÇIK' : 'RADAR / ND KAPALI'); } });
input.on('Digit6', (e) => { if (!env) return; env.setHour(env.hour + (e && e.shiftKey ? -1 : 1)); hud.envLabel = env.label; hud.message(env.label, 'cyan', 3); });
input.on('Digit7', () => { if (env) applyWeather(WEATHER_IDS[(WEATHER_IDS.indexOf(env.weatherId) + 1) % WEATHER_IDS.length]); });
function applyWeather(id) {
  clouds?.dispose();
  env.setWeather(id);
  clouds = new Clouds(scene, world.sunDir, scene.fog, env.cloudOptions(world.spawn.elev));
  env.clouds = clouds; hud.clouds = clouds;
  env.apply(); env.applyToFlight(fm, world.spawn.elev);
  if (hud.nd) hud.nd.cells = null;
  hud.envLabel = env.label;
  hud.message('HAVA: ' + env.label, 'cyan', 3);
}
input.on('Digit8', () => { if (firs && curFir !== undefined) hud.showFirCard(curFir, firEntry(curFir, null), 'BULUNDUĞUN FIR'); });
input.on('Digit9', () => { if (hud.nd) hud.message('RADAR MENZİLİ ' + hud.nd.cycleRange() + ' NM'); });
input.on('KeyV', () => { if (minimap) hud.message(minimap.toggle() ? 'HARİTA AÇIK' : 'HARİTA KAPALI'); });
input.on('KeyO', () => { if (!aircraft) return; aircraft.setReflections(!aircraft.reflections); hud.message(aircraft.reflections ? 'CANLI YANSIMA AÇIK' : 'CANLI YANSIMA KAPALI (performans)'); });
input.on('KeyI', (e) => { if (running) ap.button(e && e.shiftKey ? 'AT' : 'AP'); mcp?.render(); });
input.on('KeyH', () => { hud.showHelp = !hud.showHelp; });
input.on('KeyU', (e) => {
  if (e && e.shiftKey) { layout.resetAll(); hud.message('PANEL YERLEŞİMİ SIFIRLANDI'); return; }
  hud.visible = !hud.visible;
});
function toggleFms() {
  if (!running) return;
  if (!fms) { hud.message('FMS: gerçek dünya modunda kullanılabilir', 'amber'); return; }
  fms.toggle();
}
window.addEventListener('keydown', (e) => {
  if (!running || startEl.style.display !== 'none') return;
  if (e.code === 'F2') {
    e.preventDefault();
    if (!e.repeat) statsPanel.toggle();
    return;
  }
  if (e.code === 'F3') {
    e.preventDefault();
    if (!e.repeat) {
      const on = postfx.toggle();
      hud.message(on ? 'HDR + BLOOM AÇIK' : 'HDR + BLOOM KAPALI (performans)', on ? 'cyan' : 'white', 2.5);
    }
    return;
  }
  if (e.code === 'F4' && env) {
    e.preventDefault();
    if (!e.repeat) {
      const s = env.cycleTimeScale();
      hud.envLabel = env.label;
      hud.message(s === 0 ? 'ZAMAN AKIŞI: SABİT' : s === 1 ? 'ZAMAN AKIŞI: 1x (Gerçek Zaman)' : `ZAMAN AKIŞI: ${s}x`, 'cyan', 2.5);
    }
    return;
  }
  if (e.code === 'Tab' || e.code === 'Backquote' || e.code === 'F8') {
    if (e.code === 'Tab' && e.target?.closest?.('#fms input, #fms select, #fms textarea')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (document.activeElement?.closest?.('#mcp input')) document.activeElement.blur();
    if (!e.repeat) toggleFms();
  }
}, true);
input.on('KeyM', () => { sound.init(); hud.message(sound.toggleMute() ? 'SES KAPALI' : 'SES %' + Math.round(sound.getVolume('master') * 100)); });
input.on('Comma', () => { sound.init(); const st = sound.adjustMaster(-0.1); hud.message(st.muted || st.master === 0 ? 'SES KAPALI' : 'SES %' + Math.round(st.master * 100)); });
input.on('Period', () => { sound.init(); const st = sound.adjustMaster(0.1); hud.message('SES %' + Math.round(st.master * 100)); });
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
  postfx.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  world?.onResize(window.innerHeight * renderer.getPixelRatio(), camera.fov);
  hud.resize();
}
window.addEventListener('resize', onResize);

// ---------------------------------------------------------------- FIR tracking
function firEntry(f, from) {
  const d = new Date();
  return { utc: d.toISOString().slice(11, 19) + 'Z', altFt: fm.pos.y * 3.28084, kt: fm.ias * 1.943844, hdg: fm.heading, from };
}
function updateFir(dt) {
  if (!firs || !world?.frame || !fm) return;
  firTimer += dt; aheadTimer += dt;
  if (firTimer < 1) return;
  firTimer = 0;
  const ll = world.frame.toLatLon(fm.pos.x, fm.pos.z);
  const f = firs.locate(ll.lat, ll.lon);
  if (f !== curFir) {
    const first = curFir === undefined;
    hud.showFirCard(f, firEntry(f, first ? null : curFir), first ? 'BULUNDUĞUN FIR' : 'FIR GİRİŞİ');
    if (!first) {
      hud.message(f ? `ENTERING ${f.id} ${f.name.toLocaleUpperCase('en')} FIR` : 'FIR SINIRI DIŞI', 'cyan', 5);
      if (f) sound.say(`Entering ${f.name} ${f.oceanic ? 'oceanic ' : ''}F I R`);
    }
    minimap?.highlightFir(f);
    curFir = f; aheadTimer = 1e9;
  }
  let ahead = hud.firAhead;
  const gs = Math.hypot(fm.vel.x, fm.vel.z);
  if (aheadTimer >= 2) {
    aheadTimer = 0;
    if (gs > 30) {
      const trk = (Math.atan2(fm.vel.x, -fm.vel.z) * 180 / Math.PI + 360) % 360;
      ahead = firs.ahead(ll.lat, ll.lon, trk, 900);
      if (ahead) ahead.etaMin = ahead.km / (gs * 0.06);
    } else ahead = null;
  }
  hud.setFir(f, ahead);
}

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
    fm.inCloud = Math.max(clouds.densityAt(fm.pos), clouds.turbAt(fm.pos) * 0.6);   // storm cells are much rougher
    fm.step(dt);
    const cab = cabin.update(dt, fm, ap);
    if (cab.shaker) rig.shake = Math.max(rig.shake, 0.25);
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
  const camCloud = Math.max(clouds.densityAt(camera.position), clouds.densityAt(fm.pos) * 0.85);
  world.update(dt, camera, camCloud);
  if (env) {
    env.update(dt, camera, fm, sound, paused || menuOpen);
    hud.envLabel = env.label;
    hud.envDay = env.day;
  }
  hud.cloudDensity = camCloud;
  aircraft.nightK = env ? env.night : 0;
  clouds.update(dt, camera);
  minimap?.update(dt, fm);
  updateFir(dt);
  sound.update(fm, rig.mode, camera.position.distanceTo(fm.pos));
  aircraft.updateReflections(dt, renderer, scene);
  postfx.render();
  hud.lastDt = dt;
  hud.draw(dt, fm, rig);
  statsPanel.update(dt, fm, world, hud.fps, paused || menuOpen);
}
frame();
