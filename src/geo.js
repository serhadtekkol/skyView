// Geographic helpers: local tangent frame (x = east, z = south, metres) and Web-Mercator tiles.
export const EARTH_R = 6378137;
const D2R = Math.PI / 180;

export class LocalFrame {
  constructor(lat0, lon0) { this.lat0 = lat0; this.lon0 = lon0; this.cos0 = Math.cos(lat0 * D2R); }
  toLocal(lat, lon) { return { x: EARTH_R * this.cos0 * (lon - this.lon0) * D2R, z: -EARTH_R * (lat - this.lat0) * D2R }; }
  toLatLon(x, z) { return { lat: this.lat0 - (z / EARTH_R) / D2R, lon: this.lon0 + (x / (EARTH_R * this.cos0)) / D2R }; }
}

export const lonToTX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTY = (lat, z) => {
  const r = lat * D2R;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
export const txToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tyToLat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return Math.atan(Math.sinh(n)) / D2R;
};

/** Initial great-circle bearing from point 1 to point 2, degrees true. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}
