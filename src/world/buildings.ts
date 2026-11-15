// Building layers per city: PLATEAU (textured), swisstopo / 3DBAG (untextured LOD2 → procedural facade shader),
// OpenStreetMap extrusions (see osmBuildings.ts) for cities without open 3D city models.
import {
  Cartesian3,
  Cesium3DTileset,
  CustomShader,
  CustomShaderMode,
  LightingModel,
  ShadowMode,
  UniformType,
  type Viewer,
} from 'cesium';
import type { CityDef } from '../data/cities';
import plateau from '../data/plateau.generated.json';

export interface FacadeStyle {
  wall: [number, number, number];
  wallVariance: number;
  roof: [number, number, number];
  floorHeight: number;
  windowSpacing: number;
  /** if false, keep the original texture and only add night lights */
  procedural: boolean;
}

export const FACADES: Record<string, FacadeStyle> = {
  swisstopo: { wall: [0.86, 0.83, 0.76], wallVariance: 0.08, roof: [0.45, 0.24, 0.18], floorHeight: 3.1, windowSpacing: 2.6, procedural: true },
  '3dbag': { wall: [0.48, 0.27, 0.2], wallVariance: 0.12, roof: [0.22, 0.22, 0.24], floorHeight: 3.0, windowSpacing: 2.2, procedural: true },
  paris: { wall: [0.88, 0.82, 0.7], wallVariance: 0.05, roof: [0.38, 0.42, 0.46], floorHeight: 3.2, windowSpacing: 2.4, procedural: true },
  newyork: { wall: [0.62, 0.58, 0.54], wallVariance: 0.18, roof: [0.35, 0.35, 0.36], floorHeight: 3.6, windowSpacing: 2.0, procedural: true },
  osm: { wall: [0.8, 0.77, 0.72], wallVariance: 0.1, roof: [0.4, 0.4, 0.42], floorHeight: 3.2, windowSpacing: 2.5, procedural: true },
  plateau: { wall: [1, 1, 1], wallVariance: 0, roof: [1, 1, 1], floorHeight: 3.4, windowSpacing: 2.4, procedural: false },
};

/**
 * Facade shader. Works on any tileset / model: it derives a stable local "height" and
 * "along-wall" coordinate from the model matrix and the local up vector (uniform), so window
 * rows stay put while the camera moves. Untextured buildings get walls, windows and roofs;
 * at night windows light up with a random warm glow (textured PLATEAU models keep their
 * photo texture and only receive the night glow on window-like dark pixels).
 */
export function makeFacadeShader(style: FacadeStyle): CustomShader {
  return new CustomShader({
    mode: CustomShaderMode.MODIFY_MATERIAL,
    lightingModel: LightingModel.PBR,
    uniforms: {
      u_up: { type: UniformType.VEC3, value: new Cartesian3(0, 0, 1) },
      u_night: { type: UniformType.FLOAT, value: 0 },
      u_wall: { type: UniformType.VEC3, value: new Cartesian3(...style.wall) },
      u_roof: { type: UniformType.VEC3, value: new Cartesian3(...style.roof) },
      u_var: { type: UniformType.FLOAT, value: style.wallVariance },
      u_floor: { type: UniformType.FLOAT, value: style.floorHeight },
      u_win: { type: UniformType.FLOAT, value: style.windowSpacing },
      u_proc: { type: UniformType.FLOAT, value: style.procedural ? 1 : 0 },
    },
    fragmentShaderText: /* glsl */ `
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 pMC = fsInput.attributes.positionMC;
        mat3 rot = mat3(czm_model);
        vec3 local = rot * pMC;                 // precise, world-axis aligned offset from model origin
        vec3 nW = normalize(cross(dFdx(local), dFdy(local)));
        float upness = abs(dot(nW, u_up));
        // stable coordinates: model translation contributes a constant (per tile) offset
        vec3 T = czm_model[3].xyz;
        float h = dot(local, u_up) + mod(dot(T, u_up), 1000.0);
        vec3 tang = normalize(cross(u_up, nW) + vec3(1e-5));
        float s = dot(local, tang) + mod(dot(T, tang), 1000.0);
        bool isWall = upness < 0.35;
        // per-building-ish random tint (cell of 20 m)
        vec2 cell = floor((local.xy + mod(T.xy, 1000.0)) / 18.0);
        float rnd = h21(cell);

        vec2 g = vec2(s / u_win, h / u_floor);
        vec2 gi = floor(g);
        vec2 gf = fract(g);
        float winMask = isWall ? step(0.2, gf.x) * step(gf.x, 0.8) * step(0.25, gf.y) * step(gf.y, 0.85) : 0.0;
        float edgeAA = clamp(1.5 - length(fwidth(g)) * 3.0, 0.0, 1.0); // fade windows out when too small on screen
        winMask *= edgeAA;

        if (u_proc > 0.5) {
          vec3 wall = u_wall * (1.0 - u_var + 2.0 * u_var * rnd);
          vec3 base = isWall ? wall : u_roof * (0.85 + 0.3 * rnd);
          // slight vertical grime / ground darkening
          base *= isWall ? (0.92 + 0.08 * gf.y) : 1.0;
          vec3 glass = mix(vec3(0.09, 0.12, 0.16), vec3(0.32, 0.38, 0.46), clamp(nW.z * 0.5 + 0.5, 0.0, 1.0));
          material.diffuse = mix(base, glass, winMask);
          material.roughness = mix(0.85, 0.12, winMask);
          material.specular = mix(vec3(0.04), vec3(0.5), winMask);
        } else {
          // keep texture, darker pixels on walls are likely windows
          float lum = dot(material.diffuse, vec3(0.299, 0.587, 0.114));
          winMask = isWall ? smoothstep(0.32, 0.12, lum) * edgeAA : 0.0;
        }
        // night: lit windows
        float lit = step(0.45, h21(gi + rnd * 17.0)) * winMask;
        vec3 lampColor = mix(vec3(1.0, 0.78, 0.45), vec3(0.85, 0.92, 1.0), step(0.75, h21(gi.yx + 3.1)));
        material.emissive += lampColor * lit * u_night * 1.6;
      }
    `,
  });
}

type Managed = { key: string; tileset: Cesium3DTileset; shader: CustomShader };

export class BuildingManager {
  private active: Managed[] = [];
  private loadingKey: string | null = null;
  private sse = 16;
  private shadows = false;

  constructor(private viewer: Viewer) {}

  setQuality(sse: number, shadows: boolean) {
    this.sse = sse;
    this.shadows = shadows;
    for (const m of this.active) {
      m.tileset.maximumScreenSpaceError = this.sse;
      m.tileset.shadows = shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED;
    }
  }

  setNight(night: number, up: Cartesian3) {
    for (const m of this.active) {
      m.shader.setUniform('u_night', night);
      m.shader.setUniform('u_up', up);
    }
  }

  /** load tilesets for a city (unloading others). */
  async showCity(city: CityDef | null): Promise<void> {
    const key = city ? city.buildings + ':' + city.id : 'none';
    if (this.loadingKey === key || this.active.some((m) => m.key === key)) return;
    this.loadingKey = key;
    const defs = city ? this.tilesetDefs(city) : [];
    const next: Managed[] = [];
    for (const d of defs) {
      try {
        const tileset = await Cesium3DTileset.fromUrl(d.url, {
          maximumScreenSpaceError: this.sse,
          cacheBytes: matchMedia('(pointer: coarse)').matches ? 256 * 1024 * 1024 : 768 * 1024 * 1024,
          shadows: this.shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED,
          dynamicScreenSpaceError: true,
          foveatedScreenSpaceError: true,
          preferLeaves: false,
          enableCollision: false,
        });
        const shader = makeFacadeShader(d.style);
        tileset.customShader = shader;
        if (this.loadingKey !== key) {
          tileset.destroy();
          return;
        }
        this.viewer.scene.primitives.add(tileset);
        next.push({ key, tileset, shader });
      } catch (e) {
        console.warn('tileset failed', d.url, e);
      }
    }
    if (this.loadingKey !== key) {
      next.forEach((m) => this.viewer.scene.primitives.remove(m.tileset));
      return;
    }
    for (const m of this.active) this.viewer.scene.primitives.remove(m.tileset);
    this.active = next;
    this.loadingKey = null;
  }

  get tilesets(): Cesium3DTileset[] {
    return this.active.map((m) => m.tileset);
  }

  private tilesetDefs(city: CityDef): { url: string; style: FacadeStyle }[] {
    switch (city.buildings) {
      case 'plateau': {
        const list = (plateau as Record<string, { url: string }[]>)[city.id] ?? [];
        return list.map((t) => ({ url: t.url, style: FACADES.plateau }));
      }
      case 'swisstopo':
        return [{ url: 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json', style: FACADES.swisstopo }];
      case 'helsinki':
        // City of Helsinki reality mesh (photogrammetry, KTX2 textures). Heights are N2000 (≈ sea level),
        // so this city uses a flat ellipsoid terrain – the mesh itself is the ground.
        return [
          {
            url: 'https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json',
            style: FACADES.plateau,
          },
        ];
      case '3dbag':
        return [{ url: 'https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json', style: FACADES['3dbag'] }];
      default:
        return [];
    }
  }
}

export const BUILDING_CREDITS: Record<string, string> = {
  plateau: '3D都市モデル: 国土交通省 Project PLATEAU',
  helsinki: '3D reality mesh © City of Helsinki (CC BY 4.0)',
  swisstopo: 'swissBUILDINGS3D © swisstopo',
  '3dbag': '3DBAG © tudelft3d & 3DGI (CC BY 4.0)',
  osm: '建物: © OpenStreetMap contributors (ODbL)',
};
