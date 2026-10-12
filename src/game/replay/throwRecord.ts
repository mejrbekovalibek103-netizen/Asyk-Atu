import type { AsykState, ContactEvent, ContactType, Piece, PhysicsWorld } from '../physics/PhysicsWorld';

/**
 * Запись броска для онлайн-матча.
 *
 * Физику считает только устройство бросающего. Оно записывает положения движущихся тел
 * (каждый N-й шаг), удары и выбивания и отправляет запись частями прямо во время броска.
 * Соперник проигрывает запись с небольшой задержкой, а в конце применяет точное итоговое
 * состояние кона. Поэтому результат на обоих устройствах совпадает всегда — даже если браузеры
 * по-разному округляют вычисления с плавающей точкой.
 */

/** Начало броска: чтобы соперник показал выброс руки и звук. */
export interface ThrowStart {
  throwIndex: number;
  angle: number;
  power: number;
}

/** Кадр: номер шага и плоский массив [индекс, x, y, угол, индекс, x, y, угол, …] (сақа — индекс -1). */
export interface Frame {
  s: number;
  b: number[];
}

const CONTACT_CODES: ContactType[] = ['saka-asyk', 'asyk-asyk', 'wall'];

/** События: c — удар (для звука и пыли), k — асык выбит. */
export type ReplayEvent = { s: number; t: 'c'; x: number; y: number; i: number; k: number } | { s: number; t: 'k'; i: number };

export interface ThrowChunk {
  seq: number;
  frames: Frame[];
  events: ReplayEvent[];
}

export interface ThrowEnd {
  /** Сколько шагов длился бросок. */
  steps: number;
  /** Итоговое состояние каждого асыка. */
  final: AsykState[];
  /** Где остановился сақа. */
  saka: [number, number, number] | null;
}

/** Каждый какой шаг записывать (шаг 1/120 с → кадр 40 раз в секунду). */
export const FRAME_EVERY = 3;
/** Отправлять запись частями примерно каждые 250 мс. */
export const CHUNK_EVERY_STEPS = 30;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Пишет бросок на устройстве бросающего. */
export class ThrowRecorder {
  private step = 0;
  private seq = 0;
  private frames: Frame[] = [];
  private events: ReplayEvent[] = [];
  private readonly last = new Map<number, [number, number, number]>();

  constructor(private readonly world: PhysicsWorld) {
    this.captureFrame(true);
  }

  /** Вызывается после каждого шага физики. Возвращает часть записи, если пора отправлять. */
  onStep(contacts: ContactEvent[], knocked: Piece[]): ThrowChunk | null {
    this.step += 1;
    for (const c of contacts) {
      this.events.push({ s: this.step, t: 'c', x: r2(c.x), y: r2(c.y), i: r2(c.impact), k: CONTACT_CODES.indexOf(c.type) });
    }
    for (const p of knocked) this.events.push({ s: this.step, t: 'k', i: p.index });
    if (this.step % FRAME_EVERY === 0) this.captureFrame(false);
    return this.step % CHUNK_EVERY_STEPS === 0 ? this.takeChunk() : null;
  }

  /** Бросок завершён: последняя часть и итоговое состояние. */
  finish(asykCount: number): { chunk: ThrowChunk; end: ThrowEnd } {
    this.captureFrame(false);
    const saka = this.world.saka;
    return {
      chunk: this.takeChunk(),
      end: {
        steps: this.step,
        final: this.world.exportAsyks(asykCount),
        saka: saka ? [r2(saka.body.position.x), r2(saka.body.position.y), r3(saka.body.angle)] : null,
      },
    };
  }

  private captureFrame(force: boolean): void {
    const b: number[] = [];
    for (const p of this.world.pieces) {
      const { x, y } = p.body.position;
      const a = p.body.angle;
      const prev = this.last.get(p.index);
      if (!force && prev && Math.abs(prev[0] - x) < 0.02 && Math.abs(prev[1] - y) < 0.02 && Math.abs(prev[2] - a) < 0.0005) continue;
      this.last.set(p.index, [x, y, a]);
      b.push(p.index, r2(x), r2(y), r3(a));
    }
    if (b.length) this.frames.push({ s: this.step, b });
  }

  private takeChunk(): ThrowChunk {
    const chunk = { seq: this.seq++, frames: this.frames, events: this.events };
    this.frames = [];
    this.events = [];
    return chunk;
  }
}

interface Track {
  s: number[];
  x: number[];
  y: number[];
  a: number[];
}

/** Сколько шагов записи держать в запасе перед стартом воспроизведения (сглаживает сеть). */
export const REPLAY_LEAD_STEPS = 24;

/** Проигрывает чужой бросок на устройстве соперника. */
export class ThrowPlayer {
  private readonly tracks = new Map<number, Track>();
  private events: ReplayEvent[] = [];
  private nextSeq = 0;
  private readonly pending = new Map<number, ThrowChunk>();
  private lastStep = 0;
  private endInfo: ThrowEnd | null = null;
  /** Текущий шаг воспроизведения. */
  cursor = 0;
  private started = false;

  constructor(readonly start: ThrowStart) {}

  /** Части могут прийти не по порядку — применяем строго по seq. */
  push(chunk: ThrowChunk): void {
    this.pending.set(chunk.seq, chunk);
    while (this.pending.has(this.nextSeq)) {
      const c = this.pending.get(this.nextSeq)!;
      this.pending.delete(this.nextSeq);
      this.nextSeq += 1;
      for (const f of c.frames) {
        for (let k = 0; k + 3 < f.b.length; k += 4) {
          const idx = f.b[k];
          let t = this.tracks.get(idx);
          if (!t) this.tracks.set(idx, (t = { s: [], x: [], y: [], a: [] }));
          t.s.push(f.s);
          t.x.push(f.b[k + 1]);
          t.y.push(f.b[k + 2]);
          t.a.push(f.b[k + 3]);
        }
        this.lastStep = Math.max(this.lastStep, f.s);
      }
      this.events.push(...c.events);
      for (const e of c.events) this.lastStep = Math.max(this.lastStep, e.s);
    }
  }

  end(info: ThrowEnd): void {
    this.endInfo = info;
  }

  get ended(): ThrowEnd | null {
    return this.endInfo && this.pending.size === 0 ? this.endInfo : null;
  }

  /** Есть ли данные, чтобы сделать следующий шаг (иначе ждём сеть). */
  canAdvance(): boolean {
    const end = this.ended;
    if (end) return this.cursor < end.steps;
    const lead = this.started ? 1 : REPLAY_LEAD_STEPS;
    return this.lastStep - this.cursor >= lead;
  }

  /** Сделать шаг: вернуть события этого шага и выставить тела. */
  advance(world: PhysicsWorld): ReplayEvent[] {
    this.started = true;
    this.cursor += 1;
    const due: ReplayEvent[] = [];
    while (this.events.length && this.events[0].s <= this.cursor) due.push(this.events.shift()!);
    for (const [idx, t] of this.tracks) {
      const p = world.pieceByIndex(idx);
      if (!p) continue;
      const pos = sample(t, this.cursor);
      if (pos) world.place(p, pos[0], pos[1], pos[2]);
    }
    return due;
  }

  /** Бросок проигран целиком. */
  done(): boolean {
    const end = this.ended;
    return !!end && this.cursor >= end.steps;
  }
}

/** Линейная интерполяция положения тела между ключевыми кадрами. */
function sample(t: Track, step: number): [number, number, number] | null {
  const n = t.s.length;
  if (!n || step < t.s[0]) return null;
  if (step >= t.s[n - 1]) return [t.x[n - 1], t.y[n - 1], t.a[n - 1]];
  // кадры идут по возрастанию шага — ищем отрезок двоичным поиском
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t.s[mid] <= step) lo = mid;
    else hi = mid;
  }
  const k = (step - t.s[lo]) / (t.s[hi] - t.s[lo]);
  return [t.x[lo] + (t.x[hi] - t.x[lo]) * k, t.y[lo] + (t.y[hi] - t.y[lo]) * k, t.a[lo] + (t.a[hi] - t.a[lo]) * k];
}

export function contactFromEvent(e: Extract<ReplayEvent, { t: 'c' }>): ContactEvent {
  return { x: e.x, y: e.y, impact: e.i, type: CONTACT_CODES[e.k] ?? 'asyk-asyk', pieces: [] };
}
