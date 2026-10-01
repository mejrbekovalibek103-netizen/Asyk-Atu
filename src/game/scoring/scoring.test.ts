import { describe, expect, it } from 'vitest';
import { getLevel } from '../levels/levels';
import { computeStars, POINTS, ScoreKeeper } from './scoring';

describe('ScoreKeeper', () => {
  it('+10 за асык и защита от повторного начисления', () => {
    const s = new ScoreKeeper();
    expect(s.registerKnockout(1, false, 1)).toBe(POINTS.asyk);
    expect(s.registerKnockout(1, false, 1)).toBe(0);
    expect(s.registerKnockout(1, false, 2)).toBe(0);
    expect(s.score).toBe(10);
    expect(s.knocked).toBe(1);
  });

  it('комбо за несколько асыков одним броском', () => {
    const s = new ScoreKeeper();
    s.registerKnockout(1, false, 1);
    s.registerKnockout(2, false, 1);
    s.registerKnockout(3, false, 1);
    const t = s.resolveThrow(1)!;
    expect(t.knocked).toBe(3);
    expect(t.comboBonus).toBe(2 * POINTS.comboPerExtra);
    expect(s.score).toBe(30 + 20);
    expect(s.bestCombo).toBe(3);
  });

  it('итог броска подводится только один раз', () => {
    const s = new ScoreKeeper();
    s.registerKnockout(1, false, 1);
    s.registerKnockout(2, false, 1);
    expect(s.resolveThrow(1)).not.toBeNull();
    const score = s.score;
    expect(s.resolveThrow(1)).toBeNull();
    expect(s.score).toBe(score);
  });

  it('серия результативных бросков и её сброс при промахе', () => {
    const s = new ScoreKeeper();
    s.registerKnockout(1, false, 1);
    expect(s.resolveThrow(1)!.streakBonus).toBe(0);
    s.registerKnockout(2, false, 2);
    expect(s.resolveThrow(2)!.streakBonus).toBe(5);
    s.registerKnockout(3, false, 3);
    expect(s.resolveThrow(3)!.streakBonus).toBe(10);
    expect(s.resolveThrow(4)!.streak).toBe(0); // промах
    s.registerKnockout(4, false, 5);
    expect(s.resolveThrow(5)!.streakBonus).toBe(0);
    expect(s.hitThrows).toBe(4);
  });

  it('бонус «Таза кон» за оставшиеся броски, один раз', () => {
    const s = new ScoreKeeper();
    s.registerKnockout(1, false, 1);
    s.resolveThrow(1);
    expect(s.finishRound(3, true)).toBe(3 * POINTS.cleanPerThrow);
    expect(s.finishRound(3, true)).toBe(0);
    expect(s.registerKnockout(2, false, 2)).toBe(0); // после конца раунда очки не идут
  });

  it('помеченный асык и номер броска', () => {
    const s = new ScoreKeeper();
    expect(s.registerKnockout(7, true, 2)).toBe(POINTS.target);
    expect(s.targetThrow).toBe(2);
  });
});

describe('звёзды', () => {
  it('уровень на выбивание', () => {
    const level = getLevel('warmup'); // цель 3, 2★ — 4, 3★ — все
    const base = { totalAsyks: 5, score: 0, targetThrow: null };
    expect(computeStars(level, { ...base, knocked: 2, cleared: false })).toBe(0);
    expect(computeStars(level, { ...base, knocked: 3, cleared: false })).toBe(1);
    expect(computeStars(level, { ...base, knocked: 4, cleared: false })).toBe(2);
    expect(computeStars(level, { ...base, knocked: 5, cleared: true })).toBe(3);
  });

  it('уровень на меткость', () => {
    const level = getLevel('mergen');
    const base = { knocked: 1, totalAsyks: 7, score: 50, cleared: false };
    expect(computeStars(level, { ...base, targetThrow: null })).toBe(0);
    expect(computeStars(level, { ...base, targetThrow: 3 })).toBe(1);
    expect(computeStars(level, { ...base, targetThrow: 2 })).toBe(2);
    expect(computeStars(level, { ...base, targetThrow: 1 })).toBe(3);
  });
});
