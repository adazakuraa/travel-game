import type { GameAPI, Poi } from '../types';
import { CITIES, type CityDef } from '../data/cities';
import { POIS } from '../data/pois';
import { countryAt, haversine, type CountryInfo } from '../services/geo';
import { emptyRecords, loadRecords, saveLastPosition, saveRecords, type Records } from '../store/storage';

export interface TrackerEvents {
  onCountry?(c: CountryInfo): void;
  onCity?(c: CityDef): void;
}

let records: Records = loadRecords();
const listeners = new Set<() => void>();

export const recordsStore = {
  get: () => records,
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  reset(): void {
    records = emptyRecords();
    saveRecords(records);
    listeners.forEach((l) => l());
  },
  markPoi(poi: Poi): void {
    if (records.pois[poi.id]) return;
    records.pois[poi.id] = Date.now();
    dirty();
  },
};

let saveTimer = 0;
function dirty(): void {
  listeners.forEach((l) => l());
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    saveRecords(records);
  }, 2000);
}

export function startTracker(game: GameAPI, ev: TrackerEvents = {}): void {
  let prev: { lat: number; lon: number } | null = null;
  let lastCountryCheck: { lat: number; lon: number } | null = null;
  let lastSave = 0;

  game.on('position', (p) => {
    let changed = false;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      if (d <= 2000 && d > 0.2) {
        records.distance[p.mode] += d;
        changed = true;
      }
    }
    prev = { lat: p.lat, lon: p.lon };

    for (const c of CITIES) {
      if (records.cities[c.id]) continue;
      if (haversine(p.lat, p.lon, c.start.lat, c.start.lon) <= c.radiusKm * 1000) {
        records.cities[c.id] = Date.now();
        changed = true;
        ev.onCity?.(c);
      }
    }

    for (const poi of POIS) {
      if (records.pois[poi.id]) continue;
      if (Math.abs(poi.lat - p.lat) > 0.003 || Math.abs(poi.lon - p.lon) > 0.004) continue;
      if (haversine(p.lat, p.lon, poi.lat, poi.lon) <= 150) {
        records.pois[poi.id] = Date.now();
        changed = true;
      }
    }

    if (!lastCountryCheck || haversine(lastCountryCheck.lat, lastCountryCheck.lon, p.lat, p.lon) > 300) {
      lastCountryCheck = { lat: p.lat, lon: p.lon };
      countryAt(p.lat, p.lon).then((c) => {
        if (!c) return;
        const key = c.iso !== '-99' ? c.iso : c.name;
        if (!records.countries[key]) {
          records.countries[key] = { name: c.name, nameJa: c.nameJa, at: Date.now() };
          dirty();
          ev.onCountry?.(c);
        }
      });
    }

    if (changed) dirty();

    const now = Date.now();
    if (now - lastSave >= 5000) {
      lastSave = now;
      saveLastPosition({ lat: p.lat, lon: p.lon, heading: p.heading, mode: p.mode });
    }
  });

  game.on('poiNearby', ({ poi }) => recordsStore.markPoi(poi));
}
