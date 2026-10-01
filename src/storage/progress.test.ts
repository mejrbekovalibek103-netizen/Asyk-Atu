import { describe, expect, it } from 'vitest';
import type { RoundResult } from '../game/types';
import { applyRoundResult, emptySave, isLevelUnlocked } from './progress';

const result = (over: Partial<RoundResult> = {}): RoundResult => ({
  levelId: 'warmup',
  score: 40,
  knocked: 4,
  totalAsyks: 5,
  throwsUsed: 5,
  throwsTotal: 5,
  cleared: false,
  cleanBonus: 0,
  targetOut: false,
  targetThrow: null,
  bestCombo: 1,
  hitThrows: 4,
  passed: true,
  stars: 2,
  ...over,
});

describe('сохранение прогресса', () => {
  it('первый результат — новый рекорд и открытие следующего уровня', () => {
    const o = applyRoundResult(emptySave(), result());
    expect(o.isNewRecord).toBe(true);
    expect(o.levelBest).toBe(40);
    expect(o.save.stats.roundsPlayed).toBe(1);
    expect(isLevelUnlocked(o.save, ['warmup', 'kon'], 'kon')).toBe(true);
  });

  it('худший результат не перезаписывает рекорд и звёзды', () => {
    const first = applyRoundResult(emptySave(), result({ score: 90, stars: 3 })).save;
    const o = applyRoundResult(first, result({ score: 20, stars: 1, passed: false }));
    expect(o.isNewRecord).toBe(false);
    expect(o.save.levels.warmup.bestScore).toBe(90);
    expect(o.save.levels.warmup.stars).toBe(3);
    expect(o.save.levels.warmup.passed).toBe(true);
    expect(o.save.stats.roundsPlayed).toBe(2);
  });

  it('следующий уровень закрыт, пока не пройден предыдущий', () => {
    const o = applyRoundResult(emptySave(), result({ passed: false, stars: 0 }));
    expect(isLevelUnlocked(o.save, ['warmup', 'kon'], 'kon')).toBe(false);
    expect(isLevelUnlocked(o.save, ['warmup', 'kon'], 'warmup')).toBe(true);
  });
});
