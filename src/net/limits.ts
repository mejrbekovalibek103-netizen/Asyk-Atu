import { REPLAY_CAPS } from '../game/replay/throwRecord';
import { MAX_MATCH_THROWS } from '../game/rules/matchState';

/**
 * Жёсткие пределы для всего, что приходит по сети. Каждое число выведено из реальных значений игры
 * с запасом: настоящий клиент их никогда не достигает, а подделка упирается в них и отбрасывается.
 */
export const LIMITS = {
  /** Размер одного сообщения (JSON), байт. Реальный бросок целиком — около 3 КБ. */
  maxEnvelopeBytes: 64_000,
  /** Асыков в расстановке не больше (в играх до 16). */
  maxAsyks: 32,
  /** Бросков в матче. */
  maxThrows: MAX_MATCH_THROWS,
  /** Частей записи одного броска: 9 с × 4 части/с = 36, с запасом. */
  maxChunksPerThrow: 100,
  /** Кадров в одной части: настоящая — до 10 (30 шагов / каждый 3-й). */
  maxFramesPerChunk: 40,
  /** Событий (удары, выбивания) в одной части. */
  maxEventsPerChunk: 200,
  /** Всего кадров и событий за бросок — защита памяти получателя. */
  maxFramesPerThrow: REPLAY_CAPS.maxFrames,
  maxEventsPerThrow: REPLAY_CAPS.maxEvents,
  /** Шагов физики в одном броске: 9 с / (1/120 с) = 1080, с запасом. */
  maxSteps: REPLAY_CAPS.maxSteps,
  /** Координаты в мире 800×1200 (с запасом за бордюр). */
  coordMin: -200,
  coordMax: 1_400,
  /** Угол поворота тела накапливается; разумный предел. */
  maxBodyAngle: 1_000,
  maxImpact: 500,
  /** Угол прицела: ±78° плюс разброс руки. */
  maxAimAngle: 1.5,
  maxMatchId: 1_000_000,
  /** Длина строк до очистки (имена, id): всё, что длиннее, подозрительно. */
  maxStringLen: 100,
} as const;

/**
 * Ограничитель частоты («ведро с жетонами»): `rate` жетонов в секунду, ёмкость `burst`.
 * Нужен, чтобы подделанный клиент не мог завалить получателя потоком сообщений.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** true — сообщение пропустить; false — превышен лимит. */
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Допустимая частота по типам сообщений: (в секунду, всплеск). */
export const RATES: Record<string, readonly [number, number]> = {
  aim: [40, 25],
  throwChunk: [14, 14],
  throwStart: [3, 4],
  throwEnd: [3, 4],
  start: [2, 3],
  sync: [2, 3],
  syncRequest: [2, 3],
  skip: [1, 3],
  rematch: [2, 3],
  rematchAccept: [2, 3],
  leave: [2, 3],
};

/**
 * Счётчик нарушений за скользящее окно: если соперник за короткое время прислал слишком много
 * некорректных или лишних сообщений, считаем его неисправным и временно игнорируем.
 */
export class StrikeCounter {
  private readonly times: number[] = [];
  private blockedUntil = 0;

  constructor(
    private readonly maxStrikes = 25,
    private readonly windowMs = 10_000,
    private readonly blockMs = 15_000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Записать нарушение. Возвращает true, если соперник теперь заблокирован. */
  strike(): boolean {
    const t = this.now();
    this.times.push(t);
    while (this.times.length && t - this.times[0] > this.windowMs) this.times.shift();
    if (this.times.length >= this.maxStrikes) {
      this.blockedUntil = t + this.blockMs;
      this.times.length = 0;
    }
    return this.isBlocked();
  }

  isBlocked(): boolean {
    return this.now() < this.blockedUntil;
  }

  /** Сколько миллисекунд блокировка ещё продлится (0 — не заблокирован). */
  remainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }
}
