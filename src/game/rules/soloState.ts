import { POINTS } from '../scoring/scoring';
import type { LevelConfig } from '../types';

/**
 * Счёт одиночного раунда на момент между бросками. Сохраняется в localStorage, чтобы перезагрузка
 * страницы не обнуляла раунд, и поэтому читается как недоверенный ввод (`parseSoloState`).
 */
export interface SoloState {
  /** Сколько бросков уже сделано (1…throws−1: пока раунд не окончен). */
  throwsUsed: number;
  score: number;
  knocked: number;
  streak: number;
  bestCombo: number;
  hitThrows: number;
  /** Номером какого броска выбит синий асык (null — ещё нет). */
  targetThrow: number | null;
  /** Сколько времени раунда уже прошло, мс (только у испытаний со временем): перезагрузка не возвращает время. */
  elapsedMs: number;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Строгая проверка сохранённого счёта: возвращает НОВЫЙ объект только с известными полями или null.
 * Проверяются не только типы и диапазоны, но и взаимосвязи (очки соответствуют выбитым асыкам и броскам),
 * поэтому повреждённое или подделанное сохранение отбрасывается, а не ломает раунд.
 */
export function parseSoloState(raw: unknown, level: LevelConfig): SoloState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const total = level.asyks.length;
  const hasTarget = level.asyks.some((a) => a.kind === 'target');

  if (!isInt(r.throwsUsed, 1, level.throws - 1)) return null;
  if (!isInt(r.knocked, 0, total)) return null;
  if (!isInt(r.hitThrows, 0, r.throwsUsed)) return null;
  if (!isInt(r.streak, 0, r.hitThrows)) return null;
  if (!isInt(r.bestCombo, 0, r.knocked)) return null;
  // каждый результативный бросок выбивает хотя бы один асык, а выбитые асыки приходят из результативных бросков
  if (r.hitThrows > r.knocked || (r.knocked > 0) !== (r.hitThrows > 0) || (r.knocked > 0) !== (r.bestCombo > 0)) return null;

  let targetThrow: number | null = null;
  if (r.targetThrow !== null && r.targetThrow !== undefined) {
    if (!hasTarget || !isInt(r.targetThrow, 1, r.throwsUsed)) return null;
    targetThrow = r.targetThrow;
  }

  // очки: за асык 10 (за синий 50), комбо добавляет не больше 10 за каждый выбитый, серия — не больше 20 за результативный бросок
  const perAsyk = hasTarget ? POINTS.target : POINTS.asyk;
  const min = POINTS.asyk * r.knocked;
  const max = perAsyk * r.knocked + POINTS.comboPerExtra * r.knocked + POINTS.streakMax * r.hitThrows;
  if (!isInt(r.score, min, max)) return null;

  // время: у испытаний без лимита его нет; с лимитом — от нуля до лимита (до исчерпания раунд не сохраняется)
  const limitMs = level.timeLimit ? level.timeLimit * 1000 : 0;
  const elapsed = r.elapsedMs === undefined ? 0 : r.elapsedMs;
  if (!isInt(elapsed, 0, Math.max(0, limitMs - 1))) return null;

  return { throwsUsed: r.throwsUsed, score: r.score, knocked: r.knocked, streak: r.streak, bestCombo: r.bestCombo, hitThrows: r.hitThrows, targetThrow, elapsedMs: elapsed };
}
