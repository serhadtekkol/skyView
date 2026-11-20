import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';
import { FLEET, fleetById, speedScale } from './fleet.js';
import { AircraftPreview } from './preview.js';
import { tips } from './tooltip.js';
import { WEATHER, WEATHER_IDS, hourLabel } from './environment.js';

// Start screen: satellite map with airports, search, runway / mode selection, free-flight point.

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s ?? '').toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');

function load(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }

export class Menu {
  constructor(root, airports, onStart) {
    this.root = root; this.airports = airports; this.onStart = onStart;
    this.sel = null; this.rwIndex = 0; this.end = 'le'; this.free = null; this.ready = false;
    airports.forEach(a => { a._s = norm(`${a.icao} ${a.iata} ${a.name} ${a.city}`); });
    this.el = (id) => root.querySelector('#' + id);

    const m = this.map = L.map(this.el('map'), { worldCopyJump: true, zoomControl: true, attributionControl: true, preferCanvas: true })
      .setView([41.26, 28.74], 6);
    L.tileLayer(ESRI, { maxZoom: 18, attribution: 'Esri, Maxar, Earthstar Geographics' }).addTo(m);
    L.tileLayer(LABELS, { maxZoom: 18, opacity: 0.9 }).addTo(m);
    const renderer = L.canvas({ padding: 0.3 });
    for (const a of airports) {
      const mk = L.circleMarker([a.lat, a.lon], { renderer, radius: a.big ? 5 : 3.5, color: '#0b1220', weight: 1, fillColor: a.big ? '#31d0ff' : '#9fe6ff', fillOpacity: 0.95 });
      mk.bindTooltip(`${a.icao}${a.iata ? ' / ' + a.iata : ''} · ${esc(a.name)}`, { direction: 'top' });
      mk.on('click', (e) => { L.DomEvent.stopPropagation(e); this.select(a); });
      mk.addTo(m);
    }
    this.rwLayer = L.layerGroup().addTo(m);
    this.freeMarker = null;
    m.on('click', (e) => this.pickFree(e.latlng));

    // search
    const input = this.el('search'), list = this.el('results');
    const run = () => {
      const q = norm(input.value.trim());
      if (!q) { list.innerHTML = ''; return; }
      const hits = this.airports.filter(a => a._s.includes(q))
        .sort((a, b) => (norm(b.icao) === q || norm(b.iata) === q) - (norm(a.icao) === q || norm(a.iata) === q) || b.big - a.big)
        .slice(0, 8);
      list.innerHTML = hits.map((a, i) => `<li data-i="${this.airports.indexOf(a)}"><b>${a.icao}</b>${a.iata ? ' ' + a.iata : ''} · ${esc(a.name)} <span>${esc(a.city)}, ${a.cc}</span></li>`).join('');
      this.hits = hits;
    };
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && this.hits?.[0]) { this.select(this.hits[0]); list.innerHTML = ''; } e.stopPropagation(); });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    list.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) { this.select(this.airports[+li.dataset.i]); list.innerHTML = ''; input.value = ''; } });

    this.el('btnTO').onclick = () => this.go('to');
    this.el('btnAPP').onclick = () => this.go('app');
    this.el('btnFree').onclick = () => this.free && this.start({ kind: 'free', lat: this.free.lat, lon: this.free.lng }, 'free');
    this.el('btnSynth').onclick = () => this.start({ kind: 'synthetic' }, 'to');

    // aircraft picker
    const sel = this.el('acSel');
    const cats = [...new Set(FLEET.map(t => t.cat))];
    sel.innerHTML = cats.map(c => `<optgroup label="${esc(c)}">${FLEET.filter(t => t.cat === c)
      .map(t => `<option value="${t.id}">${esc(t.name)} · ${esc(t.airline)}</option>`).join('')}</optgroup>`).join('');
    sel.addEventListener('change', () => this.setAircraft(sel.value));
    sel.addEventListener('keydown', e => e.stopPropagation());
    this.preview = new AircraftPreview(this.el('acView'), this.el('acCap'));
    tips(root, {
      '#btnTO': 'Pistten kalkış|Seçili pistin başında, park freni çekili başlar. [P] ile freni bırak, [R] ile gaz ver.',
      '#btnAPP': 'İniş yaklaşması|Seçili piste 9 km finalden, 3° süzülüş yolunda, flaps 30 ve takımlar açık başlar.',
      '#btnFree': 'Buradan uç|Haritada tıkladığın noktada 4000 ft yükseklikte, 250 kt hızla havada başlar.',
      '#btnSynth': 'Hayali dünya|İnternet gerektirmeyen prosedürel arazi ve hayali bir havalimanı.',
      '#acSel': 'Uçak tipi|Her tipin ağırlığı, kanadı, itkisi ve kalkış/yaklaşma hızları farklıdır.',
      '#search': 'Havalimanı ara|ICAO (LTFM), IATA (IST), şehir ya da ad yaz; [Enter] ilk sonucu seçer.',
      '#map': 'Harita|Mavi noktalar havalimanları. Bir noktaya tıklayınca seçilir; boş bir yere tıklarsan serbest uçuş noktası olur.',
    });
    this.setAircraft(load('skyview.ac', 'b739'));

    // time of day + weather
    const hr = this.el('hourSel'), wx = this.el('wxSel');
    wx.innerHTML = WEATHER_IDS.map(id => `<option value="${id}">${esc(WEATHER[id].label)}</option>`).join('');
    const env = load('skyview.env', { hour: 14, weather: 'scattered' });
    this.setEnv(env.hour, env.weather);
    hr.addEventListener('input', () => this.setEnv(+hr.value, this.weather));
    wx.addEventListener('change', () => this.setEnv(this.hour, wx.value));
    [hr, wx].forEach(el => el.addEventListener('keydown', e => e.stopPropagation()));
    tips(root, {
      '#hourSel': 'Gün saati|Yerel saat: güneşin yüksekliği ve yönü buna göre. Gece şehir, pist ve uçak ışıkları yanar. Uçuşta [6] / [Shift]+[6] ile ±1 saat.',
      '#wxSel': 'Hava durumu|Bulutlar, yağış, rüzgâr, türbülans, sıcaklık ve pist yüzeyi (ıslak/karlı pistte fren daha zayıf). Uçuşta [7] ile değiştir.',
    });

    const last = load('skyview.last', { icao: 'LTFM', rw: 4, end: 'he' });
    const a = airports.find(x => x.icao === last.icao) || airports.find(x => x.icao === 'LTFM') || airports[0];
    this.select(a, last.icao === a.icao ? last.rw : 0, last.icao === a.icao ? last.end : 'le', false);
  }

  setEnv(hour, weather) {
    this.hour = Math.max(0, Math.min(23.99, hour)); this.weather = WEATHER[weather] ? weather : 'scattered';
    this.el('hourSel').value = this.hour; this.el('wxSel').value = this.weather;
    this.el('hourLbl').textContent = hourLabel(this.hour);
    save('skyview.env', { hour: this.hour, weather: this.weather });
  }

  setAircraft(id) {
    const t = fleetById(id);
    this.acId = t.id;
    this.el('acSel').value = t.id;
    const nEng = t.id === 'b748' ? 4 : 2;
    this.el('acInfo').textContent = `${(t.mass / 1000).toFixed(0)} t · açıklık ${t.b} m · ${nEng} × ${(t.thrust / 1000).toFixed(0)} kN · Vapp ≈ ${Math.round(145 * speedScale(t))} kt`;
    save('skyview.ac', t.id);
    this.preview?.show(t);
  }

  setReady(ok) { this.ready = ok; this.root.querySelectorAll('.go').forEach(b => { b.disabled = !ok || (b.id === 'btnFree' && !this.free); }); }
  setStatus(t) { this.el('status').textContent = t; }
  show(v) { this.preview?.setActive(v); this.root.style.display = v ? 'flex' : 'none'; if (v) setTimeout(() => this.map.invalidateSize(), 50); }

  select(a, rwIndex = null, end = null, fly = true) {
    this.sel = a;
    if (rwIndex === null) {   // default: longest runway, end facing into the usual wind is unknown -> first end
      rwIndex = a.rw.reduce((bi, r, i) => (r.len > a.rw[bi].len ? i : bi), 0);
      end = 'le';
    }
    this.rwIndex = Math.min(rwIndex, a.rw.length - 1); this.end = end || 'le';
    const ft = a.elev != null ? `${a.elev} ft` : '';
    this.el('apt').innerHTML = `<div class="apt-name">${esc(a.name)}</div><div class="apt-sub">${a.icao}${a.iata ? ' · ' + a.iata : ''} · ${esc(a.city)}, ${a.cc} · ${ft}</div>`;
    this.renderRunways();
    if (fly) this.map.flyTo([a.lat, a.lon], 13, { duration: 1.2 });
    else this.map.setView([a.lat, a.lon], 12);
  }

  renderRunways() {
    const a = this.sel, box = this.el('runways');
    box.innerHTML = a.rw.flatMap((r, i) => ['le', 'he'].map(e => {
      const id = r[e].id, on = i === this.rwIndex && e === this.end;
      return `<button class="rw${on ? ' on' : ''}" data-i="${i}" data-e="${e}" data-tip="RWY ${esc(id)}|${r.len} m uzunluk, ${r.wid} m genişlik. Bu uçtan ${e === 'le' ? r.he.id : r.le.id} yönüne doğru kalkış veya bu uca iniş.">RWY ${esc(id)}<small>${r.len} m × ${r.wid} m</small></button>`;
    })).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => { this.rwIndex = +b.dataset.i; this.end = b.dataset.e; this.renderRunways(); });
    this.rwLayer.clearLayers();
    a.rw.forEach((r, i) => {
      const sel = i === this.rwIndex;
      L.polyline([[r.le.lat, r.le.lon], [r.he.lat, r.he.lon]], { color: sel ? '#ffd23f' : '#ffffff', weight: sel ? 6 : 3, opacity: 0.9 }).addTo(this.rwLayer);
      if (sel) {
        const s = this.end === 'le' ? r.le : r.he;
        L.circleMarker([s.lat, s.lon], { radius: 7, color: '#000', weight: 2, fillColor: '#3cf07a', fillOpacity: 1 })
          .bindTooltip(`Başlangıç: RWY ${esc(s.id)}`, { permanent: true, direction: 'right' }).addTo(this.rwLayer);
      }
    });
  }

  pickFree(ll) {
    this.free = ll;
    if (this.freeMarker) this.freeMarker.remove();
    this.freeMarker = L.circleMarker(ll, { radius: 7, color: '#000', weight: 2, fillColor: '#ff4fd8', fillOpacity: 1 })
      .bindTooltip('Serbest uçuş noktası', { permanent: true, direction: 'right' }).addTo(this.map);
    this.el('freeInfo').textContent = `${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)} · 4000 ft üzerinde, 250 kt`;
    this.setReady(this.ready);
  }

  go(mode) {
    const a = this.sel;
    save('skyview.last', { icao: a.icao, rw: this.rwIndex, end: this.end });
    this.start({ kind: 'airport', airport: a, rwIndex: this.rwIndex, end: this.end }, mode);
  }

  start(site, mode) { if (this.ready) this.onStart(site, mode); }
}

export const MENU_HTML = `
<div class="card wide">
  <div class="head">
    <div><h1>SkyView</h1><div class="sub">10 uçak tipi · gerçek dünya uydu arazisi · otopilot</div></div>
    <button id="btnSynth" class="alt go small" disabled>Hayali dünya (çevrimdışı)</button>
  </div>
  <div class="grid">
    <div id="map"></div>
    <div class="side">
      <div class="searchbox"><input id="search" placeholder="Havalimanı ara: LTFM, IST, Antalya, Heathrow…" autocomplete="off" /><ul id="results"></ul></div>
      <div class="lbl">Saat ve hava</div>
      <div class="envrow"><input type="range" id="hourSel" min="0" max="23.5" step="0.5"><span id="hourLbl"></span></div>
      <select id="wxSel"></select>
      <div class="lbl">Uçak</div>
      <div><select id="acSel"></select><div id="acInfo" class="acinfo"></div></div>
      <div class="acview"><canvas id="acView"></canvas><div id="acCap"></div><span class="achint">sürükle · tekerle yakınlaş</span></div>
      <div id="apt"></div>
      <div class="lbl">Pist ve yön</div>
      <div id="runways"></div>
      <div class="row">
        <button id="btnTO" class="go" disabled>Pistten kalkış</button>
        <button id="btnAPP" class="alt go" disabled>İniş yaklaşması</button>
      </div>
      <div class="lbl">Serbest uçuş</div>
      <div class="free"><span id="freeInfo">Haritada herhangi bir yere tıkla</span><button id="btnFree" class="alt go small" disabled>Buradan uç</button></div>
      <details><summary>Kontroller</summary>
        <table>
          <tr><td>W/S · ↑/↓</td><td>Burun aşağı / yukarı</td></tr><tr><td>A/D · ←/→</td><td>Yatış</td></tr>
          <tr><td>Q/E</td><td>Rudder / yer dümeni</td></tr><tr><td>R/F</td><td>Gaz</td></tr>
          <tr><td>X/Z</td><td>Flap aç / topla</td></tr><tr><td>G</td><td>İniş takımı</td></tr>
          <tr><td>Space</td><td>Fren · P park freni</td></tr><tr><td>L · T</td><td>Spoiler · ters itki</td></tr>
          <tr><td>C · 1-5</td><td>Kamera</td></tr><tr><td>V</td><td>Mini harita</td></tr><tr><td>K · J · N</td><td>Piste dön · yaklaşma · harita</td></tr>
        </table>
      </details>
      <div id="status">Yükleniyor…</div>
    </div>
  </div>
</div>`;
