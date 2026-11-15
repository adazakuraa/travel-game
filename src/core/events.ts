import type { GameEvents } from '../types';

type Handler<T> = (payload: T) => void;

export class Emitter {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(ev: K, cb: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(ev);
    if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  emit<K extends keyof GameEvents>(ev: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(ev);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (e) {
        console.warn('[event handler]', ev, e);
      }
    }
  }
}
