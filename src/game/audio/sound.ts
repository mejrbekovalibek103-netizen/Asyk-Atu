/**
 * Звуки игры синтезируются через Web Audio API — никаких сторонних аудиофайлов
 * (нет вопросов с авторскими правами, нулевой вес загрузки).
 *
 * AudioContext создаётся лениво при первом действии пользователя (требование браузеров).
 */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private pluckCache = new Map<number, AudioBuffer>();
  private muted = false;
  private lastClackAt = 0;

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.02);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Вызывать из обработчика жеста пользователя. */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return null;
    try {
      this.ctx = new AC();
    } catch {
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 0.6);
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  private ready(): AudioContext | null {
    if (this.muted) return null;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || !this.master) return null;
    return ctx;
  }

  private noise(ctx: AudioContext, t: number, dur: number, filter: BiquadFilterType, freq: number, q: number, gain: number, freqEnd?: number) {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  private tone(ctx: AudioContext, t: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', freqEnd?: number) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Свист броска: сила влияет на громкость и высоту. */
  throw(power: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.noise(ctx, t, 0.22 + power * 0.12, 'bandpass', 600 + power * 900, 1.2, 0.18 + power * 0.25, 2400 + power * 1500);
  }

  /** Щелчок кости о кость. */
  clack(impact: number, heavy = false): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastClackAt < 18) return; // не «трещать» при цепочке касаний
    this.lastClackAt = now;
    const t = ctx.currentTime;
    const v = Math.min(1, impact / 12);
    const base = heavy ? 1500 : 2100;
    const f = base * (0.9 + Math.random() * 0.25);
    this.noise(ctx, t, 0.05, 'bandpass', f * 1.4, 6, 0.25 + v * 0.6);
    this.tone(ctx, t, f, 0.06 + v * 0.03, 0.12 + v * 0.3, 'triangle', f * 0.8);
    if (heavy) this.tone(ctx, t, 420, 0.08, 0.1 + v * 0.2, 'sine', 260);
  }

  /** Глухой удар о бордюр. */
  thud(impact: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = Math.min(1, impact / 12);
    this.tone(ctx, t, 150, 0.12, 0.15 + v * 0.35, 'sine', 70);
    this.noise(ctx, t, 0.07, 'lowpass', 900, 0.7, 0.1 + v * 0.25);
  }

  /** Асык вылетел за линию. */
  knockout(n: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 660 * Math.pow(1.12, Math.min(6, n - 1));
    this.tone(ctx, t, f, 0.14, 0.22, 'triangle', f * 1.5);
    this.tone(ctx, t + 0.07, f * 1.5, 0.18, 0.16, 'sine');
  }

  /** Начисление бонуса (комбо/серия). */
  bonus(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    [784, 988, 1175].forEach((f, i) => this.tone(ctx, t + i * 0.07, f, 0.2, 0.16, 'triangle'));
  }

  /** Промах. */
  miss(): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.tone(ctx, ctx.currentTime, 320, 0.25, 0.12, 'sine', 200);
  }

  uiClick(): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.tone(ctx, ctx.currentTime, 900, 0.05, 0.08, 'triangle', 700);
  }

  /** Тик в последние секунды испытания со временем. */
  timeTick(): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.tone(ctx, ctx.currentTime, 1040, 0.06, 0.07, 'square');
  }

  /** Время вышло: два нисходящих сигнала. */
  timeUp(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, t, 520, 0.18, 0.12, 'triangle', 440);
    this.tone(ctx, t + 0.2, 390, 0.3, 0.12, 'triangle', 300);
  }

  /**
   * Щипок струны (алгоритм Карплуса–Стронга) — отсылка к домбре.
   * Используется для завершения раунда и нового рекорда.
   */
  private pluck(ctx: AudioContext, t: number, freq: number, gain: number): void {
    let buf = this.pluckCache.get(freq);
    if (!buf) {
      const sr = ctx.sampleRate;
      const len = Math.floor(sr * 1.4);
      buf = ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      const period = Math.max(2, Math.round(sr / freq));
      const ring = new Float32Array(period);
      for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
      let idx = 0;
      for (let i = 0; i < len; i++) {
        const next = (idx + 1) % period;
        const v = 0.5 * (ring[idx] + ring[next]) * 0.996;
        data[i] = ring[idx];
        ring[idx] = v;
        idx = next;
      }
      this.pluckCache.set(freq, buf);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
  }

  roundEnd(success: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    const notes = success ? [293.66, 349.23, 440, 587.33] : [293.66, 261.63, 220];
    notes.forEach((f, i) => this.pluck(ctx, t + i * 0.13, f, 0.55));
  }

  record(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + 0.1;
    // короткий «домбровый» наигрыш
    const seq = [440, 587.33, 659.25, 587.33, 880];
    seq.forEach((f, i) => this.pluck(ctx, t + i * 0.11, f, 0.5));
    this.tone(ctx, t + 0.55, 1760, 0.4, 0.06, 'sine');
  }
}

export const sound = new SoundEngine();
