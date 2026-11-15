// Road network built from OSM ways, in a local metric frame around an origin.
// Used for "road assist": keeping the car on real roads.
import { metersPerDegree, type OsmCell, type OsmWay } from '../world/osm';

export interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  half: number; // half width (m)
  wayId: number;
  oneway: boolean;
  bridge: { sx: number; sy: number; ex: number; ey: number; slat: number; slon: number; elat: number; elon: number } | null;
}

export interface Nearest {
  seg: Seg;
  px: number;
  py: number;
  dist: number;
  /** segment direction (radians, math angle from +x/east CCW) */
  dir: number;
  t: number;
}

const BUCKET = 30; // m

function halfWidth(tags: Record<string, string>): number {
  const lanes = parseFloat(tags.lanes ?? '');
  if (Number.isFinite(lanes) && lanes > 0) return Math.min(14, (lanes * 3.3) / 2 + 0.8);
  switch (tags.highway) {
    case 'motorway':
    case 'trunk':
      return 8;
    case 'primary':
      return 7;
    case 'secondary':
      return 6;
    case 'tertiary':
      return 5;
    case 'motorway_link':
    case 'trunk_link':
    case 'primary_link':
    case 'secondary_link':
    case 'tertiary_link':
      return 4;
    case 'residential':
    case 'unclassified':
    case 'living_street':
    case 'road':
      return 3.8;
    default:
      return 3; // service
  }
}

export class RoadNetwork {
  lat0 = 0;
  lon0 = 0;
  private kx = 1;
  private ky = 110540;
  private ways = new Set<number>();
  private grid = new Map<string, Seg[]>();
  private loadedCells = new Set<string>();
  segCount = 0;

  setOrigin(lat: number, lon: number) {
    this.lat0 = lat;
    this.lon0 = lon;
    const m = metersPerDegree(lat);
    this.kx = m.kx;
    this.ky = m.ky;
    this.ways.clear();
    this.grid.clear();
    this.loadedCells.clear();
    this.segCount = 0;
  }

  toLocal(lat: number, lon: number): [number, number] {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }

  toLatLon(x: number, y: number): [number, number] {
    return [this.lat0 + y / this.ky, this.lon0 + x / this.kx];
  }

  hasCell(key: string) {
    return this.loadedCells.has(key);
  }

  addCell(cell: OsmCell) {
    if (this.loadedCells.has(cell.key)) return;
    this.loadedCells.add(cell.key);
    for (const w of cell.roads) this.addWay(w);
  }

  private addWay(w: OsmWay) {
    // Overpass returns the full geometry of every way touching a cell → the same way arrives once per cell
    if (this.ways.has(w.id)) return;
    this.ways.add(w.id);
    const t = w.tags;
    if (t.tunnel === 'yes' || t.tunnel === 'building_passage') return;
    if (t.access === 'no' || t.access === 'private') return;
    const layer = parseInt(t.layer ?? '0', 10) || 0;
    const isBridge = t.bridge && t.bridge !== 'no';
    const fast = /^(motorway|trunk)/.test(t.highway ?? '');
    // elevated urban expressways cannot be represented on the terrain → skip them
    if ((fast && (isBridge || layer > 0)) || layer >= 2) return;
    const g = w.geometry;
    if (g.length < 2) return;
    const half = halfWidth(t);
    const oneway = t.oneway === 'yes' || t.junction === 'roundabout';
    let bridge: Seg['bridge'] = null;
    if (isBridge) {
      const [sx, sy] = this.toLocal(g[0].lat, g[0].lon);
      const [ex, ey] = this.toLocal(g[g.length - 1].lat, g[g.length - 1].lon);
      bridge = { sx, sy, ex, ey, slat: g[0].lat, slon: g[0].lon, elat: g[g.length - 1].lat, elon: g[g.length - 1].lon };
    }
    let [px, py] = this.toLocal(g[0].lat, g[0].lon);
    for (let i = 1; i < g.length; i++) {
      const [x, y] = this.toLocal(g[i].lat, g[i].lon);
      // split long straight segments so each grid entry stays small (desert/highway straights)
      const len = Math.hypot(x - px, y - py);
      const parts = Math.max(1, Math.ceil(len / 60));
      for (let k = 0; k < parts; k++) {
        const t0 = k / parts;
        const t1 = (k + 1) / parts;
        this.insert({
          ax: px + (x - px) * t0,
          ay: py + (y - py) * t0,
          bx: px + (x - px) * t1,
          by: py + (y - py) * t1,
          half,
          wayId: w.id,
          oneway,
          bridge,
        });
      }
      px = x;
      py = y;
    }
  }

  private insert(s: Seg) {
    const minX = Math.floor((Math.min(s.ax, s.bx) - s.half) / BUCKET);
    const maxX = Math.floor((Math.max(s.ax, s.bx) + s.half) / BUCKET);
    const minY = Math.floor((Math.min(s.ay, s.by) - s.half) / BUCKET);
    const maxY = Math.floor((Math.max(s.ay, s.by) + s.half) / BUCKET);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 400) return; // absurdly long segment
    for (let i = minX; i <= maxX; i++)
      for (let j = minY; j <= maxY; j++) {
        const k = i + ',' + j;
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(s);
      }
    this.segCount++;
  }

  /**
   * Nearest road segment to (x, y). When `heading` (math angle) is given, segments roughly
   * aligned with the travel direction are preferred – this makes intersections behave:
   * you stay on your road unless you steer into the crossing one.
   */
  nearest(x: number, y: number, heading?: number, searchRadius = 40): Nearest | null {
    const r = Math.ceil(searchRadius / BUCKET);
    const bx = Math.floor(x / BUCKET);
    const by = Math.floor(y / BUCKET);
    let best: Nearest | null = null;
    let bestScore = Infinity;
    const seen = new Set<Seg>();
    for (let i = bx - r; i <= bx + r; i++)
      for (let j = by - r; j <= by + r; j++) {
        const arr = this.grid.get(i + ',' + j);
        if (!arr) continue;
        for (const s of arr) {
          if (seen.has(s)) continue;
          seen.add(s);
          const dx = s.bx - s.ax;
          const dy = s.by - s.ay;
          const len2 = dx * dx + dy * dy || 1e-9;
          let t = ((x - s.ax) * dx + (y - s.ay) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = s.ax + dx * t;
          const py = s.ay + dy * t;
          const dist = Math.hypot(x - px, y - py);
          if (dist > searchRadius) continue;
          const dir = Math.atan2(dy, dx);
          // distance beyond the carriageway counts fully, inside it only a little
          let score = Math.max(0, dist - s.half) + dist * 0.15;
          if (heading !== undefined) {
            const a = Math.abs(Math.sin(heading - dir)); // 0 = aligned (either way)
            score += a * 4;
          }
          if (score < bestScore) {
            bestScore = score;
            best = { seg: s, px, py, dist, dir, t };
          }
        }
      }
    return best;
  }

  /** for minimap / debug */
  segmentsNear(x: number, y: number, radius: number): Seg[] {
    const r = Math.ceil(radius / BUCKET);
    const bx = Math.floor(x / BUCKET);
    const by = Math.floor(y / BUCKET);
    const out = new Set<Seg>();
    for (let i = bx - r; i <= bx + r; i++)
      for (let j = by - r; j <= by + r; j++) this.grid.get(i + ',' + j)?.forEach((s) => out.add(s));
    return [...out];
  }
}
