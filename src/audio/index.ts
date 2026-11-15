// Web Audio engine for the world-travel simulator. Everything is synthesised at runtime.
//
//   engine / ambient / music / sfx  ->  bus gains  ->  master gain  ->  compressor  ->  destination
import type { AmbientProfile, AudioAPI, EngineSoundState, Region } from '../types';
import { Ambient } from './ambient';
import { EngineSynth } from './engine';
import { MusicEngine } from './music';
import { createNoiseHub, type NoiseHub } from './noise';
import { playSfx, type SfxName } from './sfx';

type Volumes = { master: number; music: number; sfx: number; ambient: number };
const STORAGE_KEY = 'wt3d.audio';
const DEFAULTS: Volumes = { master: 0.8, music: 0.35, sfx: 0.7, ambient: 0.6 };
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function loadVolumes(): Volumes {
  const v = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Partial<Volumes>;
      for (const k of Object.keys(v) as (keyof Volumes)[]) {
        if (typeof o[k] === 'number' && isFinite(o[k] as number)) v[k] = clamp01(o[k] as number);
      }
    }
  } catch { /* storage unavailable */ }
  return v;
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  ambient: GainNode;
  music: GainNode;
  hub: NoiseHub;
  engine: EngineSynth;
  amb: Ambient;
  mus: MusicEngine;
}

class AudioEngine implements AudioAPI {
  private vol: Volumes = loadVolumes();
  private g: Graph | null = null;
  private failed = false;
  private unlocking: Promise<void> | null = null;
  // state stored until (and re-applied after) unlock
  private engineState: EngineSoundState | null = null;
  private ambientState: AmbientProfile | null = null;
  private musicRegion: Region | null = null;

  unlock(): Promise<void> {
    if (this.failed) return Promise.resolve();
    if (this.g && this.g.ctx.state === 'running') return Promise.resolve();
    // Must start synchronously inside the gesture; keep the promise to avoid double builds.
    this.unlocking = this.doUnlock().catch(() => { /* never throw */ });
    return this.unlocking;
  }

  private async doUnlock(): Promise<void> {
    if (!this.g) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) { this.failed = true; return; }
      try {
        this.g = this.build(new Ctor({ latencyHint: 'balanced' }));
      } catch {
        this.failed = true;
        return;
      }
    }
    const ctx = this.g.ctx;
    try {
      // iOS Safari: playing a (silent) buffer inside the gesture fully unlocks output
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch { /* ignore */ }
    try { if (ctx.state !== 'running') await ctx.resume(); } catch { /* ignore */ }
    this.applyAll();
  }

  private build(ctx: AudioContext): Graph {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(comp);
    const bus = (): GainNode => { const n = ctx.createGain(); n.connect(master); return n; };
    const sfx = bus(), ambient = bus(), music = bus();
    const hub = createNoiseHub(ctx);
    return {
      ctx, master, sfx, ambient, music, hub,
      engine: new EngineSynth(ctx, sfx, hub),
      amb: new Ambient(ctx, ambient, hub),
      mus: new MusicEngine(ctx, music, hub),
    };
  }

  private applyVolumes(): void {
    const g = this.g;
    if (!g) return;
    const t = g.ctx.currentTime;
    g.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    g.music.gain.setTargetAtTime(this.vol.music, t, 0.05);
    g.sfx.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    g.ambient.gain.setTargetAtTime(this.vol.ambient, t, 0.05);
  }

  private applyAll(): void {
    const g = this.g;
    if (!g) return;
    // set values immediately on first build so nothing pops in from a stale default
    g.master.gain.value = this.vol.master;
    g.music.gain.value = this.vol.music;
    g.sfx.gain.value = this.vol.sfx;
    g.ambient.gain.value = this.vol.ambient;
    if (this.engineState) g.engine.update(this.engineState);
    if (this.ambientState) g.amb.set(this.ambientState);
    g.mus.setRegion(this.musicRegion);
  }

  setEngine(s: EngineSoundState): void {
    this.engineState = s;
    if (this.g) try { this.g.engine.update(s); } catch { /* ignore */ }
  }

  setAmbient(p: AmbientProfile): void {
    this.ambientState = p;
    if (this.g) try { this.g.amb.set(p); } catch { /* ignore */ }
  }

  setMusic(region: Region | null): void {
    this.musicRegion = region;
    if (this.g) try { this.g.mus.setRegion(region); } catch { /* ignore */ }
  }

  setVolumes(v: Partial<Volumes>): void {
    for (const k of Object.keys(this.vol) as (keyof Volumes)[]) {
      const x = v[k];
      if (typeof x === 'number' && isFinite(x)) this.vol[k] = clamp01(x);
    }
    this.applyVolumes();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.vol)); } catch { /* ignore */ }
  }

  getVolumes(): Volumes {
    return { ...this.vol };
  }

  playSfx(name: SfxName): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    try { playSfx(g.ctx, g.sfx, g.hub, name); } catch { /* ignore */ }
  }
}

export function createAudio(): AudioAPI {
  return new AudioEngine();
}
