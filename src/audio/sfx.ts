// One-shot sound effects (all synthesised).
import type { NoiseHub } from './noise';
import { bell } from './synth';

export type SfxName = 'click' | 'chime' | 'horn' | 'teleport';

export function playSfx(ctx: AudioContext, out: AudioNode, hub: NoiseHub, name: SfxName): void {
  const t = ctx.currentTime + 0.01;
  switch (name) {
    case 'click': { // short tick
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1500, t);
      o.frequency.exponentialRampToValueAtTime(700, t + 0.03);
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.045);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.06);
      break;
    }
    case 'chime': { // two-note bell, rising fourth+
      bell(ctx, out, t, 880, 0.22, 1.3, [[1, 1], [2, 0.3], [2.76, 0.2], [5.4, 0.08]]);
      bell(ctx, out, t + 0.16, 1318.5, 0.22, 1.8, [[1, 1], [2, 0.3], [2.76, 0.2], [5.4, 0.08]]);
      break;
    }
    case 'horn': { // two detuned squares, 0.4 s
      const lp = ctx.createBiquadFilter();
      const g = ctx.createGain();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.02);
      g.gain.setValueAtTime(0.16, t + 0.34);
      g.gain.linearRampToValueAtTime(0.0001, t + 0.4);
      for (const f of [420, 500]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        o.detune.value = (Math.random() - 0.5) * 16;
        o.connect(lp);
        o.start(t); o.stop(t + 0.42);
      }
      lp.connect(g).connect(out);
      break;
    }
    case 'teleport': { // swept band-pass whoosh
      const src = ctx.createBufferSource();
      const bp = ctx.createBiquadFilter();
      const g = ctx.createGain();
      src.buffer = hub.buffers.white;
      src.loop = true;
      bp.type = 'bandpass';
      bp.Q.value = 3.5;
      bp.frequency.setValueAtTime(250, t);
      bp.frequency.exponentialRampToValueAtTime(5000, t + 0.45);
      bp.frequency.exponentialRampToValueAtTime(500, t + 1.0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.35);
      g.gain.setTargetAtTime(0, t + 0.45, 0.15);
      src.connect(bp).connect(g).connect(out);
      src.start(t, Math.random() * 2);
      src.stop(t + 1.2);
      break;
    }
  }
}
