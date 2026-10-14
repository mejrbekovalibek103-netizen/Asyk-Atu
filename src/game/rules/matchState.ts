import type { Seat } from '../types';

/** Страховка от бесконечного матча: максимум бросков на двоих (чётное — поровну каждому). */
export const MATCH_MAX_THROWS = 30;

/** Счёт матча для синхронизации устройств (и для сохранения в sessionStorage). */
export interface MatchState {
  current: Seat;
  turnId: number;
  knocked: [number, number];
  throws: [number, number];
  bestCombo: [number, number];
  total: number;
  finished: boolean;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function pair(v: unknown, lo: number, hi: number): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v as unknown[];
  return isInt(a, lo, hi) && isInt(b, lo, hi) ? [a, b] : null;
}

/**
 * Строгая проверка присланного/сохранённого состояния матча. Возвращает НОВЫЙ объект только с
 * известными полями (лишние отбрасываются) или null, если данные недопустимы или противоречивы.
 * Применяется ко всему, что приходит из сети и из хранилища браузера.
 */
export function parseMatchState(raw: unknown, totalAsyks: number): MatchState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const half = MATCH_MAX_THROWS / 2;
  const knocked = pair(r.knocked, 0, totalAsyks);
  const throws = pair(r.throws, 0, half);
  const bestCombo = pair(r.bestCombo, 0, totalAsyks);
  if (!knocked || !throws || !bestCombo) return null;
  if (r.current !== 0 && r.current !== 1) return null;
  if (!isInt(r.turnId, 1, 1_000_000)) return null;
  if (!isInt(r.total, 0, MATCH_MAX_THROWS)) return null;
  if (typeof r.finished !== 'boolean') return null;
  // непротиворечивость: бросков поровну (первый мог бросить на один больше), выбито не больше, чем асыков
  if (throws[0] + throws[1] !== r.total) return null;
  if (Math.abs(throws[0] - throws[1]) > 1) return null;
  if (knocked[0] + knocked[1] > totalAsyks) return null;
  if (bestCombo[0] > knocked[0] || bestCombo[1] > knocked[1]) return null;
  return { current: r.current, turnId: r.turnId, knocked, throws, bestCombo, total: r.total, finished: r.finished };
}
