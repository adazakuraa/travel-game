export interface CountryInfo {
  iso: string;
  name: string;
  nameJa: string;
}

type Ring = number[][];
interface Entry {
  info: CountryInfo;
  polys: Ring[][];
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  bboxes: [number, number, number, number][];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CountriesGeoJSON = any;

let rawPromise: Promise<CountriesGeoJSON | null> | null = null;
let indexPromise: Promise<Entry[]> | null = null;

export function loadCountriesGeoJSON(): Promise<CountriesGeoJSON | null> {
  if (!rawPromise) {
    rawPromise = fetch('./data/countries.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return rawPromise;
}

function ringBBox(ring: Ring): [number, number, number, number] {
  let a = 180, b = 90, c = -180, d = -90;
  for (const [x, y] of ring) {
    if (x < a) a = x;
    if (x > c) c = x;
    if (y < b) b = y;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

function buildIndex(): Promise<Entry[]> {
  if (!indexPromise) {
    indexPromise = loadCountriesGeoJSON().then((gj) => {
      const out: Entry[] = [];
      for (const f of gj?.features ?? []) {
        const g = f.geometry;
        if (!g) continue;
        const polys: Ring[][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        if (!polys.length) continue;
        const bboxes = polys.map((p) => ringBBox(p[0]));
        const bbox: [number, number, number, number] = [
          Math.min(...bboxes.map((b) => b[0])),
          Math.min(...bboxes.map((b) => b[1])),
          Math.max(...bboxes.map((b) => b[2])),
          Math.max(...bboxes.map((b) => b[3])),
        ];
        const p = f.properties ?? {};
        out.push({
          info: { iso: String(p.iso ?? '-99'), name: String(p.name ?? ''), nameJa: String(p.nameJa ?? p.name ?? '') },
          polys,
          bbox,
          bboxes,
        });
      }
      return out;
    });
  }
  return indexPromise;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x: number, y: number, poly: Ring[]): boolean {
  if (!inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false;
  return true;
}

/** Country containing the point (ray casting with bbox prefilter), or null (ocean / data unavailable). */
export async function countryAt(lat: number, lon: number): Promise<CountryInfo | null> {
  const idx = await buildIndex();
  for (const e of idx) {
    const b = e.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    for (let i = 0; i < e.polys.length; i++) {
      const pb = e.bboxes[i];
      if (lon < pb[0] || lon > pb[2] || lat < pb[1] || lat > pb[3]) continue;
      if (inPolygon(lon, lat, e.polys[i])) return e.info;
    }
  }
  return null;
}

export function flagEmoji(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return '🏳️';
  return String.fromCodePoint(...iso.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
