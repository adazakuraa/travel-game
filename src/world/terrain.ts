// Key-less terrain for CesiumJS.
//  * Japan: 国土地理院 標高タイル (DEM5A 5 m at z15, DEM10B 10 m up to z14), PNG encoding.
//  * Elsewhere: AWS Open Data "Terrain Tiles" (Mapzen/Tilezen, Terrarium PNG encoding, z<=15).
//  * Switzerland: swisstopo quantized-mesh terrain (handled by makeSwissTerrain()).
// The PNG sources are Web-Mercator tiles holding orthometric heights; we resample them
// onto Cesium's geographic heightmap grid and add the EGM96 geoid undulation so that
// the ground lines up with ellipsoid-referenced 3D Tiles (PLATEAU / 3DBAG / swisstopo).
import {
  CesiumTerrainProvider,
  Credit,
  CustomHeightmapTerrainProvider,
  GeographicTilingScheme,
  Math as CMath,
  type TerrainProvider,
} from 'cesium';
import { geoidHeight } from './geoid';

const SIZE = 65; // heightmap samples per tile edge
const TILE_PX = 256;

type Source = {
  id: string;
  maxZoom: number;
  url: (z: number, x: number, y: number) => string;
  decode: (r: number, g: number, b: number, a: number) => number; // NaN = no data
};

const TERRARIUM: Source = {
  id: 'terrarium',
  maxZoom: 15,
  url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  decode: (r, g, b) => r * 256 + g + b / 256 - 32768,
};

// GSI PNG elevation: x = R*2^16 + G*2^8 + B; x < 2^23 → h = x*0.01; x > 2^23 → (x-2^24)*0.01; x == 2^23 → NA
const gsiDecode = (r: number, g: number, b: number, a: number) => {
  if (a === 0) return NaN;
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return NaN;
  return (x < 8388608 ? x : x - 16777216) * 0.01;
};
const GSI_DEM5A: Source = {
  id: 'gsi5a',
  maxZoom: 15,
  url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`,
  decode: gsiDecode,
};
const GSI_DEM10: Source = {
  id: 'gsi10',
  maxZoom: 14,
  url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
  decode: gsiDecode,
};

// Rough Japan land bbox where GSI tiles exist
const JAPAN = { w: 122.9, s: 24.0, e: 146.0, n: 45.6 };

// ---------------- source tile cache ----------------
type Decoded = Float32Array | null; // null = tile missing
const cache = new Map<string, Promise<Decoded>>();
const MAX_CACHE = isMobile() ? 96 : 220;
let inflight = 0;
const MAX_INFLIGHT = 12;

function isMobile(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
function getCtx() {
  if (!ctx) {
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
      ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    } else {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = TILE_PX;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
  }
  return ctx!;
}

async function loadTile(src: Source, z: number, x: number, y: number): Promise<Decoded> {
  const n = 1 << z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const key = `${src.id}/${z}/${x}/${y}`;
  let p = cache.get(key);
  if (p) {
    // refresh LRU position
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = (async () => {
    inflight++;
    try {
      const res = await fetch(src.url(z, x, y), { mode: 'cors' });
      if (!res.ok) return null;
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = getCtx();
      c.clearRect(0, 0, TILE_PX, TILE_PX);
      c.drawImage(bmp, 0, 0, TILE_PX, TILE_PX);
      bmp.close?.();
      const data = c.getImageData(0, 0, TILE_PX, TILE_PX).data;
      const out = new Float32Array(TILE_PX * TILE_PX);
      for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        out[i] = src.decode(data[j], data[j + 1], data[j + 2], data[j + 3]);
      }
      return out;
    } catch {
      return null;
    } finally {
      inflight--;
    }
  })();
  cache.set(key, p);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return p;
}

// lon/lat (deg) → global mercator pixel coords at zoom z
function lonToPx(lon: number, z: number) {
  return ((lon + 180) / 360) * TILE_PX * (1 << z);
}
function latToPx(lat: number, z: number) {
  const s = Math.sin(CMath.toRadians(Math.max(-85.05, Math.min(85.05, lat))));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_PX * (1 << z);
}

async function sampleGrid(
  src: Source,
  z: number,
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<{ heights: Float32Array; missing: number } | null> {
  // which source tiles do we need?
  const x0 = Math.floor(lonToPx(west, z) / TILE_PX);
  const x1 = Math.floor((lonToPx(east, z) - 1e-6) / TILE_PX);
  const y0 = Math.floor(latToPx(north, z) / TILE_PX);
  const y1 = Math.floor((latToPx(south, z) - 1e-6) / TILE_PX);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 9) return null; // zoom mismatch guard
  const tiles = new Map<string, Decoded>();
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      jobs.push(loadTile(src, z, tx, ty).then((d) => void tiles.set(`${tx}/${ty}`, d)));
  await Promise.all(jobs);

  const heights = new Float32Array(SIZE * SIZE);
  let missing = 0;
  const maxPx = TILE_PX * (1 << z);
  const read = (gx: number, gy: number): number => {
    gx = Math.max(0, Math.min(maxPx - 1, gx));
    gy = Math.max(0, Math.min(maxPx - 1, gy));
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    return t[(gy - ty * TILE_PX) * TILE_PX + (gx - tx * TILE_PX)];
  };
  for (let j = 0; j < SIZE; j++) {
    const lat = north - ((north - south) * j) / (SIZE - 1);
    const py = latToPx(lat, z) - 0.5;
    const iy = Math.floor(py);
    const fy = py - iy;
    for (let i = 0; i < SIZE; i++) {
      const lon = west + ((east - west) * i) / (SIZE - 1);
      const px = lonToPx(lon, z) - 0.5;
      const ix = Math.floor(px);
      const fx = px - ix;
      const a = read(ix, iy);
      const b = read(ix + 1, iy);
      const c = read(ix, iy + 1);
      const d = read(ix + 1, iy + 1);
      let h: number;
      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
        h = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      } else {
        const vals = [a, b, c, d].filter(Number.isFinite);
        if (vals.length) h = vals.reduce((s, v) => s + v, 0) / vals.length;
        else {
          h = NaN;
          missing++;
        }
      }
      heights[j * SIZE + i] = h;
    }
  }
  return { heights, missing };
}

function finish(heights: Float32Array, west: number, south: number, east: number, north: number) {
  // add geoid, clamp bathymetry (we render the sea surface, not the sea floor)
  for (let j = 0; j < SIZE; j++) {
    const lat = north - ((north - south) * j) / (SIZE - 1);
    for (let i = 0; i < SIZE; i++) {
      const lon = west + ((east - west) * i) / (SIZE - 1);
      const k = j * SIZE + i;
      let h = heights[k];
      if (!Number.isFinite(h)) h = 0;
      if (h < -8) h = -8;
      heights[k] = h + geoidHeight(lat, lon);
    }
  }
  return heights;
}

export function makeOpenTerrain(): TerrainProvider {
  const tiling = new GeographicTilingScheme();
  const provider = new CustomHeightmapTerrainProvider({
    width: SIZE,
    height: SIZE,
    tilingScheme: tiling,
    credit: new Credit(
      '標高: 国土地理院 / AWS Terrain Tiles (Mapzen: SRTM, GMTED, ETOPO1 ほか) / EGM96',
      false,
    ),
    callback: (x: number, y: number, level: number) => {
      if (inflight > MAX_INFLIGHT) return undefined as any; // Cesium will retry later
      const r = tiling.tileXYToRectangle(x, y, level);
      const west = CMath.toDegrees(r.west);
      const east = CMath.toDegrees(r.east);
      const south = CMath.toDegrees(r.south);
      const north = CMath.toDegrees(r.north);
      // pick mercator zoom so source pixel ~= heightmap sample spacing
      const spacing = (east - west) / (SIZE - 1);
      const latC = (north + south) / 2;
      const z = Math.max(0, Math.round(Math.log2(360 / (TILE_PX * spacing))));
      const cx = (west + east) / 2;
      const inJapan = level >= 7 && cx > JAPAN.w && cx < JAPAN.e && latC > JAPAN.s && latC < JAPAN.n;
      return (async () => {
        if (inJapan) {
          const src = z >= 15 ? GSI_DEM5A : GSI_DEM10;
          const zz = Math.min(z, src.maxZoom);
          let res = await sampleGrid(src, zz, west, south, east, north);
          if (src === GSI_DEM5A && (!res || res.missing > 0)) {
            // DEM5A has gaps (mountains / sea) – fill from DEM10B
            const alt = await sampleGrid(GSI_DEM10, 14, west, south, east, north);
            if (res && alt) {
              for (let k = 0; k < res.heights.length; k++)
                if (!Number.isFinite(res.heights[k])) res.heights[k] = alt.heights[k];
            } else res = alt ?? res;
          }
          if (res && res.missing < SIZE * SIZE) return finish(res.heights, west, south, east, north);
          // GSI no-data (sea) → fall through to Terrarium (which clamps bathymetry)
        }
        const zz = Math.min(z, TERRARIUM.maxZoom);
        const res = await sampleGrid(TERRARIUM, zz, west, south, east, north);
        return finish(res ? res.heights : new Float32Array(SIZE * SIZE).fill(NaN), west, south, east, north);
      })();
    },
  });
  return provider;
}

/** swisstopo quantized-mesh terrain (global coverage, very high detail inside Switzerland). */
export async function makeSwissTerrain(): Promise<TerrainProvider> {
  const p = await CesiumTerrainProvider.fromUrl('https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/', {
    requestVertexNormals: true,
    credit: new Credit('地形: © swisstopo', false),
  });
  return p;
}
