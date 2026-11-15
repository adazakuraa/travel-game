// Layered environmental ambience built from shared noise sources, plus procedural birds/crickets.
import type { AmbientProfile } from '../types';
import { loopSource, type NoiseHub } from './noise';
import { rnd, pick } from './synth';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Looping envelope buffer used to amplitude-modulate a tone (cricket pulses) or noise (rain crackle). */
function envBuffer(ctx: BaseAudioContext, seconds: number, fill: (d: Float32Array, sr: number) => void): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  fill(b.getChannelData(0), ctx.sampleRate);
  return b;
}

export class Ambient {
  private p: AmbientProfile | null = null;
  private layers: Record<'urban' | 'traffic' | 'wind' | 'rain' | 'crackle' | 'water' | 'cricket', GainNode>;
  private windBp: BiquadFilterNode;
  private waterLp: BiquadFilterNode;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected timer: ReturnType<typeof setInterval>;
  private nextBird = 0;

  constructor(private ctx: AudioContext, private out: AudioNode, noise: NoiseHub) {
    const g = (): GainNode => { const n = ctx.createGain(); n.gain.value = 0; n.connect(out); return n; };
    this.layers = { urban: g(), traffic: g(), wind: g(), rain: g(), crackle: g(), water: g(), cricket: g() };
    const filt = (type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode => {
      const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b;
    };
    const lfo = (rate: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator(); const d = ctx.createGain();
      o.frequency.value = rate; d.gain.value = depth;
      o.connect(d).connect(target); o.start();
    };

    // multiplicative slow swell (gain 1 +/- depth), so a layer at zero level stays silent
    const swell = (rate: number, depth: number): GainNode => {
      const m = ctx.createGain(); m.gain.value = 1 - depth;
      lfo(rate, depth, m.gain);
      return m;
    };

    // urban hum: low brown rumble + faint mid band
    noise.brown.connect(filt('lowpass', 380)).connect(this.layers.urban);
    // distant traffic: band-limited pink with slow swells
    noise.pink.connect(filt('bandpass', 260, 0.6)).connect(swell(0.07, 0.15)).connect(this.layers.traffic);

    // wind: bandpassed pink whose centre frequency meanders (gusts)
    this.windBp = filt('bandpass', 450, 0.5);
    noise.pink.connect(this.windBp).connect(swell(0.05, 0.25)).connect(this.layers.wind);
    lfo(0.13, 160, this.windBp.frequency);

    // rain: dense hiss + sparse crackle (droplet clicks)
    noise.white.connect(filt('highpass', 1200)).connect(filt('lowpass', 9000, 0.5)).connect(this.layers.rain);
    const crackleBuf = envBuffer(ctx, 3, (d, sr) => {
      let e = 0;
      for (let i = 0; i < d.length; i++) {
        if (Math.random() < 40 / sr) e = Math.random();
        e *= 0.9985;
        d[i] = e;
      }
    });
    const crackleAm = ctx.createGain();
    crackleAm.gain.value = 0;
    noise.white.connect(filt('bandpass', 4200, 1.2)).connect(crackleAm).connect(this.layers.crackle);
    loopSource(ctx, crackleBuf).connect(crackleAm.gain);

    // water: swells of filtered noise, two incommensurate slow LFOs
    this.waterLp = filt('lowpass', 700, 0.6);
    noise.pink.connect(this.waterLp).connect(swell(0.083, 0.45)).connect(this.layers.water);
    lfo(0.11, 350, this.waterLp.frequency);

    // crickets: two detuned tones, pulsed by a chirp-train envelope
    const pulse = envBuffer(ctx, 0.5, (d, sr) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const ph = (t % 0.0625) / 0.0625; // 16 Hz pulses
        d[i] = t < 0.3 ? Math.sin(Math.PI * ph) * (0.6 + 0.4 * Math.min(1, t / 0.1)) : 0;
      }
    });
    for (const [f, rate] of [[4300, 1], [5050, 0.93]] as const) {
      const o = ctx.createOscillator(); const am = ctx.createGain();
      o.frequency.value = f; am.gain.value = 0;
      o.connect(am).connect(this.layers.cricket);
      o.start();
      loopSource(ctx, pulse, rate).connect(am.gain);
    }

    this.timer = setInterval(() => this.tick(), 300);
  }

  set(p: AmbientProfile): void {
    this.p = p;
    const t = this.ctx.currentTime;
    const L = this.layers;
    // ground ambience fades between 50 m and 300 m AGL; wind survives aloft
    const g = clamp01(1 - (p.altitude - 50) / 250);
    const tc = 0.9;
    const set = (n: GainNode, v: number): void => {
      n.gain.setTargetAtTime(v, t, tc);
    };
    set(L.urban, clamp01(p.urban) * 0.28 * g);
    set(L.traffic, clamp01(p.urban) * 0.22 * g);
    set(L.wind, (clamp01(p.wind) * 0.5 + clamp01(p.nature) * 0.06 * g) * (0.35 + 0.65 * g) + (g < 1 ? 0.05 * (1 - g) : 0));
    set(L.rain, clamp01(p.rain) * 0.3 * Math.max(g, 0.15));
    set(L.crackle, clamp01(p.rain) * 0.5 * Math.max(g, 0.15));
    set(L.water, clamp01(p.water) * 0.4 * g);
    const crickets = p.night && p.nature > 0.3 && (p.region === 'jp' || p.region === 'other') && p.rain < 0.5;
    set(L.cricket, crickets ? 0.035 * clamp01(p.nature) * g : 0);
  }

  /** Birds are discrete events, scheduled from a slow timer. */
  private tick(): void {
    const p = this.p;
    if (!p || p.night || p.nature < 0.1 || p.rain > 0.6 || this.ctx.state !== 'running') return;
    const g = clamp01(1 - (p.altitude - 30) / 200);
    if (g <= 0.05) return;
    const now = this.ctx.currentTime;
    if (now < this.nextBird) return;
    // busier with more nature; typical gap 2-12 s
    this.nextBird = now + rnd(2, 12) / (0.3 + clamp01(p.nature)) + 0.3;
    this.phrase(now + 0.05, 0.05 * clamp01(p.nature) * g * (1 - p.wind * 0.5));
  }

  private phrase(t: number, vol: number): void {
    const type = pick(['rise', 'fall', 'trill', 'twitter'] as const);
    const base = rnd(2200, 4200);
    const n = type === 'twitter' ? Math.floor(rnd(4, 8)) : Math.floor(rnd(2, 5));
    const pan = this.ctx.createStereoPanner?.();
    let dest: AudioNode = this.out;
    if (pan) { pan.pan.value = rnd(-0.8, 0.8); pan.connect(this.out); dest = pan; }
    let tt = t;
    for (let i = 0; i < n; i++) {
      const dur = type === 'twitter' ? rnd(0.04, 0.07) : rnd(0.07, 0.18);
      const f0 = type === 'fall' ? base * rnd(1.2, 1.5) : base * rnd(0.85, 1.05);
      const f1 = type === 'rise' ? f0 * rnd(1.3, 1.7) : type === 'fall' ? f0 * rnd(0.6, 0.8) : f0 * rnd(0.9, 1.2);
      this.chirp(dest, tt, f0, f1, dur, vol * rnd(0.7, 1), type === 'trill' ? rnd(35, 60) : rnd(0, 18));
      tt += dur + (type === 'twitter' ? 0.03 : rnd(0.05, 0.14));
    }
    if (pan) setTimeout(() => pan.disconnect(), (tt - this.ctx.currentTime + 0.5) * 1000);
  }

  /** One FM-sine sweep. */
  private chirp(dest: AudioNode, t: number, f0: number, f1: number, dur: number, vol: number, modHz: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(500, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    if (modHz > 0) {
      const m = ctx.createOscillator(); const mg = ctx.createGain();
      m.frequency.value = modHz; mg.gain.value = f0 * 0.08;
      m.connect(mg).connect(o.frequency);
      m.start(t); m.stop(t + dur + 0.02);
    }
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.02);
  }
}
