import { describe, expect, it } from 'vitest';
import { canStake, COLLECTION_MAX, parseCollection, STAKE_SIZE } from './collection';

describe('коллекция асыков: разбор ответа базы', () => {
  it('обычный ответ читается', () => {
    expect(parseCollection([{ id: 1, kind: 'bone' }, { id: 2, kind: 'bone', owner: 'x' }])).toEqual([
      { id: 1, kind: 'bone' },
      { id: 2, kind: 'bone' },
    ]);
    expect(parseCollection([])).toEqual([]);
  });

  it('не массив — отказ', () => {
    for (const bad of [null, undefined, 'x', 5, { id: 1, kind: 'bone' }]) expect(parseCollection(bad)).toBeNull();
  });

  it('мусорные строки, неизвестные виды и повторы пропускаются', () => {
    const rows = [
      { id: 1, kind: 'bone' },
      { id: 1, kind: 'bone' }, // повтор
      { id: 2, kind: 'gold' }, // вид, которого эта версия не знает
      { id: -3, kind: 'bone' },
      { id: 1.5, kind: 'bone' },
      { id: '4', kind: 'bone' },
      { id: Number.MAX_SAFE_INTEGER + 2, kind: 'bone' },
      { kind: 'bone' },
      null,
      'bone',
      JSON.parse('{"id":7,"kind":"bone","__proto__":{"polluted":1}}'),
    ];
    expect(parseCollection(rows)).toEqual([
      { id: 1, kind: 'bone' },
      { id: 7, kind: 'bone' },
    ]);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });

  it('огромный ответ обрезается', () => {
    const rows = Array.from({ length: COLLECTION_MAX + 500 }, (_, i) => ({ id: i + 1, kind: 'bone' }));
    expect(parseCollection(rows)).toHaveLength(COLLECTION_MAX);
  });

  it('на ставку нужно не меньше STAKE_SIZE асыков', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'bone' as const }));
    expect(STAKE_SIZE).toBeGreaterThanOrEqual(1);
    expect(STAKE_SIZE).toBeLessThanOrEqual(10); // не больше стартовых асыков: новый игрок может сыграть сразу
    expect(canStake(many(10))).toBe(true);
    expect(canStake(many(STAKE_SIZE))).toBe(true);
    expect(canStake(many(STAKE_SIZE - 1))).toBe(false);
    expect(canStake([])).toBe(false);
  });
});
