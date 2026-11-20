# SkyView

Tarayıcıda çalışan uçuş simülatörü. Three.js ile yazıldı. İçinde Boeing 737-900 (Türk Hava Yolları), gerçek dünya uydu arazisi, hacimli bulutlar ve otopilot var.

## Özellikler

- **6 serbestlik dereceli uçuş fiziği:** Kaldırma, sürükleme, stall, yer etkisi, motor tepki gecikmesi, iniş takımı süspansiyonu, fren, burun tekeri dümeni, yan rüzgâr ve türbülans.
- **Modelin kendi animasyonları:** İniş takımı, flap ve slat, aileron, elevator, rudder, spoiler, ters itki, kanat esnemesi, teker dönüşü ve süspansiyon.
- **Gerçek dünya:** Esri World Imagery uydu fotoğrafları, AWS Terrain Tiles yükseklik verisi ve OurAirports'tan 2500'den fazla havalimanı. Pistler gerçek konum ve yönlerinde, işaretleri, ışıkları, PAPI'si ve yaklaşma ışıklarıyla.
- **Harita menüsü:** Havalimanı ve pist seçimi, ya da haritada tıklanan herhangi bir noktadan serbest uçuş. Uçuş sırasında köşede mini harita var.
- **Otopilot ve otomatik gaz (MCP):** SPD, HDG SEL, ALT HOLD, V/S, LVL CHG modları, APP ile ILS yaklaşması ve otomatik iniş.
- **Görsel:** Fiziksel gökyüzü, ışıklandırılmış bulut kümeleri, gölgeler, canlı çevre yansıması (cube camera) ve vernikli boya malzemeleri.
- **Arayüz:** Glass cockpit HUD (PFD ve EICAS), sesli bildirimler, prosedürel motor sesi, 5 kamera modu.

## Çalıştırma

```bash
npm install
npm start          # http://localhost:5173
```

Gerçek dünya modu için internet bağlantısı gerekir. "Hayali dünya" çevrimdışı da çalışır.

## Kontroller

| Tuş | İşlev |
|---|---|
| W/S · ↑/↓ | Burun aşağı / yukarı |
| A/D · ←/→ | Yatış |
| Q/E | Rudder / yer dümeni |
| R/F · PgUp/PgDn | Gaz |
| X/Z | Flap aç / topla |
| G | İniş takımı |
| Space / B · P | Fren · park freni |
| L · T | Spoiler · ters itki |
| [ / ] · Y | Trim · oto-trim |
| I · Shift+I | Otopilot · otomatik gaz |
| C · 1-5 | Kamera |
| V · N | Mini harita · havalimanı haritası |
| K · J | Piste dön · yaklaşmaya başla |
| O · M · H | Yansıma · ses · yardım |

## Havalimanı verisini yenileme

```bash
node tools/build-airports.mjs <indirme-klasörü>
```

## Atıflar

- Uydu görüntüsü: Esri, Maxar, Earthstar Geographics
- Yükseklik verisi: Mapzen / AWS Terrain Tiles
- Havalimanı verisi: [OurAirports](https://ourairports.com/data/) (kamu malı)
- 3D motor: [three.js](https://threejs.org) · Harita: [Leaflet](https://leafletjs.com)
