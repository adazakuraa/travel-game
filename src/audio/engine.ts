// Engine sound synthesis: combustion car and turbofan airliner.
// All nodes are built once (lazily per vehicle kind); update() only touches AudioParams.
import type { EngineSoundState } from '../types';
import type { NoiseHub } from './noise';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

interface Graph {
  out: GainNode; // kind level (faded in/out)
  update(s: EngineSoundState, t: number): void;
}

export class EngineSynth {
  private car: Graph | null = null;
  private plane: Graph | null = null;
  private readonly input: GainNode;
  private readonly cabin: BiquadFilterNode;
  private readonly cabinGain: GainNode;
  private lastKind: EngineSoundState['kind'] = 'none';

  constructor(private ctx: AudioContext, out: AudioNode, private noise: NoiseHub) {
    this.input = ctx.createGain();
    this.cabin = ctx.createBiquadFilter(); // interior muffling
    this.cabin.type = 'lowpass';
    this.cabin.frequency.value = 20000;
    this.cabinGain = ctx.createGain();
    this.input.connect(this.cabin).connect(this.cabinGain).connect(out);
  }

  update(s: EngineSoundState): void {
    const t = this.ctx.currentTime;
    if (s.kind === 'car' && !this.car) this.car = this.buildCar();
    if (s.kind === 'plane' && !this.plane) this.plane = this.buildPlane();
    this.lastKind = s.kind;
    this.car?.out.gain.setTargetAtTime(s.kind === 'car' ? 1 : 0, t, s.kind === 'car' ? 0.25 : 0.4);
    this.plane?.out.gain.setTargetAtTime(s.kind === 'plane' ? 1 : 0, t, s.kind === 'plane' ? 0.5 : 0.5);
    if (s.kind === 'car') this.car!.update(s, t);
    else if (s.kind === 'plane') this.plane!.update(s, t);
    this.cabin.frequency.setTargetAtTime(s.interior ? 900 : 20000, t, 0.15);
    this.cabinGain.gain.setTargetAtTime(s.interior ? 0.5 : 1, t, 0.15); // -6 dB
  }

  get kind(): EngineSoundState['kind'] { return this.lastKind; }

  // ---------------------------------------------------------------- car
  private buildCar(): Graph {
    const { ctx, noise } = this;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.input);

    // Engine body: harmonics of the firing frequency -> shared lowpass
    const body = ctx.createGain(); // AM "lope" gets applied here
    body.gain.value = 0.75;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.4;
    lp.frequency.value = 500;
    const engineLevel = ctx.createGain();
    engineLevel.gain.value = 0.2;
    body.connect(lp).connect(engineLevel).connect(out);

    const lfo = ctx.createOscillator(); // slow wobble of pitch (roughness)
    const lfoG = ctx.createGain();
    lfo.frequency.value = 5.5;
    lfoG.gain.value = 9; // cents
    lfo.connect(lfoG);
    lfo.start();

    const defs: [OscillatorType, number, number][] = [
      ['triangle', 0.5, 0.45], // sub
      ['sawtooth', 1, 0.5],
      ['square', 2, 0.22],
      ['sawtooth', 3, 0.16],
      ['sawtooth', 4, 0.09],
    ];
    const oscs = defs.map(([type, mult, amp]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = 30;
      g.gain.value = amp;
      lfoG.connect(o.detune);
      o.connect(g).connect(body);
      o.start();
      return { o, mult };
    });

    // Firing pulse: amplitude modulation at ~half firing rate gives the idle "lope"
    const am = ctx.createOscillator();
    const amG = ctx.createGain();
    am.frequency.value = 13;
    amG.gain.value = 0.25;
    am.connect(amG).connect(body.gain);
    am.start();

    // Intake / exhaust hiss following the firing frequency
    const hissBp = ctx.createBiquadFilter();
    hissBp.type = 'bandpass';
    hissBp.Q.value = 0.8;
    const hissG = ctx.createGain();
    hissG.gain.value = 0.1;
    noise.pink.connect(hissBp).connect(hissG).connect(lp);

    // Tyre / road noise
    const roadBp = ctx.createBiquadFilter();
    roadBp.type = 'bandpass';
    roadBp.frequency.value = 650;
    roadBp.Q.value = 0.7;
    const roadG = ctx.createGain();
    roadG.gain.value = 0;
    noise.pink.connect(roadBp).connect(roadG).connect(out);

    // Wind at speed
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 1600;
    windBp.Q.value = 0.35;
    const windG = ctx.createGain();
    windG.gain.value = 0;
    noise.white.connect(windBp).connect(windG).connect(out);

    return {
      out,
      update: (s, t) => {
        const rpm = clamp01(s.rpm), thr = clamp01(s.throttle);
        const rpmReal = 800 + rpm * 5200;
        const f = (rpmReal / 60) * 2; // 4-cylinder, 4-stroke firing frequency
        const jit = 1 + (Math.random() - 0.5) * 0.008; // slight random jitter
        for (const { o, mult } of oscs) o.frequency.setTargetAtTime(f * mult * jit, t, 0.05);
        am.frequency.setTargetAtTime(f * 0.5, t, 0.05);
        amG.gain.setTargetAtTime(0.28 - 0.2 * rpm, t, 0.1);
        lp.frequency.setTargetAtTime(380 + thr * 1900 + rpm * 900, t, 0.08);
        engineLevel.gain.setTargetAtTime(0.17 + 0.16 * thr + 0.06 * rpm, t, 0.08);
        hissBp.frequency.setTargetAtTime(f * 5 + 250, t, 0.1);
        hissG.gain.setTargetAtTime(0.06 + 0.2 * thr, t, 0.1);
        const v = Math.max(0, s.speed);
        const road = Math.pow(clamp01(v / 30), 1.1);
        roadG.gain.setTargetAtTime(road * 0.2, t, 0.15);
        roadBp.frequency.setTargetAtTime(450 + road * 700, t, 0.2);
        windG.gain.setTargetAtTime(Math.pow(clamp01(v / 50), 2) * 0.3, t, 0.2);
        windBp.frequency.setTargetAtTime(1000 + clamp01(v / 60) * 1500, t, 0.2);
      },
    };
  }

  // ---------------------------------------------------------------- plane
  private buildPlane(): Graph {
    const { ctx, noise } = this;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.input);

    // Turbine whine: two quiet high partials that follow N1
    const whineG = ctx.createGain();
    whineG.gain.value = 0.01;
    whineG.connect(out);
    const w1 = ctx.createOscillator();
    const w2 = ctx.createOscillator();
    const w2g = ctx.createGain();
    w1.type = 'sine';
    w2.type = 'triangle';
    w1.frequency.value = 2000;
    w2.frequency.value = 2600;
    w2g.gain.value = 0.5;
    w1.connect(whineG);
    w2.connect(w2g).connect(whineG);
    w1.start(); w2.start();

    // Broadband roar (low-passed pink) + low rumble (brown)
    const roarLp = ctx.createBiquadFilter();
    roarLp.type = 'lowpass';
    roarLp.frequency.value = 400;
    roarLp.Q.value = 0.5;
    const roarG = ctx.createGain();
    roarG.gain.value = 0.1;
    noise.pink.connect(roarLp).connect(roarG).connect(out);
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 160;
    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0.2;
    noise.brown.connect(rumbleLp).connect(rumbleG).connect(out);

    // Wind rush with airspeed
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 1200;
    windBp.Q.value = 0.4;
    const windG = ctx.createGain();
    windG.gain.value = 0;
    noise.white.connect(windBp).connect(windG).connect(out);

    return {
      out,
      update: (s, t) => {
        const rpm = clamp01(s.rpm), thr = clamp01(s.throttle);
        const base = 2000 + rpm * 3000; // 2..5 kHz
        w1.frequency.setTargetAtTime(base, t, 0.15);
        w2.frequency.setTargetAtTime(base * 1.25, t, 0.15);
        whineG.gain.setTargetAtTime(0.004 + 0.016 * rpm * rpm, t, 0.2);
        roarLp.frequency.setTargetAtTime(220 + thr * 1500 + rpm * 500, t, 0.2);
        roarG.gain.setTargetAtTime(0.1 + 0.4 * thr * (0.4 + 0.6 * rpm), t, 0.2);
        rumbleG.gain.setTargetAtTime(0.1 + 0.3 * thr, t, 0.25);
        const v = clamp01(Math.max(0, s.speed) / 220);
        windG.gain.setTargetAtTime(Math.pow(v, 1.5) * 0.3, t, 0.3);
        windBp.frequency.setTargetAtTime(700 + v * 1800, t, 0.3);
      },
    };
  }
}
