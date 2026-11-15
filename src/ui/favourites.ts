import { loadFavourites, saveFavourites, type Favourite } from '../store/storage';

let favs: Favourite[] = loadFavourites();
const listeners = new Set<() => void>();

function commit(): void {
  saveFavourites(favs);
  listeners.forEach((l) => l());
}

export const favourites = {
  all: () => favs,
  has: (id: string) => favs.some((f) => f.id === id),
  add(f: Omit<Favourite, 'savedAt'>): void {
    if (favs.some((x) => x.id === f.id)) return;
    favs = [{ ...f, savedAt: Date.now() }, ...favs];
    commit();
  },
  remove(id: string): void {
    favs = favs.filter((f) => f.id !== id);
    commit();
  },
  rename(id: string, name: string): void {
    favs = favs.map((f) => (f.id === id ? { ...f, name } : f));
    commit();
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
