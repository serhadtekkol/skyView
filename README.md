# ✈ SkyView

Tarayıcıda çalışan, **Three.js** tabanlı 3D ticari uçuş simülatörü. 10 farklı yolcu uçağı, gerçek dünya uydu arazisi, ileri seviye **FMS/MCDU uçuş planlama (LNAV/VNAV)**, gece/hava durumu motoru, hava radarı (ND), FIR takibi ve prosedürel kabin/kokpit ses sistemi içerir.

---

## Öne Çıkan Özellikler

### Filo & 6-DOF Uçuş Fiziği
- **10 Uçak Tipi:** A320, A321, 737-900, E190, CRJ-900, 787-9, A350-900, A330-300, 777-300ER, 747-8. Her tip kendi kütlesi, kanat açıklığı, motor itkisi ve hız profiliyle uçar.
- **Otomatik Rig Kalibrasyonu (`src/calibrate.js`):** İniş takımı, flap/slat, aileron, elevator, rudder, spoiler, ters itki, kanat esnemesi ve süspansiyon model geometrisinden otomatik kalibre edilir.
- **Gerçekçi Dinamikler:** Kaldırma, sürükleme, stall, yer etkisi, motor tepki gecikmesi, burun tekeri dümeni, ıslak/karlı pist fren tutuşu, ISA sıcaklık yoğunluk farkı, yan rüzgâr ve türbülans.

### FMS / MCDU Uçuş Planlama & Otopilot
- **Uçuş İçi FMS Penceresi (`Tab` / `` ` `` / `F8` veya MCP `FMS`):**
  - **RTE:** Kalkış/PPOS ve varış havalimanı + pist seçimi (2500+ havalimanı içinde ICAO/IATA/şehir araması).
  - **LEGS:** Mini Harita'ya tıklayarak, ICAO veya `enlem,boylam` yazarak ara nokta (waypoint) ekleme, sıralama/silme ve irtifa kısıtları (`9000`, `A9000`, `B12000`).
  - **PERF:** Seyir irtifası (`CRZ ALT`), tırmanma/alçalma IAS ve seyir Mach profili, otomatik `FAF` (10 NM, 3°) ve `T/D` (alçalma başlangıcı) hesabı.
  - **REHBER:** Canlı 4 adımlı kontrol çubuğu, tek tıkla **`Rotayı Takip Et`** (`A/P + LNAV + VNAV`) ve yerleşik kullanım kılavuzu.
- **Boeing Tarzı MCP & Otopilot:** `LNAV` (yanal hız sönümlemeli fly-by rota takibi), `VNAV` (`CLB → CRZ → T/D DES → APP`), `HDG SEL`, `LVL CHG`, `ALT HOLD`, `V/S`, `APP` (ILS LOC/G/S + otomatik iniş), flap `VFE` hız koruması ve manuel **Speed Intervention**.

### Gerçek Dünya, Gece & Hava Durumu
- **Flight Deck Dispatch Ana Ekranı:** Tam ekran uydu haritası üzerinde yüzen cam efektli hangar (3D uçak önizleme), atmosfer/saat seçimi ve kalkış brifingi.
- **Uydu Arazisi & Dinamik Kapsama:** Esri World Imagery uydu görüntüleri, AWS Terrain Tiles yükseklik verisi ve 800 km'ye kadar rota boyunca dinamik arazi/varış pisti yüklemesi.
- **Atmosfer & Gece Motoru:** Açık, parçalı bulutlu, yağmurlu, fırtınalı (şimşek + ses hızıyla gecikmeli gök gürültüsü) ve karlı hava. Uzun uçuşlarda uçağı takip eden dinamik bulut alanı, alacakaranlık/gece gökyüzü kubbesi, ay ışığı, yıldızlar ve uydu görüntüsünden yol/ev tespitiyle aydınlatılan şehirler (pist çevresi temiz tutulur).

### Kokpit Arayüzü, Radar & Prosedürel Ses
- **Glass Cockpit HUD:** Sürüklenebilir PFD, EICAS, hava radarlı ve rotalı **ND** (Navigation Display), hareketli **Mini Harita** ve **FIR** sınır/giriş takibi.
- **Kanallı Ses Kontrolü (`M`, `,` / `.`, sol üst 🔊 paneli):** Ana Ses, Motor/Çevre, Kokpit Uyarıları ve Sesli Bildirim için ayrı sürgüler.
- **Durumsal Kabin & Kokpit Sesleri (WebAudio):** Buluta giriş/türbülans kemer ikazı (*dın-dın*), 10.000 ft geçiş zili, kalkış/iniş kabin hazırlık anonsu, irtifa yakalama **C-chord**, A/P wailer sireni, stall **stick shaker**, overspeed **clacker**, GPWS (`PULL UP`, `SINK RATE`, `TOO LOW — GEAR`, `BANK ANGLE`), takım/flap mekanik sesleri ve irtifa callout'ları.

---

## Kurulum ve Çalıştırma

### Docker ile (Önerilen)
```bash
docker compose up -d --build
```
Uygulama **http://localhost:5173** adresinde ayağa kalkar (yerleşik healthcheck ile).

### Node.js ile Yerel Çalıştırma
Gereksinim: Node.js 20+
```bash
npm install
npm start          # http://localhost:5173
```
> Gerçek dünya uydu arazisi ve havalimanı modları için internet bağlantısı gerekir. **Hayali Dünya (Çevrimdışı)** modu internetsiz çalışır.

### Testleri Çalıştırma
```bash
node --test tests/
```

---

## FMS Uçuş Planı Hızlı Kullanım

1. Gerçek dünya modunda uçuşu başlatın ve **`Tab`** (veya `` ` `` / `F8` / MCP **`FMS`**) ile FMS penceresini açın.
2. **RTE** sekmesinde varış havalimanı ve pistini seçin (ör. `LTFJ`, `LTAC`, `LTAI`).
3. *(İsteğe bağlı)* **LEGS** sekmesinde Mini Harita'ya tıklayarak waypoint ekleyin. İrtifa kısıtı boş bırakılabilir; doldurmak isterseniz:
   - `9000` → Tam 9.000 ft'te geç
   - `A9000` → En az 9.000 ft (üstünde geç)
   - `B12000` → En fazla 12.000 ft (altında geç)
4. Yeşil **`EXEC`** butonuna basın (rota haritada ve ND'de magenta çizgi olarak belirir).
5. Pistten kalktıktan sonra FMS'teki mavi **`Rotayı Takip Et`** butonuna (veya MCP'den `A/P + LNAV + VNAV`) basın. Hızı elle sınırlamak için MCP'deki `IAS kt` kutusundan istediğiniz değeri girebilirsiniz.

---

## Kontroller

| Tuş | İşlev |
|---|---|
| `W / S` · `↑ / ↓` | Burun aşağı / yukarı (`S`: çek) |
| `A / D` · `← / →` | Yatış |
| `Q / E` | Rudder / yerde burun tekeri dümeni |
| `R / F` · `PgUp / PgDn` | Gaz artır / azalt |
| `X / Z` | Flap aç / topla |
| `G` | İniş takımı |
| `Space / B` · `P` | Fren · park freni |
| `L` · `T` | Spoiler · ters itki (yerde) |
| `[ / ]` · `Y` | Stab trim · oto-trim |
| `Tab` · `` ` `` · `F8` | FMS / Uçuş Planı penceresi |
| `I` · `Shift + I` | Otopilot (`A/P`) · otomatik gaz (`A/T`) |
| `M` · `, / .` | Sessiz · ana sesi %10 kıs / aç |
| `C` · `1–5` | Kamera modları (fare sürükle: bakış · teker: zoom) |
| `0` · `9` | Radar / ND aç-kapa · menzil (10–160 NM) |
| `6` · `Shift + 6` · `7` · `8` | Saat ±1 · hava değiştir · FIR kartı |
| `V` · `N` | Mini harita · başlangıç haritası |
| `K` · `J` | Piste dön · 9 km yaklaşmaya başla |
| `U` · `Shift + U` | HUD gizle · panel yerleşimini sıfırla |
| `O` · `H` · `Esc` | Canlı yansıma · yardım · duraklat |

---

## Proje Yapısı

```text
├── index.html             # Flight Deck Dispatch giriş ekranı ve importmap
├── server.js              # Bağımlılıksız statik HTTP sunucusu
├── Dockerfile             # node:22-alpine konteyner tanımı
├── docker-compose.yml     # Tek komutla Docker ayağa kaldırma
├── assets/                # 3D uçak modelleri (.glb), airports.json, firs.json
├── src/
│   ├── main.js            # Ana döngü, kısayollar ve modül bağlantıları
│   ├── physics.js         # 6-DOF uçuş dinamiği
│   ├── flightplan.js      # Saf rota, jeodezi, LNAV/VNAV profil motoru
│   ├── fms.js             # FMS/MCDU uçuş planı arayüzü
│   ├── autopilot.js       # LNAV, VNAV, HDG, FLCH, APP/ILS autoland
│   ├── mcp.js             # Boeing tarzı MCP paneli
│   ├── audio.js           # Prosedürel WebAudio motor + kabin/kokpit sesleri
│   ├── cabin.js           # Histerezis & öncelik tabanlı ses tetikleyicileri
│   ├── warnings.js        # Ortak HUD & sesli uyarı kuralları
│   ├── volume.js          # Kanallı ses kontrol paneli
│   ├── environment.js     # Gökyüzü, gece kubbesi, ay, yıldızlar, yağış, şimşek
│   ├── clouds.js          # Dinamik sarılan 3D bulutlar ve fırtına hücreleri
│   ├── realterrain.js     # Esri/AWS arazi akışı ve yol/ev gece aydınlatması
│   ├── world.js           # Sahne, ışıklar, pist oluşturma ve sentetik dünya
│   ├── hud.js / nd.js     # PFD, EICAS ve hava radarlı Navigation Display
│   ├── minimap.js / fir.js# Hareketli harita ve FIR sınır takibi
│   └── menu.js / preview.js # Dispatch menüsü ve 3D hangar önizlemesi
└── tests/                 # Node.js yerleşik birim testleri (node:test)
```

---

## Havalimanı & FIR Verisini Yenileme

```bash
node tools/build-airports.mjs <indirme-klasörü>
node tools/build-firs.mjs <indirme-klasörü>
```

## Atıflar

- **Uydu görüntüsü:** Esri, Maxar, Earthstar Geographics
- **Yükseklik verisi:** Mapzen / AWS Terrain Tiles
- **Havalimanı verisi:** [OurAirports](https://ourairports.com/data/) (kamu malı)
- **FIR sınırları:** [VATSpy data project](https://github.com/vatsimnetwork/vatspy-data-project), CC BY-SA 4.0 (`assets/firs.json` bu veriden türetilmiştir; yalnızca simülasyon amaçlıdır)
- **Gece ışıkları:** NASA Earth Observatory / GIBS, VIIRS Black Marble
- **3D motor & Harita:** [Three.js](https://threejs.org) · [Leaflet](https://leafletjs.com)
