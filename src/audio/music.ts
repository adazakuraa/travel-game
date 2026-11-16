// Procedural, region-flavoured background music with a lookahead scheduler.
// Each region is a "Voice": it gets step() callbacks (one per 8th-note grid slot) and schedules
// notes at exact AudioContext times. Randomised melodies keep it from looping identically.
import type { Region } from '../types';
import type { NoiseHub } from './noise';
import { Pad, bass, bell, epiano, horn, mtof, pick, pluck, rnd } from './synth';

interface Voice {
  /** seconds per grid step (an 8th note) */
  stepDur: number;
  stepsPerBar: number;
  step(t: number, stepInBar: number, bar: number): void;
  dispose(): void;
}
type Factory = (ctx: AudioContext, out: GainNode, hub: NoiseHub) => Voice;

const bpmToStep = (bpm: number): number => 60 / bpm / 2;
/** random walk over an index range, staying in bounds */
const walk = (i: number, max: number, maxStep = 2): number =>
  Math.max(0, Math.min(max, i + Math.floor(rnd(-maxStep, maxStep + 1))));

// ---------------------------------------------------------------- JP: miyako-bushi + koto
const jp: Factory = (ctx, out) => {
  const root = 50; // D3
  const intervals = [0, 1, 5, 7, 8]; // in-scale (miyako-bushi)
  const pool: number[] = [];
  for (let o = 0; o < 3; o++) for (const i of intervals) pool.push(root + o * 12 + i);
  pool.push(root + 36);
  const pad = new Pad(ctx, out, 3, { type: 'triangle', cutoff: 900, level: 0.16, glide: 0.9 });
  const drones = [[50, 57, 62], [50, 55, 62], [46, 53, 58], [50, 57, 65]];
  let idx = 7;
  return {
    stepDur: bpmToStep(62), stepsPerBar: 8,
    step(t, s, bar) {
      if (s === 0 && bar % 2 === 0) pad.setChord(t, pick(drones));
      if (s === 0) pluck(ctx, out, t, mtof(root - 12 + (Math.random() < 0.3 ? 7 : 0)), 0.22, { cutoff: 1400 });
      const p = s % 2 === 0 ? 0.38 : 0.14;
      if (Math.random() > p) return;
      idx = bar % 4 === 3 && s === 6 ? pool.indexOf(root + 12) : walk(idx, pool.length - 1);
      const vel = rnd(0.16, 0.28);
      pluck(ctx, out, t, mtof(pool[idx]), vel);
      if (Math.random() < 0.15) { // quick grace-note ornament
        idx = walk(idx, pool.length - 1, 1);
        pluck(ctx, out, t + rnd(0.12, 0.2), mtof(pool[idx]), vel * 0.8);
      }
    },
    dispose: () => pad.dispose(),
  };
};

// ---------------------------------------------------------------- EU: diatonic progression, music box + strings
const eu: Factory = (ctx, out) => {
  const key = pick([60, 62, 65, 67]); // C D F G
  // chords as scale-degree triads in major
  const triad = (deg: number): number[] => {
    const sc = [0, 2, 4, 5, 7, 9, 11];
    const n = (d: number): number => sc[d % 7] + 12 * Math.floor(d / 7);
    return [n(deg), n(deg + 2), n(deg + 4)];
  };
  const progs = [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 0], [5, 3, 0, 4], [0, 2, 3, 4], [3, 4, 2, 5]];
  const scale = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19];
  let prog = pick(progs);
  const pad = new Pad(ctx, out, 3, { type: 'sawtooth', cutoff: 1100, level: 0.11, detune: 9, glide: 0.6 });
  let mi = 5;
  return {
    stepDur: bpmToStep(72), stepsPerBar: 8,
    step(t, s, bar) {
      const chord = triad(prog[bar % 4]);
      if (s === 0) {
        if (bar % 4 === 0) prog = pick(progs);
        pad.setChord(t, chord.map((n) => key + n - 12));
        bass(ctx, out, t, mtof(key + chord[0] - 24), 0.16, 1.1);
        // soft piano-ish low chord
        epiano(ctx, out, t + 0.01, mtof(key + chord[0] - 12), 0.05, 1.8);
      }
      // music-box arpeggio over chord tones, with a melodic passing note now and then
      if (Math.random() < (s % 2 === 0 ? 0.6 : 0.25)) {
        let n: number;
        if (Math.random() < 0.65) n = chord[Math.floor(Math.random() * 3)] + 12;
        else { mi = walk(mi, scale.length - 1); n = scale[mi]; n += 12; }
        bell(ctx, out, t, mtof(key + n + 12), rnd(0.035, 0.06), 1.1, [[1, 1], [2, 0.25], [4.02, 0.12]]);
      }
    },
    dispose: () => pad.dispose(),
  };
};

// ---------------------------------------------------------------- Alps: slow major, alphorn + bell
const alps: Factory = (ctx, out) => {
  const key = 53; // F3
  const pad = new Pad(ctx, out, 3, { type: 'sawtooth', cutoff: 800, level: 0.1, detune: 6, glide: 1.1 });
  const chords = [[0, 4, 7], [5, 9, 12], [0, 4, 7], [7, 11, 14]];
  // alphorn partials above the F fundamental (semitones): 4,5,6,8,9,10,11(lydian #4),12
  const horns = [24, 28, 31, 36, 38, 40, 42, 43];
  let hi = 3;
  let nextHorn = 0;
  return {
    stepDur: bpmToStep(60), stepsPerBar: 8,
    step(t, s, bar) {
      if (s === 0) {
        const ch = chords[(bar >> 1) % 4];
        if (bar % 2 === 0) pad.setChord(t, ch.map((n) => key + n - 12));
        if (bar % 2 === 0 || Math.random() < 0.3) {
          // soft bell strike on chord fifth/octave
          bell(ctx, out, t, mtof(key + ch[Math.random() < 0.5 ? 2 : 0] + 24), 0.05, 3.2,
            [[1, 1], [2.4, 0.3], [4.1, 0.15], [6.6, 0.06]]);
        }
      }
      if (t >= nextHorn && s % 4 === 0 && Math.random() < 0.55) {
        hi = walk(hi, horns.length - 1, 2);
        const dur = rnd(2.2, 4.5);
        horn(ctx, out, t, mtof(key - 24 + horns[hi]), 0.09, dur);
        nextHorn = t + dur + rnd(0.5, 3);
      }
    },
    dispose: () => pad.dispose(),
  };
};

// ---------------------------------------------------------------- US: jazzy 7ths, e-piano, walking bass
const us: Factory = (ctx, out, hub) => {
  type Q = 'maj7' | 'm7' | '7';
  const iv: Record<Q, number[]> = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10] };
  const C = 0;
  const progs: [number, Q][][] = [
    [[C + 2, 'm7'], [C + 7, '7'], [C, 'maj7'], [C + 9, 'm7']],
    [[C, 'maj7'], [C + 9, 'm7'], [C + 2, 'm7'], [C + 7, '7']],
    [[C + 4, 'm7'], [C + 9, '7'], [C + 2, 'm7'], [C + 7, '7']],
    [[C + 5, 'maj7'], [C + 4, 'm7'], [C + 2, 'm7'], [C + 7, '7']],
  ];
  let prog = pick(progs);
  // close voicing kept inside G3..F#4 so chords stay warm and compact
  const voicing = (r: number, q: Q): number[] =>
    iv[q].map((n) => 55 + ((((r + n) % 12) - (55 % 12) + 12) % 12));
  const swing = 0.3; // fraction of a step that off-beats are delayed
  return {
    stepDur: bpmToStep(76), stepsPerBar: 8,
    step(t0, s, bar) {
      const t = s % 2 === 1 ? t0 + swing * bpmToStep(76) : t0; // lazy swing on off-beats
      const [r, q] = prog[bar % 4];
      const [nr] = prog[(bar + 1) % 4];
      if (s === 0 && bar % 4 === 0) prog = pick(progs);
      const chord = voicing(r, q);
      // comping: chord on 1 and sometimes the "and" of 2
      if (s === 0 || (s === 3 && Math.random() < 0.55) || (s === 6 && Math.random() < 0.25)) {
        chord.forEach((n, i) => epiano(ctx, out, t + i * 0.018, mtof(n), s === 0 ? 0.07 : 0.045, 1.7));
      }
      // occasional melody note (chord tone or 9th), an octave up
      if (s % 2 === 0 && Math.random() < 0.3) {
        const ext = [...chord, chord[0] + 2];
        epiano(ctx, out, t, mtof(pick(ext) + 12), rnd(0.05, 0.08), 1.3);
      }
      // walking bass on every beat
      if (s % 2 === 0) {
        const beat = s / 2;
        const base = 36 + ((r % 12) + 12) % 12;
        let n: number;
        if (beat === 0) n = base;
        else if (beat === 1) n = base + iv[q][Math.random() < 0.5 ? 1 : 2];
        else if (beat === 2) n = base + iv[q][2];
        else n = 36 + ((nr % 12) + 12) % 12 + pick([-1, 1]); // chromatic approach to next root
        bass(ctx, out, t, mtof(n), 0.2, 0.55);
      }
      // brush tick on 2 and 4
      if (s === 2 || s === 6) {
        const src = ctx.createBufferSource();
        const hp = ctx.createBiquadFilter();
        const g = ctx.createGain();
        src.buffer = hub.buffers.white;
        hp.type = 'highpass'; hp.frequency.value = 5000;
        g.gain.setValueAtTime(0.025, t);
        g.gain.setTargetAtTime(0, t, 0.03);
        src.connect(hp).connect(g).connect(out);
        src.start(t, Math.random() * 2, 0.25);
      }
    },
    dispose: () => { /* nothing persistent */ },
  };
};

// ---------------------------------------------------------------- Other: ambient pad + sparse bells
const other: Factory = (ctx, out) => {
  const key = pick([57, 55, 60]);
  const chords = [[0, 7, 11, 14], [5, 9, 12, 16], [2, 7, 12, 14], [9, 12, 16, 19], [0, 4, 7, 14]];
  const pent = [0, 2, 4, 7, 9, 12, 14, 16];
  const pad = new Pad(ctx, out, 4, { type: 'sawtooth', cutoff: 700, level: 0.13, detune: 10, glide: 1.4 });
  return {
    stepDur: bpmToStep(60), stepsPerBar: 8,
    step(t, s, bar) {
      if (s === 0 && bar % 4 === 0) pad.setChord(t, pick(chords).map((n) => key + n - 12));
      if (Math.random() < (s % 2 === 0 ? 0.14 : 0.05)) {
        bell(ctx, out, t, mtof(key + 12 + pick(pent)), rnd(0.025, 0.05), 3, [[1, 1], [3, 0.12], [5.04, 0.05]]);
      }
    },
    dispose: () => pad.dispose(),
  };
};

const FACTORIES: Record<Region, Factory> = { jp, eu, alps, us, other };

interface Session {
  region: Region;
  gain: GainNode;
  voice: Voice;
  next: number;
  index: number;
}

export class MusicEngine {
  private cur: Session | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private regionNow: Region | null = null;

  constructor(private ctx: AudioContext, private out: AudioNode, private hub: NoiseHub) {}

  setRegion(r: Region | null): void {
    if (r === this.regionNow) return;
    this.regionNow = r;
    const ctx = this.ctx;
    const old = this.cur;
    this.cur = null;
    if (old) { // fade the old session out, then free it
      old.gain.gain.cancelScheduledValues(ctx.currentTime);
      old.gain.gain.setTargetAtTime(0, ctx.currentTime, 1.2);
      setTimeout(() => { old.voice.dispose(); old.gain.disconnect(); }, 7000);
    }
    if (!r) { this.stopTimer(); return; }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, ctx.currentTime + 0.2, 1.5);
    gain.connect(this.out);
    const voice = FACTORIES[r](ctx, gain, this.hub);
    this.cur = { region: r, gain, voice, next: ctx.currentTime + 0.4, index: 0 };
    if (!this.timer) this.timer = setInterval(() => this.tick(), 25);
  }

  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Lookahead scheduler: schedule every step that falls within the next 150 ms. */
  private tick(): void {
    const s = this.cur;
    if (!s) return;
    const now = this.ctx.currentTime;
    if (s.next < now - 0.25) s.next = now + 0.05; // tab was throttled: skip instead of burst
    while (s.next < now + 0.15) {
      const v = s.voice;
      v.step(s.next, s.index % v.stepsPerBar, Math.floor(s.index / v.stepsPerBar));
      s.next += v.stepDur;
      s.index++;
    }
  }
}
