import type { LevelConfig, StarRule } from '../types';

/** Таблица очков (показывается и в «Как играть», и в README). */
export const POINTS = {
  /** За каждый выбитый асык. */
  asyk: 10,
  /** За помеченный (синий) асык в испытании «Мерген». */
  target: 50,
  /** Комбо: за каждый дополнительный асык, выбитый тем же броском. */
  comboPerExtra: 10,
  /** Серия: +5 за второй подряд результативный бросок, +10 за третий… */
  streakStep: 5,
  streakMax: 20,
  /** «Таза кон»: весь кон очищен — бонус за каждый неиспользованный бросок. */
  cleanPerThrow: 15,
} as const;

export interface ThrowScore {
  throwIndex: number;
  knocked: number;
  /** Базовые очки за асыки этого броска (уже начислены в момент выбивания). */
  points: number;
  comboBonus: number;
  streakBonus: number;
  streak: number;
  targetKnocked: boolean;
}

/**
 * Подсчёт очков.
 *
 * Гарантии:
 * - один и тот же асык приносит очки только один раз (Set выбитых id);
 * - итог броска (комбо/серия) подводится только один раз на бросок;
 * - бонус за чистый кон начисляется один раз за раунд.
 */
export class ScoreKeeper {
  score = 0;
  knocked = 0;
  streak = 0;
  bestCombo = 0;
  hitThrows = 0;
  targetThrow: number | null = null;
  cleanBonus = 0;

  private readonly knockedIds = new Set<number>();
  private readonly resolvedThrows = new Set<number>();
  private readonly perThrow = new Map<number, { count: number; points: number; target: boolean }>();
  private roundFinished = false;

  /** Регистрирует выбитый асык. Возвращает начисленные очки (0 — если уже был засчитан). */
  registerKnockout(pieceId: number, isTarget: boolean, throwIndex: number): number {
    if (this.knockedIds.has(pieceId) || this.roundFinished) return 0;
    this.knockedIds.add(pieceId);
    const pts = isTarget ? POINTS.target : POINTS.asyk;
    this.score += pts;
    this.knocked += 1;
    const t = this.perThrow.get(throwIndex) ?? { count: 0, points: 0, target: false };
    t.count += 1;
    t.points += pts;
    if (isTarget) {
      t.target = true;
      if (this.targetThrow === null) this.targetThrow = throwIndex;
    }
    this.perThrow.set(throwIndex, t);
    return pts;
  }

  /** Подводит итог броска: комбо и серия. Повторный вызов для того же броска вернёт null. */
  resolveThrow(throwIndex: number): ThrowScore | null {
    if (this.resolvedThrows.has(throwIndex) || this.roundFinished) return null;
    this.resolvedThrows.add(throwIndex);
    const t = this.perThrow.get(throwIndex) ?? { count: 0, points: 0, target: false };

    const comboBonus = t.count >= 2 ? (t.count - 1) * POINTS.comboPerExtra : 0;
    let streakBonus = 0;
    if (t.count > 0) {
      this.streak += 1;
      this.hitThrows += 1;
      streakBonus = Math.min(POINTS.streakMax, (this.streak - 1) * POINTS.streakStep);
    } else {
      this.streak = 0;
    }
    this.bestCombo = Math.max(this.bestCombo, t.count);
    this.score += comboBonus + streakBonus;

    return {
      throwIndex,
      knocked: t.count,
      points: t.points,
      comboBonus,
      streakBonus,
      streak: this.streak,
      targetKnocked: t.target,
    };
  }

  /** Завершает раунд. Бонус «Таза кон» — если выбиты все асыки. */
  finishRound(remainingThrows: number, cleared: boolean): number {
    if (this.roundFinished) return 0;
    this.roundFinished = true;
    this.cleanBonus = cleared ? Math.max(0, remainingThrows) * POINTS.cleanPerThrow : 0;
    this.score += this.cleanBonus;
    return this.cleanBonus;
  }

  isKnocked(pieceId: number): boolean {
    return this.knockedIds.has(pieceId);
  }

  /** Счёт между бросками (для сохранения раунда). Внутренние множества не нужны: выбитые асыки из кона уже убраны. */
  exportState(): ScoreState {
    return { score: this.score, knocked: this.knocked, streak: this.streak, bestCombo: this.bestCombo, hitThrows: this.hitThrows, targetThrow: this.targetThrow };
  }

  /** Восстановить счёт (данные уже проверены `parseSoloState`). */
  importState(s: ScoreState): void {
    this.score = s.score;
    this.knocked = s.knocked;
    this.streak = s.streak;
    this.bestCombo = s.bestCombo;
    this.hitThrows = s.hitThrows;
    this.targetThrow = s.targetThrow;
  }
}

export interface ScoreState {
  score: number;
  knocked: number;
  streak: number;
  bestCombo: number;
  hitThrows: number;
  targetThrow: number | null;
}

export interface StarInput {
  knocked: number;
  totalAsyks: number;
  score: number;
  cleared: boolean;
  targetThrow: number | null;
}

export function isGoalMet(level: LevelConfig, r: StarInput): boolean {
  return level.goal.type === 'target' ? r.targetThrow !== null : r.knocked >= level.goal.count;
}

function ruleMet(rule: StarRule, r: StarInput): boolean {
  switch (rule.type) {
    case 'knocked':
      return r.knocked >= rule.count;
    case 'cleared':
      return r.cleared;
    case 'score':
      return r.score >= rule.value;
    case 'targetWithin':
      return r.targetThrow !== null && r.targetThrow <= rule.throws;
  }
}

/** 0–3 звезды: 1 — цель выполнена, 2 и 3 — дополнительные условия уровня. */
export function computeStars(level: LevelConfig, r: StarInput): number {
  if (!isGoalMet(level, r)) return 0;
  let stars = 1;
  if (ruleMet(level.stars[0], r)) stars = 2;
  if (stars === 2 && ruleMet(level.stars[1], r)) stars = 3;
  return stars;
}
