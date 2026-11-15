import type { GraphicsQuality, TravelMode, WeatherKind } from '../types';

const PREFIX = 'wt3d.';
const VERSION = 1;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}.v${VERSION}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}${key}.v${VERSION}`, JSON.stringify(value));
  } catch {
    /* private mode / quota: ignore */
  }
}

export type Settings = {
  quality: GraphicsQuality;
  roadAssist: boolean;
  timeOverride: number | null;
  weatherOverride: WeatherKind | null;
};

export type Volumes = { master: number; music: number; sfx: number; ambient: number };

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  roadAssist: true,
  timeOverride: null,
  weatherOverride: null,
};
export const DEFAULT_VOLUMES: Volumes = { master: 0.8, music: 0.5, sfx: 0.8, ambient: 0.8 };

const QUALITIES: GraphicsQuality[] = ['auto', 'low', 'medium', 'high', 'ultra'];
const WEATHERS: WeatherKind[] = ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'storm'];

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>('settings') ?? {};
  return {
    quality: QUALITIES.includes(s.quality as GraphicsQuality) ? (s.quality as GraphicsQuality) : DEFAULT_SETTINGS.quality,
    roadAssist: typeof s.roadAssist === 'boolean' ? s.roadAssist : DEFAULT_SETTINGS.roadAssist,
    timeOverride: typeof s.timeOverride === 'number' && isFinite(s.timeOverride) ? s.timeOverride : null,
    weatherOverride: WEATHERS.includes(s.weatherOverride as WeatherKind) ? (s.weatherOverride as WeatherKind) : null,
  };
}
export function saveSettings(s: Settings): void {
  write('settings', s);
}

export function loadVolumes(): Volumes {
  const v = read<Partial<Volumes>>('volumes') ?? {};
  const n = (x: unknown, d: number) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : d);
  return {
    master: n(v.master, DEFAULT_VOLUMES.master),
    music: n(v.music, DEFAULT_VOLUMES.music),
    sfx: n(v.sfx, DEFAULT_VOLUMES.sfx),
    ambient: n(v.ambient, DEFAULT_VOLUMES.ambient),
  };
}
export function saveVolumes(v: Volumes): void {
  write('volumes', v);
}

export interface Favourite {
  id: string;
  kind: 'place' | 'poi' | 'wiki';
  name: string;
  lat: number;
  lon: number;
  heading?: number;
  mode?: TravelMode;
  poiId?: string;
  savedAt: number;
}

export function loadFavourites(): Favourite[] {
  const f = read<Favourite[]>('favourites');
  return Array.isArray(f) ? f.filter((x) => x && typeof x.lat === 'number' && typeof x.lon === 'number') : [];
}
export function saveFavourites(f: Favourite[]): void {
  write('favourites', f);
}

export interface Records {
  countries: Record<string, { name: string; nameJa: string; at: number }>;
  cities: Record<string, number>;
  pois: Record<string, number>;
  /** metres */
  distance: { car: number; walk: number; plane: number };
}

export function emptyRecords(): Records {
  return { countries: {}, cities: {}, pois: {}, distance: { car: 0, walk: 0, plane: 0 } };
}
export function loadRecords(): Records {
  const r = read<Partial<Records>>('records');
  const e = emptyRecords();
  if (!r) return e;
  return {
    countries: r.countries ?? e.countries,
    cities: r.cities ?? e.cities,
    pois: r.pois ?? e.pois,
    distance: { ...e.distance, ...(r.distance ?? {}) },
  };
}
export function saveRecords(r: Records): void {
  write('records', r);
}

export interface LastPosition {
  lat: number;
  lon: number;
  heading: number;
  mode: TravelMode;
}
export function loadLastPosition(): LastPosition | null {
  const p = read<LastPosition>('lastPosition');
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
  const mode: TravelMode = p.mode === 'walk' || p.mode === 'plane' ? p.mode : 'car';
  return { lat: p.lat, lon: p.lon, heading: typeof p.heading === 'number' ? p.heading : 0, mode };
}
export function saveLastPosition(p: LastPosition): void {
  write('lastPosition', p);
}
