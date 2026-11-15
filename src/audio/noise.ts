// Generated noise buffers shared by every audio layer (no audio files are ever loaded).

export type NoiseKind = 'white' | 'pink' | 'brown';

/** Build a seamlessly loopable mono noise buffer (equal-power crossfaded seam). */
export function makeNoiseBuffer(ctx: BaseAudioContext, kind: NoiseKind, seconds = 4): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.08);
  const raw = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') raw[i] = w;
    else if (kind === 'pink') {
      // Paul Kellet's economy pink filter
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last * 3.5;
    }
  }
  // normalise peak, then fold the extra tail into the head so loop end -> start is continuous
  let peak = 0;
  for (let i = 0; i < raw.length; i++) peak = Math.max(peak, Math.abs(raw[i]));
  const k = peak > 0 ? 0.8 / peak : 1;
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    if (i < fade) {
      const t = i / fade;
      d[i] = (raw[n + i] * Math.cos(t * Math.PI / 2) + raw[i] * Math.sin(t * Math.PI / 2)) * k;
    } else d[i] = raw[i] * k;
  }
  return buf;
}

/** Looping buffer source helper. */
export function loopSource(ctx: BaseAudioContext, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(0, Math.random() * buf.duration);
  return s;
}

/** Three always-running noise sources, fanned out to all consumers (keeps node count low). */
export interface NoiseHub {
  white: GainNode;
  pink: GainNode;
  brown: GainNode;
  buffers: Record<NoiseKind, AudioBuffer>;
}

export function createNoiseHub(ctx: BaseAudioContext): NoiseHub {
  const buffers = {
    white: makeNoiseBuffer(ctx, 'white', 3),
    pink: makeNoiseBuffer(ctx, 'pink', 4),
    brown: makeNoiseBuffer(ctx, 'brown', 4),
  };
  const mk = (kind: NoiseKind): GainNode => {
    const g = ctx.createGain();
    loopSource(ctx, buffers[kind]).connect(g);
    return g;
  };
  return { white: mk('white'), pink: mk('pink'), brown: mk('brown'), buffers };
}

/** Smooth an AudioParam toward a value (cheap, no node creation). */
export function ramp(p: AudioParam, v: number, ctx: BaseAudioContext, tc = 0.1): void {
  p.setTargetAtTime(v, ctx.currentTime, tc);
}
