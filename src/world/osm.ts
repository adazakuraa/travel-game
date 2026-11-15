// OpenStreetMap data via the public Overpass API (no key; fair-use: few concurrent requests, cache results).
// Data © OpenStreetMap contributors, ODbL.
export const CELL = 0.01; // degrees (~1.1 km N-S)

/** metres per degree of latitude / longitude on the WGS84 ellipsoid at a given latitude */
export function metersPerDegree(lat: number): { kx: number; ky: number } {
  const r = (lat * Math.PI) / 180;
  return {
    ky: 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r),
    kx: 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r),
  };
}

// cells the game currently wants; queued requests for other cells are dropped (e.g. after a teleport)
let wanted: Set<string> | null = null;
export function setWantedCells(keys: Set<string>) {
  wanted = keys;
}
// failed cells cool down before being retried (exponential backoff, Overpass fair use)
const failures = new Map<string, { n: number; until: number }>();

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: { lat: number; lon: number }[];
  nodes?: number[];
}

export interface OsmCell {
  key: string;
  roads: OsmWay[];
  buildings: OsmWay[];
  runways: OsmWay[];
}

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let endpointIdx = 0;

const cells = new Map<string, Promise<OsmCell | null>>();
let queue: Promise<unknown> = Promise.resolve();

export function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
}

function cellBBox(key: string) {
  const [a, b] = key.split(':').map(Number);
  const s = a * CELL;
  const w = b * CELL;
  return { s, w, n: s + CELL, e: w + CELL };
}

const ROAD_RE =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road';

async function overpass(query: string, attempts = 4, timeoutMs = 25000): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = ENDPOINTS[endpointIdx % ENDPOINTS.length];
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: ctl.signal,
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        // a 200 with a runtime remark means the query timed out / ran out of memory: not a valid empty result
        if (typeof json.remark === 'string' && /error|timed out|timeout|out of memory/i.test(json.remark))
          throw new Error('overpass remark: ' + json.remark);
        return json;
      }
      lastErr = new Error('overpass ' + res.status);
      if (res.status === 429 || res.status >= 500) {
        endpointIdx++;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      endpointIdx++;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Load one ~1 km cell. Requests are serialised (Overpass fair use). */
export function loadCell(key: string, withBuildings: boolean): Promise<OsmCell | null> {
  const ck = key + (withBuildings ? ':b' : '');
  let p = cells.get(ck);
  if (p) return p;
  const f = failures.get(ck);
  if (f && Date.now() < f.until) return Promise.resolve(null);
  const { s, w, n, e } = cellBBox(key);
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:30];(
    way["highway"~"^(${ROAD_RE})$"]["area"!="yes"](${bbox});
    way["aeroway"="runway"](${bbox});
    ${withBuildings ? `way["building"](${bbox});way["building:part"](${bbox});` : ''}
  );out tags geom;`;
  const run = () => {
    if (wanted && !wanted.has(key)) return Promise.reject(new Error('stale'));
    return overpass(q, 2);
  };
  p = (queue = queue.then(run, run)).then(
    (json: any) => {
      const roads: OsmWay[] = [];
      const buildings: OsmWay[] = [];
      const runways: OsmWay[] = [];
      for (const el of json.elements ?? []) {
        if (el.type !== 'way' || !el.geometry) continue;
        const way: OsmWay = { id: el.id, tags: el.tags ?? {}, geometry: el.geometry };
        if (way.tags.highway) roads.push(way);
        else if (way.tags.aeroway === 'runway') runways.push(way);
        else if (way.tags.building || way.tags['building:part']) buildings.push(way);
      }
      failures.delete(ck);
      return { key, roads, buildings, runways } as OsmCell;
    },
    (err) => {
      cells.delete(ck); // allow retry later
      if (String(err).includes('stale')) return null;
      const n = (failures.get(ck)?.n ?? 0) + 1;
      failures.set(ck, { n, until: Date.now() + Math.min(300_000, 15_000 * 2 ** (n - 1)) });
      console.warn('Overpass cell failed', key, err);
      return null;
    },
  );
  cells.set(ck, p);
  return p;
}

/** Find runways within ~radius km (used to spawn the airliner). */
export async function findRunways(lat: number, lon: number, radiusKm = 40): Promise<OsmWay[]> {
  const d = radiusKm / 111;
  const q = `[out:json][timeout:30];way["aeroway"="runway"](${lat - d},${lon - d / Math.cos((lat * Math.PI) / 180)},${lat + d},${lon + d / Math.cos((lat * Math.PI) / 180)});out tags geom;`;
  try {
    // not queued behind road cells: the player is waiting for this one
    const json = await Promise.race([
      overpass(q, 2, 12000),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ]) as any;
    return (json.elements ?? []).filter((e: any) => e.type === 'way' && e.geometry) as OsmWay[];
  } catch {
    return [];
  }
}
