// Small instrument voices used by music and sfx. Each call creates a few short-lived nodes
// that stop themselves and get garbage collected.

export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Inharmonic bell / music-box tone: sum of decaying sine partials. */
export function bell(
  ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, vol: number,
  decay = 1.5, partials: readonly (readonly [number, number])[] = [[1, 1], [2.76, 0.35], [5.4, 0.12]],
): void {
  const end = t + decay * 1.6 + 0.1;
  for (const [ratio, amp] of partials) {
    if (freq * ratio > 12000) continue;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq * ratio;
    const d = decay / (1 + (ratio - 1) * 0.5); // upper partials die faster
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol * amp, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, d / 3);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(end);
  }
}

/** Soft FM electric piano (tine-ish). */
export function epiano(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, vol: number, dur = 1.6): void {
  const car = ctx.createOscillator();
  const mod = ctx.createOscillator();
  const mg = ctx.createGain();
  const g = ctx.createGain();
  car.frequency.value = freq;
  mod.frequency.value = freq * 1.001;
  mg.gain.setValueAtTime(freq * 1.1, t);
  mg.gain.setTargetAtTime(freq * 0.08, t, 0.25); // bright attack, mellow body
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.006);
  g.gain.setTargetAtTime(0, t + 0.01, dur / 4);
  mod.connect(mg).connect(car.frequency);
  car.connect(g).connect(out);
  car.start(t); mod.start(t);
  car.stop(t + dur * 1.5); mod.stop(t + dur * 1.5);
}

/** Soft sustained horn (alphorn-ish): detuned saws through an opening lowpass. */
export function horn(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, vol: number, dur: number): void {
  const lp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  lp.frequency.setValueAtTime(220, t);
  lp.frequency.setTargetAtTime(750, t, 0.35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.35);
  g.gain.setValueAtTime(vol, t + dur);
  g.gain.setTargetAtTime(0, t + dur, 0.35);
  for (const cents of [-6, 6]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    o.detune.value = cents;
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 2);
  }
  lp.connect(g).connect(out);
}

/** Plucked bass (upright-ish): triangle + lowpass, fast decay. */
export function bass(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, vol: number, dur = 0.7): void {
  const o = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.value = freq;
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.setTargetAtTime(250, t, 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.012);
  g.gain.setTargetAtTime(0, t + 0.03, dur / 3);
  o.connect(lp).connect(g).connect(out);
  o.start(t);
  o.stop(t + dur * 2);
}

// ---- Karplus-Strong pluck (koto-like), rendered once per pitch and cached ----
const ksCache = new Map<string, AudioBuffer>();
const KS_LEN = 3.4; // seconds

function ksBuffer(ctx: BaseAudioContext, freq: number, decay: number): { buf: AudioBuffer; actual: number } {
  const sr = ctx.sampleRate;
  const period = Math.max(2, Math.round(sr / freq - 0.5));
  const actual = sr / (period + 0.5); // pitch of the raw loop; corrected with playbackRate
  const key = `${sr}|${period}|${decay}`;
  let buf = ksCache.get(key);
  if (!buf) {
    if (ksCache.size > 48) ksCache.clear();
    const len = Math.floor(sr * KS_LEN);
    buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const ring = new Float32Array(period);
    let prev = 0;
    for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
    // pre-soften the excitation so the pluck is round rather than harsh
    for (let i = 0; i < period; i++) ring[i] = (ring[i] + ring[(i + 1) % period]) * 0.5;
    for (let i = 0, j = 0; i < len; i++, j = (j + 1) % period) {
      const cur = ring[j];
      const y = decay * 0.5 * (cur + prev);
      prev = cur;
      ring[j] = y;
      d[i] = y;
    }
    let peak = 0;
    for (let i = 0; i < period * 4 && i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    const k = peak > 0 ? 0.9 / peak : 1;
    for (let i = 0; i < len; i++) d[i] *= k;
    ksCache.set(key, buf);
  }
  return { buf, actual };
}

export function pluck(
  ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, vol: number,
  opts: { decay?: number; cutoff?: number; len?: number } = {},
): void {
  const { buf, actual } = ksBuffer(ctx, freq, opts.decay ?? 0.9965);
  const len = opts.len ?? 2.6;
  const src = ctx.createBufferSource();
  const lp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  src.buffer = buf;
  src.playbackRate.value = freq / actual;
  lp.type = 'lowpass';
  lp.frequency.value = opts.cutoff ?? 3500;
  g.gain.setValueAtTime(vol, t);
  g.gain.setTargetAtTime(0, t + len * 0.5, len / 6);
  src.connect(lp).connect(g).connect(out);
  src.start(t);
  src.stop(t + len);
}

/**
 * Persistent pad: a few voices of detuned oscillators through one lowpass. Chord changes glide
 * (portamento) instead of re-creating nodes, so the node count is constant.
 */
export class Pad {
  private voices: { f: OscillatorNode[] }[] = [];
  private all: AudioNode[] = [];
  readonly out: GainNode;
  constructor(
    private ctx: AudioContext, dest: AudioNode, count: number,
    o: { type: OscillatorType; cutoff: number; level: number; detune?: number; glide?: number },
  ) {
    this.glide = o.glide ?? 0.5;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.cutoff;
    lp.Q.value = 0.4;
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 0.23;
    lfoG.gain.value = 5; // gentle vibrato/chorus in cents
    lfo.connect(lfoG);
    lfo.start();
    this.all.push(lp, lfo, lfoG, this.out);
    const vg = ctx.createGain();
    vg.gain.value = o.level / Math.sqrt(count);
    for (let i = 0; i < count; i++) {
      const oscs: OscillatorNode[] = [];
      for (const s of [-1, 1]) {
        const osc = ctx.createOscillator();
        osc.type = o.type;
        osc.frequency.value = 220;
        osc.detune.value = s * (o.detune ?? 7);
        lfoG.connect(osc.detune);
        osc.connect(vg);
        osc.start();
        oscs.push(osc);
        this.all.push(osc);
      }
      this.voices.push({ f: oscs });
    }
    vg.connect(lp).connect(this.out).connect(dest);
    this.all.push(vg);
    this.out.gain.setTargetAtTime(1, ctx.currentTime, 2.5);
  }
  private glide: number;
  setChord(t: number, midi: readonly number[]): void {
    this.voices.forEach((v, i) => {
      const n = midi[i % midi.length] + (i >= midi.length ? 12 * Math.floor(i / midi.length) * (i % 2 ? 1 : -1) : 0);
      for (const o of v.f) o.frequency.setTargetAtTime(mtof(n), t, this.glide);
    });
  }
  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.4);
    setTimeout(() => {
      for (const n of this.all) {
        try { if (n instanceof OscillatorNode) n.stop(); n.disconnect(); } catch { /* ignore */ }
      }
    }, 3000);
  }
}
