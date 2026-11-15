import type { AudioAPI, GameAPI, LatLon, Poi, TravelMode } from '../types';
import type { ToastOpts } from './toast';

export interface TeleportTarget extends LatLon {
  heading?: number;
  mode?: TravelMode;
}

/** Card subject: either a curated POI or a generic Wikipedia landmark. */
export interface CardSubject {
  id: string;
  kind: 'poi' | 'wiki';
  name: string;
  nameLocal?: string;
  categoryLabel: string;
  icon: string;
  lat: number;
  lon: number;
  heading?: number;
  summary?: string;
  history?: string;
  culture?: string;
  trivia?: string;
  wikiJa?: string;
  wikiEn?: string;
  poi?: Poi;
}

export interface UiContext {
  game: GameAPI;
  audio: AudioAPI;
  toast(msg: string, opts?: ToastOpts): void;
  setLoading(active: boolean, label?: string): void;
  /** teleport with sfx / loading / error handling; closes open map etc. via onDone */
  travel(target: TeleportTarget): Promise<void>;
  openPoi(poi: Poi): void;
  openCard(subject: CardSubject): void;
  openMap(opts?: { visited?: boolean }): void;
  openRecords(tab?: 'fav' | 'records'): void;
  openSettings(): void;
}
