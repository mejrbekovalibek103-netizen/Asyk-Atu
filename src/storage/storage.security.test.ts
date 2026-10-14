import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSave } from './progress';

const KEY = 'asyk-atu:save:v1';

function fakeStorage(initial?: string) {
  const m = new Map<string, string>();
  if (initial !== undefined) m.set(KEY, initial);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const load = (raw: string) => {
  vi.stubGlobal('localStorage', fakeStorage(raw));
  return loadSave();
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()));

describe('localStorage правит кто угодно: сохранение читается с проверкой', () => {
  it('не JSON, null, массив, число → пустое сохранение, а не падение', () => {
    for (const raw of ['не json', 'null', '[]', '5', '"x"', '{', '']) {
      const s = load(raw);
      expect(s.stats.roundsPlayed, raw).toBe(0);
      expect(Object.keys(s.levels)).toHaveLength(0);
    }
  });

  it('огромная строка не разбирается', () => {
    const s = load(JSON.stringify({ levels: {}, stats: { roundsPlayed: 5 }, pad: 'x'.repeat(200_000) }));
    expect(s.stats.roundsPlayed).toBe(0);
  });

  it('неизвестные уровни и ключи вроде __proto__ не попадают в данные', () => {
    const s = load('{"levels":{"warmup":{"bestScore":50,"stars":2,"passed":true},"__proto__":{"bestScore":999},"constructor":{"bestScore":1},"evil":{"bestScore":1}},"stats":{}}');
    expect(Object.keys(s.levels)).toEqual(['warmup']);
    expect(({} as Record<string, unknown>).bestScore).toBeUndefined();
  });

  it('числа ограничены: отрицательные, NaN, строки, гигантские', () => {
    const s = load(JSON.stringify({ levels: { warmup: { bestScore: -5, bestKnocked: 'много', stars: 999, passed: 1, plays: 1e300 } }, stats: { roundsPlayed: 1e300, bestScore: -1, throws: null } }));
    const lp = s.levels.warmup;
    expect(lp.bestScore).toBe(0);
    expect(lp.bestKnocked).toBe(0);
    expect(lp.stars).toBe(3);
    expect(lp.plays).toBeLessThanOrEqual(1_000_000_000);
    expect(s.stats.roundsPlayed).toBeLessThanOrEqual(1_000_000_000);
    expect(s.stats.bestScore).toBe(0);
    expect(s.stats.throws).toBe(0);
  });

  it('имена очищаются как любой ввод, неизвестный кон сбрасывается', () => {
    const s = load(JSON.stringify({ levels: {}, stats: {}, settings: { duelNames: ['‮evil', 5], onlineName: '<b>x</b>\u0000', duelLayout: '../../x' } }));
    expect(s.settings.duelNames[0]).toBe('evil');
    expect(s.settings.duelNames[1]).toBe('');
    expect(s.settings.onlineName).toBe('<b>x</b>');
    expect(s.settings.duelLayout).toBe('ulken-kon');
  });

  it('прогресс правится только «в свою пользу» и только у себя: открытие уровней не влияет на других и на сервер', () => {
    // всё хранится локально; здесь важно лишь, что подделка не ломает игру и не расширяет данные
    const s = load(JSON.stringify({ levels: { warmup: { passed: true }, kon: { passed: true } }, stats: {} }));
    expect(s.levels.warmup.passed).toBe(true);
    expect(s.levels.kon.passed).toBe(true);
  });
});
