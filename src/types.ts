// Shared contracts between modules. Keep this file small and stable:
// every subsystem (world / game / ui / audio) depends only on these types.

export type TravelMode = 'car' | 'walk' | 'plane';
export type ViewMode = 'first' | 'third';

/** Data quality tier honestly shown to the player. */
export type QualityTier = 'S' | 'A' | 'B';

export type Region = 'jp' | 'eu' | 'us' | 'alps' | 'other';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface PlayerState extends LatLon {
  /** ellipsoidal height in metres */
  height: number;
  /** metres above ground */
  agl: number;
  /** heading in degrees, 0 = north, clockwise */
  heading: number;
  /** m/s */
  speed: number;
  mode: TravelMode;
  view: ViewMode;
}

export type PoiCategory =
  | 'heritage' // 世界遺産
  | 'nature' // 自然
  | 'view' // 絶景
  | 'museum' // 博物館・美術館
  | 'history' // 歴史的建造物
  | 'landmark' // ランドマーク
  | 'religion' // 寺社・教会
  | 'shopping'; // 街歩き・商業

export interface Poi extends LatLon {
  id: string;
  cityId: string;
  name: string; // 日本語名
  nameLocal?: string; // 現地語名
  category: PoiCategory;
  /** 2〜3文の概要 */
  summary: string;
  /** 歴史 */
  history: string;
  /** 文化・見どころ */
  culture: string;
  /** 豆知識 */
  trivia: string;
  /** Wikipedia article title (ja) for photo lookup */
  wikiJa?: string;
  /** Wikipedia article title (en) fallback */
  wikiEn?: string;
  /** initial camera heading (deg) when teleporting here */
  heading?: number;
}

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';

export interface WeatherState {
  kind: WeatherKind;
  temperature: number | null; // °C
  cloudCover: number; // 0..100
  windSpeed: number; // m/s
  precipitation: number; // mm/h
  source: 'live' | 'manual' | 'default';
}

export interface EnvironmentState {
  /** IANA tz name if known */
  timezone: string | null;
  /** offset seconds from UTC for the current location */
  utcOffsetSeconds: number;
  /** current local time at the player location (as a Date whose UTC fields hold local wall-clock) */
  localWallClock: Date;
  /** null = real time, otherwise forced local hour 0..24 */
  timeOverride: number | null;
  weather: WeatherState;
  weatherOverride: WeatherKind | null;
}

export type GraphicsQuality = 'auto' | 'low' | 'medium' | 'high' | 'ultra';

export interface GameEvents {
  /** throttled to ~2 Hz */
  position: PlayerState;
  mode: { mode: TravelMode; view: ViewMode };
  city: { cityId: string | null };
  environment: EnvironmentState;
  /** fired when the player is within ~150 m of a POI for the first time in a session */
  poiNearby: { poi: Poi };
  status: { message: string; level?: 'info' | 'warn' | 'error' };
  loading: { active: boolean; label?: string };
}

/** Public API of the game core, consumed by UI modules. */
export interface GameAPI {
  teleport(target: LatLon & { heading?: number; mode?: TravelMode }): Promise<void>;
  getPlayer(): PlayerState;
  setMode(mode: TravelMode): void;
  toggleView(): void;
  setTimeOverride(localHour: number | null): void;
  setWeatherOverride(kind: WeatherKind | null): void;
  getEnvironment(): EnvironmentState;
  setQuality(q: GraphicsQuality): void;
  getQuality(): GraphicsQuality;
  setRoadAssist(on: boolean): void;
  /** pause game input while UI panels capture keyboard */
  setInputEnabled(on: boolean): void;
  on<K extends keyof GameEvents>(ev: K, cb: (payload: GameEvents[K]) => void): () => void;
}

/** Ambient sound profile computed by the game core and fed to the audio engine. */
export interface AmbientProfile {
  region: Region;
  urban: number; // 0..1 traffic / city hum
  nature: number; // 0..1 birds / wind in trees
  water: number; // 0..1 waves / river
  rain: number; // 0..1
  wind: number; // 0..1
  night: boolean;
  altitude: number; // metres AGL, used to fade ground ambience when flying
}

export interface EngineSoundState {
  kind: 'car' | 'plane' | 'none';
  /** 0..1 normalised rpm / N1 */
  rpm: number;
  /** 0..1 */
  throttle: number;
  /** m/s */
  speed: number;
  /** interior view muffles sound */
  interior: boolean;
}

/** Public API of the audio engine (src/audio). */
export interface AudioAPI {
  /** must be called from a user gesture handler (iOS) */
  unlock(): Promise<void>;
  setEngine(s: EngineSoundState): void;
  setAmbient(p: AmbientProfile): void;
  /** region-flavoured procedural music; null = stop */
  setMusic(region: Region | null): void;
  setVolumes(v: Partial<{ master: number; music: number; sfx: number; ambient: number }>): void;
  getVolumes(): { master: number; music: number; sfx: number; ambient: number };
  /** short one-shot effects */
  playSfx(name: 'click' | 'chime' | 'horn' | 'teleport'): void;
}
