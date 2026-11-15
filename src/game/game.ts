// Game core: owns the Cesium viewer, the world layers, vehicles, camera and the per-frame loop.
import {
  Axis,
  Cartesian3,
  Cartographic,
  Credit,
  EllipsoidTerrainProvider,
  Math as CMath,
  Matrix3,
  Matrix4,
  Model,
  PerspectiveFrustum,
  ShadowMode,
  Transforms,
  sampleTerrain,
  sampleTerrainMostDetailed,
  type TerrainProvider,
  type Viewer,
} from 'cesium';
import { Emitter } from '../core/events';
import { CITIES, type CityDef } from '../data/cities';
import { POIS } from '../data/pois';
import { fetchWeather, offsetForZone } from '../services/weather';
import type {
  AudioAPI,
  EnvironmentState,
  GameAPI,
  GameEvents,
  GraphicsQuality,
  LatLon,
  PlayerState,
  TravelMode,
  ViewMode,
  WeatherKind,
} from '../types';
import { BUILDING_CREDITS, BuildingManager, FACADES } from '../world/buildings';
import { EnvironmentController } from '../world/environment';
import { addImagery } from '../world/imagery';
import { cellKey, CELL, findRunways, loadCell, setWantedCells } from '../world/osm';
import { OsmBuildingLayer } from '../world/osmBuildings';
import { makeOpenTerrain, makeSwissTerrain } from '../world/terrain';
import { applyQuality, createViewer, detectQuality, PRESETS } from '../world/viewer';
import { Input } from './input';
import { RoadNetwork } from './roads';
import { Car, Plane, Walker, type Ground, type Pose } from './vehicles';

const D2R = Math.PI / 180;

// Eye points in model space (glTF: +X left, +Y up, +Z forward) — see scripts/build-models.mjs
const CAR_EYE = { x: -0.37, y: 1.17, z: -0.12 };
const PLANE_EYE = { x: -0.5, y: 4.88, z: 15.4 };

const haversine = (a: LatLon, b: LatLon) => {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

const CITY_IMAGERY_CREDIT: Record<string, string> = {
  JP: '航空写真・標高: 国土地理院',
  CH: '航空写真・地形: © swisstopo',
  NL: 'Luchtfoto: PDOK (CC BY 4.0)',
  FR: 'Orthophotos: IGN (Licence Ouverte)',
  US: 'Imagery: USGS',
};

const CITY_WATER: Record<string, number> = { helsinki: 0.6, amsterdam: 0.5, yokohama: 0.5, newyork: 0.3, zurich: 0.3, paris: 0.2 };

export class Game implements GameAPI {
  viewer!: Viewer;
  private ev = new Emitter();
  private input!: Input;
  private roads = new RoadNetwork();
  private buildings!: BuildingManager;
  private osmLayer!: OsmBuildingLayer;
  private env!: EnvironmentController;
  private car = new Car();
  private walker = new Walker();
  private plane = new Plane();
  private carModel: Model | null = null;
  private planeModel: Model | null = null;
  private mode: TravelMode = 'car';
  private view: ViewMode = 'third';
  private city: CityDef | null = null;
  private quality: GraphicsQuality = 'auto';
  private resolution = 1;
  private terrainKind: 'open' | 'swiss' | 'flat' = 'open';
  private openTerrain!: TerrainProvider;
  private swissTerrain: TerrainProvider | null = null;
  private meshGround = false;
  private ready = false;
  private teleporting = false;
  private camYaw = 0; // orbit/look offset (deg)
  private camPitch = -12;
  private camDist = 7.5;
  private camPos: Cartesian3 | null = null;
  private lastT = performance.now();
  private timers = { pos: 0, cells: 0, city: 0, poi: 0, ambient: 0, night: 0, weather: 0, fps: 0, env: 0 };
  private frames = 0;
  private audioT = 0;
  private seenPoi = new Set<string>();
  private lastCityId: string | null = null;
  private scratch = { m3: new Matrix3(), m4: new Matrix4(), c3: new Cartesian3() };

  constructor(private container: HTMLElement, private overlay: HTMLElement, private audio: AudioAPI) {}

  async init() {
    this.openTerrain = makeOpenTerrain();
    this.viewer = createViewer(this.container, this.openTerrain);
    addImagery(this.viewer);
    this.buildings = new BuildingManager(this.viewer);
    this.osmLayer = new OsmBuildingLayer(this.viewer, FACADES.osm);
    this.env = new EnvironmentController(this.viewer);
    this.env.mobile = matchMedia('(pointer: coarse)').matches;
    this.input = new Input(this.viewer.canvas, this.overlay);
    this.setQuality('auto');
    // initial globe view
    this.viewer.camera.setView({ destination: Cartesian3.fromDegrees(60, 30, 2.2e7) });
    try {
      this.carModel = await Model.fromGltfAsync({ url: './models/car.glb', upAxis: Axis.Z, forwardAxis: Axis.X, shadows: ShadowMode.ENABLED });
      this.carModel.show = false;
      this.viewer.scene.primitives.add(this.carModel);
    } catch (e) {
      console.warn('car model missing', e);
    }
    try {
      this.planeModel = await Model.fromGltfAsync({ url: './models/airliner.glb', upAxis: Axis.Z, forwardAxis: Axis.X, shadows: ShadowMode.ENABLED });
      this.planeModel.show = false;
      this.viewer.scene.primitives.add(this.planeModel);
    } catch (e) {
      console.warn('plane model missing', e);
    }
    this.viewer.scene.preRender.addEventListener(() => this.frame());
  }

  // ------------------------------------------------------------------ GameAPI
  on<K extends keyof GameEvents>(ev: K, cb: (p: GameEvents[K]) => void) {
    return this.ev.on(ev, cb);
  }

  getPlayer(): PlayerState {
    const p = this.pose();
    const [lat, lon] = this.roads.toLatLon(p.x, p.y);
    const speed = this.mode === 'car' ? Math.abs(this.car.speed) : this.mode === 'plane' ? this.plane.speed : this.walker.speed;
    const agl = this.mode === 'plane' ? this.plane.agl : 0;
    return { lat, lon, height: p.z, agl, heading: p.heading, speed, mode: this.mode, view: this.view };
  }

  getEnvironment(): EnvironmentState {
    return { ...this.env.state };
  }

  setTimeOverride(h: number | null) {
    this.env.state.timeOverride = h;
    this.emitEnv();
  }

  setWeatherOverride(k: WeatherKind | null) {
    this.env.state.weatherOverride = k;
    this.emitEnv();
  }

  getQuality() {
    return this.quality;
  }

  setQuality(q: GraphicsQuality) {
    this.quality = q;
    const preset = PRESETS[q === 'auto' ? detectQuality() : q];
    this.resolution = preset.resolutionScale;
    applyQuality(this.viewer, preset);
    this.buildings.setQuality(preset.tilesetSSE, preset.shadows);
    this.osmLayer.setShadows(preset.shadows);
  }

  setRoadAssist(on: boolean) {
    this.car.roadAssist = on;
  }

  setInputEnabled(on: boolean) {
    this.input.enabled = on;
  }

  toggleView() {
    this.view = this.view === 'first' ? 'third' : 'first';
    this.camYaw = 0;
    this.camPos = null;
    this.ev.emit('mode', { mode: this.mode, view: this.view });
  }

  setMode(mode: TravelMode) {
    if (mode === this.mode || this.teleporting) return;
    void this.switchMode(mode);
  }

  async teleport(t: LatLon & { heading?: number; mode?: TravelMode }) {
    if (this.teleporting) return;
    this.teleporting = true;
    this.ev.emit('loading', { active: true, label: '移動中…' });
    try {
      const mode = t.mode ?? (this.ready ? this.mode : 'car');
      const city = this.nearestCity(t.lat, t.lon);
      await this.enterCity(city, t.lat, t.lon);
      this.roads.setOrigin(t.lat, t.lon);
      this.meshCache.clear();
      this.meshPending.clear();
      this.osmLayer.clear();
      // old local coordinates are meaningless relative to the new origin
      for (const v of [this.car.pose, this.walker.pose, this.plane.pose]) v.x = v.y = 0;
      // look down at the destination while terrain and data stream in
      this.viewer.camera.setView({
        destination: Cartesian3.fromDegrees(t.lon, t.lat - 0.0025, 450),
        orientation: { heading: 0, pitch: -55 * D2R, roll: 0 },
      });
      this.camPos = null;
      const cellsP = this.loadCellsAround(t.lat, t.lon, 1);
      const ground = await this.waitGround(t.lat, t.lon, 9000);
      await Promise.race([cellsP, sleep(7000)]);
      const heading = t.heading ?? 0;
      await this.placeMode(mode, 0, 0, ground ?? 0, heading, true);
      this.ready = true;
      this.updateZone(t.lat, t.lon);
      this.audio.playSfx('teleport');
      this.ev.emit('mode', { mode: this.mode, view: this.view });
    } finally {
      this.teleporting = false;
      this.ev.emit('loading', { active: false });
    }
  }

  // ------------------------------------------------------------------ internals
  private pose(): Pose {
    return this.mode === 'car' ? this.car.pose : this.mode === 'plane' ? this.plane.pose : this.walker.pose;
  }

  private nearestCity(lat: number, lon: number): CityDef | null {
    let best: CityDef | null = null;
    let bd = Infinity;
    for (const c of CITIES) {
      const d = haversine({ lat, lon }, c.start);
      if (d < c.radiusKm * 1000 * 1.6 && d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private async enterCity(city: CityDef | null, lat: number, lon: number) {
    this.city = city;
    // terrain source
    const want: 'open' | 'swiss' | 'flat' = city?.terrain === 'swisstopo' ? 'swiss' : city?.terrain === 'flat' ? 'flat' : 'open';
    if (want !== this.terrainKind) {
      if (want === 'swiss') {
        try {
          this.swissTerrain ??= await makeSwissTerrain();
          if (this.city === city) this.viewer.terrainProvider = this.swissTerrain;
        } catch {
          if (this.city === city) this.viewer.terrainProvider = this.openTerrain;
        }
        if (this.city !== city) return; // another city was entered while loading
      } else if (want === 'flat') this.viewer.terrainProvider = new EllipsoidTerrainProvider();
      else this.viewer.terrainProvider = this.openTerrain;
      this.terrainKind = want;
    }
    this.meshGround = city?.buildings === 'helsinki';
    this.ground.noisy = this.meshGround;
    // OSM extrusion style per city
    if (city?.buildings === 'osm') this.osmLayer.style = FACADES[city.id] ?? FACADES.osm;
    this.osmLayer.defaultLevels = city?.id === 'paris' ? 6 : city?.id === 'newyork' ? 5 : 3;
    void this.buildings.showCity(city);
    this.updateCityCredit(city);
    if (city?.id !== this.lastCityId) {
      this.lastCityId = city?.id ?? null;
      this.ev.emit('city', { cityId: this.lastCityId });
      this.audio.setMusic(city ? city.region : 'other');
    }
    void lat;
    void lon;
  }

  // on-screen attribution for the data used in the current city (OSM is always on screen)
  private cityCredit: Credit | null = null;
  private osmCredit: Credit | null = null;
  private updateCityCredit(city: CityDef | null) {
    const cd = this.viewer.creditDisplay;
    if (!this.osmCredit) {
      this.osmCredit = new Credit(
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)',
        true,
      );
      cd.addStaticCredit(this.osmCredit);
    }
    if (this.cityCredit) cd.removeStaticCredit(this.cityCredit);
    this.cityCredit = null;
    const parts = city ? [CITY_IMAGERY_CREDIT[city.country], BUILDING_CREDITS[city.buildings]].filter(Boolean) : [];
    const text = parts.join(' · ');
    if (text) {
      this.cityCredit = new Credit(text, true);
      cd.addStaticCredit(this.cityCredit);
    }
  }

  private updateZone(lat: number, lon: number) {
    const tz = this.city?.timezone ?? null;
    const off = tz ? offsetForZone(tz) : Math.round(lon / 15) * 3600;
    this.env.setZone(tz, off);
    this.emitEnv();
    void fetchWeather(lat, lon).then((w) => {
      if (!w) {
        this.ev.emit('status', { message: '天気データを取得できませんでした(既定の天気で表示)', level: 'warn' });
        return;
      }
      this.env.setZone(w.timezone, w.utcOffsetSeconds);
      this.env.setLiveWeather(w.weather);
      this.emitEnv();
    });
  }

  private emitEnv() {
    this.ev.emit('environment', this.getEnvironment());
  }

  /** wait until terrain is available at a location; returns its height */
  private async waitGround(lat: number, lon: number, timeout: number): Promise<number | undefined> {
    const t0 = performance.now();
    const c = Cartographic.fromDegrees(lon, lat);
    let h: number | undefined;
    while (performance.now() - t0 < timeout) {
      h = this.viewer.scene.globe.getHeight(c);
      if (h !== undefined && performance.now() - t0 > 1500) {
        if (!this.meshGround) return h;
        const m = await this.sampleMesh(lat, lon);
        if (m !== undefined) return m;
      }
      await sleep(250);
    }
    return h;
  }

  private loadCellsAround(lat: number, lon: number, r: number): Promise<unknown> {
    const withB = this.city?.buildings === 'osm';
    const jobs: Promise<unknown>[] = [];
    const keep = new Set<string>();
    // centre first
    const order: [number, number][] = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) order.push([i, j]);
    order.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
    for (const [i, j] of order) {
      const key = cellKey(lat + i * CELL, lon + j * CELL);
      keep.add(key);
      if (this.roads.hasCell(key) && (!withB || this.osmLayer.has(key))) continue;
      jobs.push(
        loadCell(key, withB).then((cell) => {
          if (!cell) return;
          this.roads.addCell(cell);
          if (withB) return this.osmLayer.addCell(key, cell.buildings);
        }),
      );
    }
    // drop queued requests for cells we no longer need (after a teleport the old queue would delay us)
    const wantedCells = new Set(keep);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) wantedCells.add(cellKey(lat + i * CELL, lon + j * CELL));
    setWantedCells(wantedCells);
    // keep a slightly larger ring of building cells (and none at all outside OSM-building cities)
    this.osmLayer.prune(withB ? wantedCells : new Set());
    return Promise.all(jobs);
  }

  private ground: Ground = {
    noisy: false,
    height: (x: number, y: number, fromZ?: number) => {
      const [lat, lon] = this.roads.toLatLon(x, y);
      if (this.meshGround) {
        void fromZ;
        return this.meshHeight(x, y);
      }
      return this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
    },
  };

  // ---- mesh ground (photogrammetry cities): asynchronous most-detailed sampling into a 2 m grid.
  // Synchronous picking (sampleHeight / pickFromRay) proved unreliable on some GPUs, so we sample
  // ahead of the player with sampleHeightMostDetailed and read heights from the cache.
  private meshCache = new Map<string, number>();
  private meshPending = new Map<string, [number, number]>();
  private meshInflight = false;

  private meshHeight(x: number, y: number): number | undefined {
    const i = Math.round(x / 2);
    const j = Math.round(y / 2);
    const key = i + ',' + j;
    const h = this.meshCache.get(key);
    if (h === undefined && !this.meshPending.has(key)) this.meshPending.set(key, [i * 2, j * 2]);
    return h;
  }

  private prefetchMesh(p: Pose) {
    const h = p.heading * D2R;
    const fx = Math.sin(h);
    const fy = Math.cos(h);
    const speed = this.mode === 'car' ? Math.abs(this.car.speed) : 2;
    const ahead = Math.min(80, 12 + speed * 2.5);
    for (let d = -4; d <= ahead; d += 2)
      for (const s of [-2, 0, 2]) this.meshHeight(p.x + fx * d + fy * s, p.y + fy * d - fx * s);
    if (this.meshInflight || !this.meshPending.size) return;
    const batch = [...this.meshPending.entries()].slice(0, 48);
    const cartos = batch.map(([, [x, y]]) => {
      const [lat, lon] = this.roads.toLatLon(x, y);
      return Cartographic.fromDegrees(lon, lat);
    });
    this.meshInflight = true;
    const exclude: any[] = [this.carModel, this.planeModel].filter(Boolean);
    this.viewer.scene
      .sampleHeightMostDetailed(cartos, exclude, 0.2)
      .then((res) => {
        res.forEach((c, k) => {
          const key = batch[k][0];
          this.meshPending.delete(key);
          if (c && Number.isFinite(c.height)) this.meshCache.set(key, c.height);
        });
        if (this.meshCache.size > 40000) this.meshCache.clear();
      })
      .catch(() => batch.forEach(([key]) => this.meshPending.delete(key)))
      .finally(() => (this.meshInflight = false));
  }

  private async sampleMesh(lat: number, lon: number): Promise<number | undefined> {
    try {
      const exclude: any[] = [this.carModel, this.planeModel].filter(Boolean);
      const r = await this.viewer.scene.sampleHeightMostDetailed([Cartographic.fromDegrees(lon, lat)], exclude, 0.2);
      return r[0] && Number.isFinite(r[0].height) ? r[0].height : undefined;
    } catch {
      return undefined;
    }
  }

  private async placeMode(mode: TravelMode, x: number, y: number, z: number, heading: number, fresh: boolean) {
    if (mode === 'car') {
      // snap to the nearest road
      const n = this.roads.nearest(x, y, undefined, 120);
      let hdg = heading;
      if (n) {
        x = n.px;
        y = n.py;
        let roadHdg = 90 - n.dir / D2R;
        if (Math.abs(((roadHdg - heading + 540) % 360) - 180) > 90) roadHdg += 180;
        hdg = (roadHdg + 360) % 360;
      }
      this.car.place(x, y, await this.groundAt(x, y, z), hdg);
    } else if (mode === 'walk') {
      this.walker.place(x, y, await this.groundAt(x, y, z), heading);
    } else {
      await this.placePlane(x, y, z, heading, fresh);
    }
    this.mode = mode;
    this.input.setMode(mode);
    this.camPos = null;
    this.camYaw = 0;
    this.camDist = mode === 'plane' ? 55 : mode === 'walk' ? 4.5 : 7.5;
    this.camPitch = mode === 'plane' ? -8 : -12;
  }

  /** reliable ground height for placing the player (mesh cities need an async most-detailed sample) */
  private async groundAt(x: number, y: number, fallback: number): Promise<number> {
    if (this.meshGround) {
      const [lat, lon] = this.roads.toLatLon(x, y);
      return (await this.sampleMesh(lat, lon)) ?? fallback;
    }
    const [lat, lon] = this.roads.toLatLon(x, y);
    if (this.terrainKind === 'flat') return 0;
    // read the terrain data itself (the rendered globe can report tile-skirt heights while LODs load)
    try {
      const pos = [Cartographic.fromDegrees(lon, lat)];
      const [c] =
        this.terrainKind === 'swiss'
          ? await sampleTerrainMostDetailed(this.viewer.terrainProvider, pos)
          : await sampleTerrain(this.viewer.terrainProvider, 16, pos);
      if (c && Number.isFinite(c.height)) return c.height;
    } catch {
      /* fall back to the rendered globe */
    }
    return this.ground.height(x, y) ?? fallback;
  }

  private async placePlane(x: number, y: number, z: number, heading: number, _fresh: boolean) {
    const [lat, lon] = this.roads.toLatLon(x, y);
    this.ev.emit('status', { message: '近くの空港の滑走路を探しています…' });
    const rws = await findRunways(lat, lon, 45);
    let best: { len: number; a: { lat: number; lon: number }; b: { lat: number; lon: number } } | null = null;
    for (const w of rws) {
      const g = w.geometry;
      if (g.length < 2) continue;
      const a = g[0];
      const b = g[g.length - 1];
      const len = haversine(a, b);
      if (len > 1500 && (!best || len > best.len)) best = { len, a, b };
    }
    if (best) {
      const [ax, ay] = this.roads.toLocal(best.a.lat, best.a.lon);
      const [bx, by] = this.roads.toLocal(best.b.lat, best.b.lon);
      const hdg = (90 - Math.atan2(by - ay, bx - ax) / D2R + 360) % 360;
      const sx = ax + (bx - ax) * (60 / best.len);
      const sy = ay + (by - ay) * (60 / best.len);
      // make sure the runway terrain is loaded
      const [slat, slon] = this.roads.toLatLon(sx, sy);
      this.viewer.camera.setView({ destination: Cartesian3.fromDegrees(slon, slat - 0.004, 500), orientation: { heading: 0, pitch: -50 * D2R, roll: 0 } });
      const g0 = (await this.waitGround(slat, slon, 8000)) ?? 0;
      const g = await this.groundAt(sx, sy, g0);
      this.plane.place(sx, sy, g, hdg, false);
      this.ev.emit('status', { message: `滑走路(${Math.round(best.len)} m)に着きました。推力を上げて離陸しましょう` });
    } else {
      const g = this.ground.height(x, y) ?? z;
      this.plane.place(x, y, Math.max(g, z) + 700, heading, true);
      this.ev.emit('status', { message: '近くに滑走路がないため上空から開始します' });
    }
  }

  private async switchMode(mode: TravelMode) {
    const p = this.pose();
    this.teleporting = true;
    try {
      if (mode === 'walk' && this.mode === 'car') {
        const h = p.heading * D2R;
        await this.placeMode('walk', p.x - Math.cos(h) * 2.2, p.y + Math.sin(h) * 2.2, p.z, p.heading, false);
      } else {
        if (mode === 'plane') this.ev.emit('loading', { active: true, label: '空港へ移動中…' });
        await this.placeMode(mode, p.x, p.y, p.z, p.heading, false);
      }
      this.ev.emit('mode', { mode: this.mode, view: this.view });
    } finally {
      this.teleporting = false;
      this.ev.emit('loading', { active: false });
    }
  }

  // ------------------------------------------------------------------ frame loop
  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.frames++;
    if (!this.ready) return;
    if (this.meshGround && !this.teleporting) this.prefetchMesh(this.pose());
    const inp = this.input.frame();
    if (!this.teleporting) {
      if (inp.pressed.has('view')) this.toggleView();
      if (inp.pressed.has('mode:car')) this.setMode('car');
      if (inp.pressed.has('mode:walk')) this.setMode('walk');
      if (inp.pressed.has('mode:plane')) this.setMode('plane');
      if (inp.pressed.has('horn')) this.audio.playSfx('horn');
    }

    // camera look input
    this.camYaw += inp.lookDX * 0.25;
    this.camPitch = Math.max(-80, Math.min(60, this.camPitch - inp.lookDY * 0.2));
    if (inp.zoom) this.camDist = Math.max(3, Math.min(this.mode === 'plane' ? 300 : 40, this.camDist * (1 + inp.zoom * 0.1)));

    if (!this.teleporting) {
      if (this.mode === 'car') this.car.update(dt, inp, this.roads, this.ground);
      else if (this.mode === 'walk') {
        // desktop walking: mouse drag turns the body in first person
        if (this.view === 'first' || !this.input.touch) {
          this.walker.pose.heading = (this.walker.pose.heading + inp.lookDX * 0.25 + 360) % 360;
          this.walker.lookPitch = Math.max(-80, Math.min(80, this.walker.lookPitch - inp.lookDY * 0.2));
          this.camYaw = 0;
        }
        this.walker.update(dt, inp, this.ground, this.input.touch);
      } else {
        const ev = this.plane.update(dt, inp, this.ground, this.input.isDown('KeyB'));
        if (ev === 'crash') {
          this.ev.emit('status', { message: '墜落しました…上空から再開します', level: 'warn' });
          const p = this.plane.pose;
          this.plane.place(p.x, p.y, p.z + 800, p.heading, true);
        } else if (ev === 'touchdown') this.ev.emit('status', { message: '着陸成功!' });
        else if (ev === 'liftoff') this.ev.emit('status', { message: '離陸しました' });
      }
    }
    if (this.teleporting) {
      // the loader positions the camera itself; vehicle poses may be stale relative to the new origin
      if (this.carModel) this.carModel.show = false;
      if (this.planeModel) this.planeModel.show = false;
      this.audio.setEngine({ kind: 'none', rpm: 0, throttle: 0, speed: 0, interior: false });
      return;
    }
    // when the player travels far from the origin, rebase the local frame to keep precision
    let p = this.pose();
    if (Math.hypot(p.x, p.y) > 15000) {
      this.rebase();
      p = this.pose();
    }

    const [lat, lon] = this.roads.toLatLon(p.x, p.y);
    const position = Cartesian3.fromDegrees(lon, lat, p.z);
    this.updateModels(lat, lon, p);
    this.updateCamera(dt, lat, lon, p, position);
    this.env.update(lat, lon, p.z, position);

    // audio engine (~20 Hz is plenty and avoids piling up AudioParam events)
    this.audioT += dt;
    if (this.audioT < 0.05) return this.periodic(dt, lat, lon, p);
    this.audioT = 0;
    if (this.mode === 'car')
      this.audio.setEngine({ kind: 'car', rpm: this.car.rpm, throttle: this.car.throttle, speed: Math.abs(this.car.speed), interior: this.view === 'first' });
    else if (this.mode === 'plane')
      this.audio.setEngine({ kind: 'plane', rpm: 0.25 + this.plane.throttle * 0.75, throttle: this.plane.throttle, speed: this.plane.speed, interior: this.view === 'first' });
    else this.audio.setEngine({ kind: 'none', rpm: 0, throttle: 0, speed: 0, interior: false });

    this.periodic(dt, lat, lon, p);
  }

  private periodic(dt: number, lat: number, lon: number, p: Pose) {
    const t = this.timers;
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += dt;
    if (t.pos > 0.5) {
      t.pos = 0;
      this.ev.emit('position', this.getPlayer());
    }
    if (t.cells > 1.5 && !this.teleporting) {
      t.cells = 0;
      if (this.mode !== 'plane' || this.plane.agl < 150) void this.loadCellsAround(lat, lon, 1);
    }
    if (t.city > 3 && !this.teleporting) {
      t.city = 0;
      const c = this.nearestCity(lat, lon);
      if ((c?.id ?? null) !== (this.city?.id ?? null)) void this.enterCity(c, lat, lon).then(() => this.updateZone(lat, lon));
    }
    if (t.poi > 1) {
      t.poi = 0;
      for (const poi of POIS) {
        if (this.seenPoi.has(poi.id)) continue;
        if (Math.abs(poi.lat - lat) > 0.003 || Math.abs(poi.lon - lon) > 0.005) continue;
        if (haversine(poi, { lat, lon }) < 150) {
          this.seenPoi.add(poi.id);
          this.audio.playSfx('chime');
          this.ev.emit('poiNearby', { poi });
        }
      }
    }
    if (t.night > 0.5) {
      t.night = 0;
      const up = Cartesian3.normalize(Cartesian3.fromDegrees(lon, lat, 0), new Cartesian3());
      this.buildings.setNight(this.env.night, up);
      this.osmLayer.setNight(this.env.night, up);
    }
    if (t.ambient > 0.5) {
      t.ambient = 0;
      const w = this.env.effectiveWeather();
      const urban = this.city ? (this.city.buildings === 'none' ? 0.1 : 0.75) : 0.15;
      this.audio.setAmbient({
        region: this.city?.region ?? 'other',
        urban: urban * (this.env.night > 0.5 ? 0.6 : 1),
        nature: this.city?.buildings === 'none' ? 0.9 : 0.35,
        water: CITY_WATER[this.city?.id ?? ''] ?? 0.1,
        rain: w === 'rain' ? 0.7 : w === 'storm' ? 1 : 0,
        wind: Math.min(1, (this.env.state.weather.windSpeed || 2) / 14 + (w === 'storm' ? 0.4 : 0)),
        night: this.env.night > 0.5,
        altitude: this.mode === 'plane' ? this.plane.agl : 0,
      });
    }
    if (t.env > 10) {
      t.env = 0;
      this.emitEnv(); // keeps the HUD clock ticking
    }
    if (t.weather > 900) {
      t.weather = 0;
      this.updateZone(lat, lon);
    }
    if (t.fps > 2) {
      const fps = this.frames / t.fps;
      t.fps = 0;
      this.frames = 0;
      if (this.quality === 'auto') {
        const preset = PRESETS[detectQuality()];
        if (fps < 26 && this.resolution > 0.5) this.resolution = Math.max(0.5, this.resolution - 0.1);
        else if (fps > 50 && this.resolution < preset.resolutionScale) this.resolution = Math.min(preset.resolutionScale, this.resolution + 0.05);
        this.viewer.resolutionScale = this.resolution;
      }
    }
  }

  private rebase() {
    const p = this.pose();
    const [lat, lon] = this.roads.toLatLon(p.x, p.y);
    this.roads.setOrigin(lat, lon);
    this.meshCache.clear();
    this.meshPending.clear();
    const dx = p.x; // p aliases one of the poses below, so capture the offset first
    const dy = p.y;
    for (const v of [this.car.pose, this.walker.pose, this.plane.pose]) {
      v.x -= dx;
      v.y -= dy;
    }
    this.camPos = null;
    void this.loadCellsAround(lat, lon, 1);
  }

  /** ENU basis at a point + pose rotation → model matrix (model axes: +X left, +Y up, +Z forward).
   *  Allocation-free: called several times per frame. */
  private poseMatrix(lat: number, lon: number, p: Pose, result: Matrix4): Matrix4 {
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, p.z, undefined, this.scratch.c3), undefined, result);
    const ch = Math.cos(p.heading * D2R), sh = Math.sin(p.heading * D2R);
    const cp = Math.cos(p.pitch * D2R), sp = Math.sin(p.pitch * D2R);
    const cr = Math.cos(p.roll * D2R), sr = Math.sin(p.roll * D2R);
    // forward/up after pitch (in ENU): f = (sh*cp, ch*cp, sp), u = (-sh*sp, -ch*sp, cp)
    const fx = sh * cp, fy = ch * cp, fz = sp;
    const ux0 = -sh * sp, uy0 = -ch * sp, uz0 = cp;
    // right = f × u
    const rx = fy * uz0 - fz * uy0, ry = fz * ux0 - fx * uz0, rz = fx * uy0 - fy * ux0;
    // roll: rotate up towards right
    const ux = ux0 * cr + rx * sr, uy = uy0 * cr + ry * sr, uz = uz0 * cr + rz * sr;
    // left = u × f
    const lx = uy * fz - uz * fy, ly = uz * fx - ux * fz, lz = ux * fy - uy * fx;
    const m = this.scratch.m3 as unknown as number[]; // column-major storage
    m[0] = lx; m[1] = ly; m[2] = lz;
    m[3] = ux; m[4] = uy; m[5] = uz;
    m[6] = fx; m[7] = fy; m[8] = fz;
    return Matrix4.multiplyByMatrix3(enu, this.scratch.m3, result);
  }

  private updateModels(lat: number, lon: number, p: Pose) {
    if (this.carModel) {
      this.carModel.show = this.mode === 'car';
      if (this.mode === 'car') this.poseMatrix(lat, lon, p, this.carModel.modelMatrix);
    }
    if (this.planeModel) {
      this.planeModel.show = this.mode === 'plane';
      if (this.mode === 'plane') this.poseMatrix(lat, lon, p, this.planeModel.modelMatrix);
    }
  }

  private updateCamera(dt: number, lat: number, lon: number, p: Pose, position: Cartesian3) {
    const cam = this.viewer.camera;
    // wider field of view inside vehicles so the dashboard doesn't dominate the screen
    const fov = (this.view === 'first' && this.mode !== 'walk' ? 78 : 62) * D2R;
    const fr = cam.frustum as PerspectiveFrustum;
    if (Math.abs((fr.fov ?? 0) - fov) > 1e-3) fr.fov = fov;
    const m = this.poseMatrix(lat, lon, p, this.scratch.m4);
    const col = (i: number) => Cartesian3.normalize(new Cartesian3(m[i * 4], m[i * 4 + 1], m[i * 4 + 2]), new Cartesian3());
    const left = col(0);
    const up = col(1);
    const fwd = col(2);
    const worldUp = Cartesian3.normalize(position, new Cartesian3());

    if (this.view === 'first' && this.mode !== 'walk') {
      const eye = this.mode === 'car' ? CAR_EYE : PLANE_EYE;
      const pos = Cartesian3.clone(position);
      Cartesian3.add(pos, Cartesian3.multiplyByScalar(left, eye.x, new Cartesian3()), pos);
      Cartesian3.add(pos, Cartesian3.multiplyByScalar(up, eye.y, new Cartesian3()), pos);
      Cartesian3.add(pos, Cartesian3.multiplyByScalar(fwd, eye.z, new Cartesian3()), pos);
      // head look: yaw/pitch offsets relative to the vehicle
      this.camYaw = Math.max(-110, Math.min(110, this.camYaw)) * (1 - Math.min(1, dt * 0.8));
      const yaw = this.camYaw * D2R;
      const pitch = ((this.camPitch + 12) * 0.6 + (this.mode === "plane" ? -4 : 0)) * D2R;
      let dir = rotateAround(fwd, up, -yaw);
      const sideAxis = Cartesian3.cross(dir, up, new Cartesian3());
      dir = rotateAround(dir, Cartesian3.normalize(sideAxis, sideAxis), pitch);
      cam.setView({ destination: pos, orientation: { direction: dir, up } });
      return;
    }
    if (this.mode === 'walk') {
      const eyeH = 1.65;
      const h = (p.heading + (this.input.touch && this.view === 'third' ? this.camYaw : 0)) * D2R;
      const enu = Transforms.eastNorthUpToFixedFrame(position);
      const e = new Cartesian3(enu[0], enu[1], enu[2]);
      const n = new Cartesian3(enu[4], enu[5], enu[6]);
      const lookP = (this.input.touch ? this.camPitch + 7 : this.walker.lookPitch) * D2R;
      const dirH = Cartesian3.add(Cartesian3.multiplyByScalar(e, Math.sin(h), new Cartesian3()), Cartesian3.multiplyByScalar(n, Math.cos(h), new Cartesian3()), new Cartesian3());
      const dir = Cartesian3.normalize(
        Cartesian3.add(Cartesian3.multiplyByScalar(dirH, Math.cos(lookP), new Cartesian3()), Cartesian3.multiplyByScalar(worldUp, Math.sin(lookP), new Cartesian3()), new Cartesian3()),
        new Cartesian3(),
      );
      let pos = Cartesian3.add(position, Cartesian3.multiplyByScalar(worldUp, eyeH, new Cartesian3()), new Cartesian3());
      if (this.view === 'third') {
        pos = Cartesian3.subtract(pos, Cartesian3.multiplyByScalar(dir, this.camDist, new Cartesian3()), new Cartesian3());
        Cartesian3.add(pos, Cartesian3.multiplyByScalar(worldUp, 0.8, new Cartesian3()), pos);
      }
      cam.setView({ destination: this.clampAboveGround(pos), orientation: { direction: dir, up: worldUp } });
      return;
    }
    // third person chase camera (car / plane)
    const yaw = this.camYaw * D2R;
    const pitch = this.camPitch * D2R;
    const fwdFlat = Cartesian3.normalize(
      Cartesian3.subtract(fwd, Cartesian3.multiplyByScalar(worldUp, Cartesian3.dot(fwd, worldUp), new Cartesian3()), new Cartesian3()),
      new Cartesian3(),
    );
    let dir = rotateAround(fwdFlat, worldUp, -yaw);
    const side = Cartesian3.normalize(Cartesian3.cross(dir, worldUp, new Cartesian3()), new Cartesian3());
    dir = rotateAround(dir, side, pitch);
    const target = Cartesian3.add(position, Cartesian3.multiplyByScalar(worldUp, this.mode === 'plane' ? 4 : 1.3, new Cartesian3()), new Cartesian3());
    const desired = Cartesian3.subtract(target, Cartesian3.multiplyByScalar(dir, this.camDist, new Cartesian3()), new Cartesian3());
    if (!this.camPos || Cartesian3.distance(this.camPos, desired) > 200) this.camPos = desired;
    else Cartesian3.lerp(this.camPos, desired, Math.min(1, dt * 7), this.camPos);
    const camPos = this.clampAboveGround(this.camPos);
    const lookDir = Cartesian3.normalize(Cartesian3.subtract(target, camPos, new Cartesian3()), new Cartesian3());
    cam.setView({ destination: camPos, orientation: { direction: lookDir, up: worldUp } });
  }

  private clampAboveGround(pos: Cartesian3): Cartesian3 {
    const c = Cartographic.fromCartesian(pos);
    const g = this.meshGround ? undefined : this.viewer.scene.globe.getHeight(c);
    if (g !== undefined && c.height < g + 0.6) {
      return Cartesian3.fromRadians(c.longitude, c.latitude, g + 0.6);
    }
    return pos;
  }
}

function rotateAround(v: Cartesian3, axis: Cartesian3, angle: number): Cartesian3 {
  // Rodrigues
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = axis;
  const t1 = Cartesian3.multiplyByScalar(v, c, new Cartesian3());
  const t2 = Cartesian3.multiplyByScalar(Cartesian3.cross(k, v, new Cartesian3()), s, new Cartesian3());
  const t3 = Cartesian3.multiplyByScalar(k, Cartesian3.dot(k, v) * (1 - c), new Cartesian3());
  return Cartesian3.add(Cartesian3.add(t1, t2, t1), t3, t1);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export { CMath };
