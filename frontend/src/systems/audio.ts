import type { Settings } from '../store';

/**
 * Procedural office audio (Web Audio API). Every sound is synthesised at runtime — there are no
 * sample files, so there are no licensing concerns. The context is only created after an explicit
 * user gesture (the "Enable sound" control), honouring browser autoplay rules. Volumes start low.
 */
type Bus = 'ambient' | 'character' | 'notification';

class AudioEngine {
  ctx?: AudioContext;
  private master?: GainNode;
  private buses = new Map<Bus, GainNode>();
  private noise?: AudioBuffer;
  private hum?: AudioBufferSourceNode;
  private cooldowns = new Map<string, number>();

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture. */
  async enable() {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
      for (const b of ['ambient', 'character', 'notification'] as Bus[]) {
        const g = this.ctx.createGain();
        g.connect(this.master);
        this.buses.set(b, g);
      }
      this.noise = this.makeNoise();
      this.startHum();
    }
    await this.ctx.resume();
  }

  disable() {
    void this.ctx?.suspend();
  }

  apply(a: Settings['audio']) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.muted || !a.enabled ? 0 : a.master * 0.8, t, 0.08);
    this.buses.get('ambient')!.gain.setTargetAtTime(a.ambient, t, 0.1);
    this.buses.get('character')!.gain.setTargetAtTime(a.character, t, 0.1);
    this.buses.get('notification')!.gain.setTargetAtTime(a.notification, t, 0.1);
  }

  private makeNoise() {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startHum() {
    // Air conditioning: brown-ish noise through a low-pass, very quiet, looping.
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(lp).connect(g).connect(this.buses.get('ambient')!);
    src.start();
    this.hum = src;
  }

  private cool(key: string, ms: number) {
    const now = performance.now();
    if ((this.cooldowns.get(key) ?? 0) > now) return false;
    this.cooldowns.set(key, now + ms);
    return true;
  }

  private out(bus: Bus, pan: number, gain: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.buses.get(bus)!);
    return g;
  }

  private burst(
    bus: Bus,
    opts: {
      pan: number;
      gain: number;
      freq: number;
      q: number;
      dur: number;
      type?: BiquadFilterType;
      at?: number;
    },
  ) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    src
      .connect(f)
      .connect(env)
      .connect(this.out(bus, opts.pan, opts.gain));
    src.start(t, Math.random() * 1.5, opts.dur + 0.05);
  }

  private tone(
    bus: Bus,
    opts: {
      pan: number;
      gain: number;
      freq: number;
      to?: number;
      dur: number;
      type?: OscillatorType;
      at?: number;
    },
  ) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.at ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    o.connect(env).connect(this.out(bus, opts.pan, opts.gain));
    o.start(t);
    o.stop(t + opts.dur + 0.05);
  }

  /** A short run of key clicks. */
  typing(id: string, pan: number, vol: number) {
    if (!this.ready || !this.cool(`type:${id}`, 900 + Math.random() * 1600)) return;
    const n = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++)
      this.burst('character', {
        pan,
        gain: 0.16 * vol,
        freq: 2500 + Math.random() * 1800,
        q: 3,
        dur: 0.03,
        at: i * (0.07 + Math.random() * 0.08),
      });
    if (Math.random() < 0.15)
      this.burst('character', {
        pan,
        gain: 0.12 * vol,
        freq: 4200,
        q: 6,
        dur: 0.02,
        at: n * 0.1 + 0.1,
      });
  }
  footstep(id: string, pan: number, vol: number) {
    if (!this.ready || !this.cool(`step:${id}`, 320)) return;
    this.burst('character', {
      pan,
      gain: 0.22 * vol,
      freq: 180 + Math.random() * 80,
      q: 1.2,
      dur: 0.07,
      type: 'lowpass',
    });
  }
  chair(pan: number, vol: number) {
    if (!this.ready || !this.cool('chair', 400)) return;
    this.tone('character', {
      pan,
      gain: 0.05 * vol,
      freq: 520,
      to: 760,
      dur: 0.18,
      type: 'triangle',
    });
    this.burst('character', { pan, gain: 0.12 * vol, freq: 300, q: 2, dur: 0.12 });
  }
  coffee(pan: number, vol: number) {
    if (!this.ready || !this.cool('coffee', 6000)) return;
    for (let i = 0; i < 10; i++)
      this.burst('ambient', {
        pan,
        gain: 0.12 * vol,
        freq: 700 + Math.random() * 500,
        q: 8,
        dur: 0.12,
        at: i * 0.16,
      });
    this.burst('ambient', {
      pan,
      gain: 0.08 * vol,
      freq: 3000,
      q: 0.7,
      dur: 1.4,
      type: 'highpass',
      at: 0.2,
    });
  }
  printer(pan: number, vol: number) {
    if (!this.ready || !this.cool('printer', 8000)) return;
    for (let i = 0; i < 6; i++)
      this.tone('ambient', {
        pan,
        gain: 0.03 * vol,
        freq: 140,
        dur: 0.18,
        type: 'square',
        at: i * 0.22,
      });
  }
  murmur(pan: number, vol: number) {
    if (!this.ready || !this.cool('murmur', 700)) return;
    // Formant-ish babble: bandpassed noise with a wobbling centre frequency.
    this.burst('ambient', {
      pan,
      gain: 0.09 * vol,
      freq: 450 + Math.random() * 600,
      q: 5,
      dur: 0.25 + Math.random() * 0.3,
    });
  }
  notify(kind: 'done' | 'fail' | 'meeting' | 'info') {
    if (!this.ready || !this.cool(`notify:${kind}`, 600)) return;
    const seq = { done: [660, 880], fail: [330, 247], meeting: [523, 659, 784], info: [740] }[kind];
    seq.forEach((f, i) =>
      this.tone('notification', {
        pan: 0,
        gain: 0.12,
        freq: f,
        dur: 0.22,
        type: 'triangle',
        at: i * 0.12,
      }),
    );
  }
}

export const audio = new AudioEngine();
