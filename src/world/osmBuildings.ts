// Extruded OpenStreetMap buildings for cities without an open 3D city model.
// Each ~1 km cell becomes one in-memory glTF (GLB) placed in a local ENU frame,
// shaded with the same procedural facade shader as the LOD2 tilesets.
import {
  Axis,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Model,
  PolygonPipeline,
  ShadowMode,
  Transforms,
  sampleTerrain,
  type Viewer,
} from 'cesium';
import { makeFacadeShader, type FacadeStyle } from './buildings';
import type { OsmWay } from './osm';
import { CELL } from './osm';

function parseLen(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(v)) n *= 0.3048;
  return Number.isFinite(n) ? n : null;
}

interface Mesh {
  pos: number[];
  nrm: number[];
  idx: number[];
}

function addBuilding(mesh: Mesh, ring: [number, number][], base: number, minH: number, maxH: number) {
  // ensure CCW
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) < 4) return;
  if (area < 0) ring.reverse();
  const zb = base + minH - (minH > 0 ? 0 : 3); // sink walls 3 m to hide slopes
  const zt = base + maxH;
  // walls
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const nx = dy / len;
    const ny = -dx / len;
    const v = mesh.pos.length / 3;
    mesh.pos.push(x1, y1, zb, x2, y2, zb, x2, y2, zt, x1, y1, zt);
    for (let k = 0; k < 4; k++) mesh.nrm.push(nx, ny, 0);
    mesh.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  // roof
  const pts = ring.map(([x, y]) => new Cartesian2(x, y));
  let tri: number[] | undefined;
  try {
    tri = PolygonPipeline.triangulate(pts, undefined);
  } catch {
    tri = undefined;
  }
  if (!tri) return;
  const v0 = mesh.pos.length / 3;
  for (const [x, y] of ring) {
    mesh.pos.push(x, y, zt);
    mesh.nrm.push(0, 0, 1);
  }
  for (let i = 0; i < tri.length; i += 3) mesh.idx.push(v0 + tri[i], v0 + tri[i + 1], v0 + tri[i + 2]);
}

function toGlb(mesh: Mesh): Uint8Array {
  const pos = new Float32Array(mesh.pos);
  const nrm = new Float32Array(mesh.nrm);
  const idx = new Uint32Array(mesh.idx);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  const bin = new Uint8Array(pos.byteLength + nrm.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nrm.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nrm.byteLength);
  const json = {
    asset: { version: '2.0', generator: 'wt3d-osm' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nrm.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + nrm.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(enc.length / 4) * 4;
  const binLen = Math.ceil(bin.length / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(enc, 20);
  for (let i = enc.length; i < jsonLen; i++) out[20 + i] = 0x20;
  dv.setUint32(20 + jsonLen, binLen, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(bin, 28 + jsonLen);
  return out;
}

export class OsmBuildingLayer {
  private models = new Map<string, Model>();
  private pending = new Set<string>();
  style: FacadeStyle;
  defaultLevels = 4;
  private shadows = false;
  private night = 0;
  private up = new Cartesian3(0, 0, 1);

  constructor(private viewer: Viewer, style: FacadeStyle) {
    this.style = style;
  }

  setShadows(on: boolean) {
    this.shadows = on;
    for (const m of this.models.values()) m.shadows = on ? ShadowMode.ENABLED : ShadowMode.DISABLED;
  }

  setNight(night: number, up: Cartesian3) {
    this.night = night;
    this.up = up;
    for (const m of this.models.values()) {
      m.customShader?.setUniform('u_night', night);
      m.customShader?.setUniform('u_up', up);
    }
  }

  has(key: string) {
    return this.models.has(key) || this.pending.has(key);
  }

  async addCell(key: string, ways: OsmWay[]) {
    if (this.has(key)) return;
    this.pending.add(key);
    try {
      const [a, b] = key.split(':').map(Number);
      const lat0 = (a + 0.5) * CELL;
      const lon0 = (b + 0.5) * CELL;
      const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
      const ky = 110540;
      // terrain samples on a 9x9 grid for base heights
      const N = 9;
      const carto: Cartographic[] = [];
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++)
          carto.push(Cartographic.fromDegrees(b * CELL + (CELL * i) / (N - 1), a * CELL + (CELL * j) / (N - 1)));
      let heights: number[];
      try {
        const s = await sampleTerrain(this.viewer.terrainProvider, 14, carto);
        heights = s.map((c) => (Number.isFinite(c.height) ? c.height : 0));
      } catch {
        heights = carto.map(() => 0);
      }
      const groundAt = (lat: number, lon: number) => {
        const fi = Math.max(0, Math.min(N - 1.001, ((lon - b * CELL) / CELL) * (N - 1)));
        const fj = Math.max(0, Math.min(N - 1.001, ((lat - a * CELL) / CELL) * (N - 1)));
        const i = Math.floor(fi);
        const j = Math.floor(fj);
        const u = fi - i;
        const v = fj - j;
        const h = (ii: number, jj: number) => heights[jj * N + ii];
        return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
      };
      const mesh: Mesh = { pos: [], nrm: [], idx: [] };
      // avoid drawing building outlines that are subdivided into parts at the same height
      for (const w of ways) {
        const g = w.geometry;
        if (g.length < 4) continue;
        const t = w.tags;
        if (t.building === 'roof' || t['building:part'] === 'roof') continue;
        const levels = parseLen(t['building:levels']);
        let h = parseLen(t.height) ?? (levels !== null ? levels * this.style.floorHeight + 1 : null);
        if (h === null) h = this.defaultLevels * this.style.floorHeight + 1;
        const minLevel = parseLen(t['building:min_level']);
        const minH = parseLen(t.min_height) ?? (minLevel !== null ? minLevel * this.style.floorHeight : 0);
        if (h <= minH + 0.5) continue;
        let clat = 0;
        let clon = 0;
        for (const p of g) {
          clat += p.lat;
          clon += p.lon;
        }
        clat /= g.length;
        clon /= g.length;
        const base = groundAt(clat, clon);
        const ring: [number, number][] = [];
        for (let i = 0; i < g.length - 1; i++) ring.push([(g[i].lon - lon0) * kx, (g[i].lat - lat0) * ky]);
        addBuilding(mesh, ring, base, minH, h);
      }
      if (!mesh.idx.length) return;
      const glb = toGlb(mesh);
      const url = URL.createObjectURL(new Blob([glb as BlobPart], { type: 'model/gltf-binary' }));
      const shader = makeFacadeShader(this.style);
      shader.setUniform('u_night', this.night);
      shader.setUniform('u_up', this.up);
      const model = await Model.fromGltfAsync({
        url,
        modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon0, lat0, 0)),
        upAxis: Axis.Z,
        forwardAxis: Axis.X,
        customShader: shader,
        shadows: this.shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED,
        incrementallyLoadTextures: false,
      });
      model.readyEvent.addEventListener(() => URL.revokeObjectURL(url));
      if (!this.pending.has(key)) {
        model.destroy();
        return;
      }
      this.viewer.scene.primitives.add(model);
      this.models.set(key, model);
    } catch (e) {
      console.warn('osm buildings cell failed', key, e);
    } finally {
      this.pending.delete(key);
    }
  }

  /** remove cells not in keep */
  prune(keep: Set<string>) {
    for (const [k, m] of this.models) {
      if (!keep.has(k)) {
        this.viewer.scene.primitives.remove(m);
        this.models.delete(k);
      }
    }
  }

  clear() {
    this.pending.clear();
    this.prune(new Set());
  }
}
