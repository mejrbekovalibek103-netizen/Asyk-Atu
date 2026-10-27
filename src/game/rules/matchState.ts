import type { Seat } from '../types';

/** Игроков в матче: на одном устройстве — двое, онлайн — от двух до четырёх. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/**
 * Бросков на каждого игрока. У двоих — по 15; у троих и четверых — по 10, чтобы матч не затягивался,
 * пока каждый ждёт своей очереди (решение владельца проекта).
 */
export function throwsPerPlayer(players: number): number {
  return players <= 2 ? 15 : 10;
}

/** Страховка от бесконечного матча: всего бросков (поровну на каждого). */
export function matchThrowLimit(players: number): number {
  return throwsPerPlayer(players) * players;
}

/** Наибольший лимит бросков среди всех составов — для проверки входящих сообщений. */
export const MAX_MATCH_THROWS = Math.max(...[2, 3, 4].map(matchThrowLimit));

/** Счёт матча для синхронизации устройств (и для сохранения в sessionStorage / localStorage). Массивы — по местам. */
export interface MatchState {
  current: Seat;
  turnId: number;
  knocked: number[];
  throws: number[];
  bestCombo: number[];
  total: number;
  finished: boolean;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function intArray(v: unknown, length: number, lo: number, hi: number): number[] | null {
  if (!Array.isArray(v) || v.length !== length) return null;
  const out: number[] = [];
  for (const x of v as unknown[]) {
    if (!isInt(x, lo, hi)) return null;
    out.push(x);
  }
  return out;
}

/**
 * Строгая проверка присланного/сохранённого состояния матча на `players` игроков. Возвращает НОВЫЙ объект
 * только с известными полями (лишние отбрасываются) или null, если данные недопустимы или противоречивы.
 * Применяется ко всему, что приходит из сети и из хранилища браузера.
 */
export function parseMatchState(raw: unknown, totalAsyks: number, players: number): MatchState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!isInt(players, MIN_PLAYERS, MAX_PLAYERS)) return null;
  const r = raw as Record<string, unknown>;
  const per = throwsPerPlayer(players);
  const knocked = intArray(r.knocked, players, 0, totalAsyks);
  const throws = intArray(r.throws, players, 0, per);
  const bestCombo = intArray(r.bestCombo, players, 0, totalAsyks);
  if (!knocked || !throws || !bestCombo) return null;
  if (!isInt(r.current, 0, players - 1)) return null;
  if (!isInt(r.turnId, 1, 1_000_000)) return null;
  if (!isInt(r.total, 0, matchThrowLimit(players))) return null;
  if (typeof r.finished !== 'boolean') return null;
  // непротиворечивость: броски по кругу (у кого-то может быть на один больше), выбито не больше, чем асыков
  if (throws.reduce((a, b) => a + b, 0) !== r.total) return null;
  if (Math.max(...throws) - Math.min(...throws) > 1) return null;
  if (knocked.reduce((a, b) => a + b, 0) > totalAsyks) return null;
  if (bestCombo.some((c, i) => c > knocked[i])) return null;
  return { current: r.current as Seat, turnId: r.turnId, knocked, throws, bestCombo, total: r.total, finished: r.finished };
}
