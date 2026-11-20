// Aircraft types: model file + representative performance (typical operating weight, wing area,
// span, per-engine static thrust).  Animation/geometry details are found by calibrate.js.
export const FLEET = [
  { id: 'a320', name: 'Airbus A320-200', airline: 'Türk Hava Yolları', file: 'a320_thy.glb', mass: 64000, S: 122.6, b: 35.8, thrust: 120000, show: ['CFM'], cat: 'Dar gövde' },
  { id: 'a321', name: 'Airbus A321-200', airline: 'Türk Hava Yolları', file: 'a321_thy.glb', mass: 78000, S: 122.6, b: 35.8, thrust: 147000, show: ['CFM'], cat: 'Dar gövde' },
  { id: 'b739', name: 'Boeing 737-900', airline: 'Türk Hava Yolları', file: 'b739_thy.glb', mass: 66000, S: 124.6, b: 34.3, thrust: 121400, show: ['900_normal'], cat: 'Dar gövde' },
  { id: 'e190', name: 'Embraer E190', airline: 'KLM Cityhopper', file: 'e190_klm.glb', mass: 44000, S: 92.5, b: 28.7, thrust: 89000, cat: 'Bölgesel' },
  { id: 'crj9', name: 'Bombardier CRJ-900', airline: 'Lufthansa CityLine', file: 'crj9_dlh.glb', mass: 33000, S: 70.6, b: 24.9, thrust: 64500, cat: 'Bölgesel' },
  { id: 'b789', name: 'Boeing 787-9', airline: 'Türk Hava Yolları', file: 'b789_thy.glb', mass: 200000, S: 377, b: 60.1, thrust: 320000, show: ['GEnx'], cat: 'Geniş gövde' },
  { id: 'a359', name: 'Airbus A350-900', airline: 'Türk Hava Yolları', file: 'a359_thy.glb', mass: 220000, S: 442, b: 64.75, thrust: 375000, cat: 'Geniş gövde' },
  { id: 'a333', name: 'Airbus A330-300', airline: 'Türk Hava Yolları', file: 'a333_thy.glb', mass: 190000, S: 361.6, b: 60.3, thrust: 316000, show: ['engine_rr700', 'classic'], cat: 'Geniş gövde' },
  { id: 'b77w', name: 'Boeing 777-300ER', airline: 'Türk Hava Yolları', file: 'b77w_thy.glb', mass: 270000, S: 436.8, b: 64.8, thrust: 513000, show: ['engine_ge90_115b'], cat: 'Geniş gövde' },
  { id: 'b748', name: 'Boeing 747-8', airline: 'Lufthansa', file: 'b748_dlh.glb', mass: 350000, S: 554, b: 68.4, thrust: 296000, show: ['8i', 'GE'], cat: 'Jumbo' },
];

export const fleetById = (id) => FLEET.find(t => t.id === id) || FLEET.find(t => t.id === 'b739');
export const fleetUrl = (t) => '/assets/fleet/' + t.file;

/** Approach-speed scale relative to the 737-900 (wing loading). */
export const speedScale = (t) => Math.sqrt((t.mass / t.S) / (66000 / 124.6));
