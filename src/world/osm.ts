// OpenStreetMap data via the public Overpass API (no key; fair-use: few concurrent requests, cache results).
// Data © OpenStreetMap contributors, ODbL.
export const CELL = 0.01; // degrees (~1.1 km N-S)

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

async function overpass(query: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = ENDPOINTS[endpointIdx % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.ok) return await res.json();
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
  const { s, w, n, e } = cellBBox(key);
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:30];(
    way["highway"~"^(${ROAD_RE})$"]["area"!="yes"](${bbox});
    way["aeroway"="runway"](${bbox});
    ${withBuildings ? `way["building"](${bbox});way["building:part"](${bbox});` : ''}
  );out tags geom;`;
  p = (queue = queue.then(
    () => overpass(q),
    () => overpass(q),
  )).then(
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
      return { key, roads, buildings, runways } as OsmCell;
    },
    (err) => {
      console.warn('Overpass cell failed', key, err);
      cells.delete(ck); // allow retry later
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
    const json = await (queue = queue.then(
      () => overpass(q),
      () => overpass(q),
    ));
    return (json.elements ?? []).filter((e: any) => e.type === 'way' && e.geometry) as OsmWay[];
  } catch {
    return [];
  }
}
