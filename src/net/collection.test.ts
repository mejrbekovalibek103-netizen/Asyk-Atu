import { describe, expect, it } from 'vitest';
import { canStake, COLLECTION_MAX, freeCount, lockedMatches, parseCollection, STAKE_SIZE, type OwnedAsyk } from './collection';

const MATCH = '123e4567-e89b-12d3-a456-426614174000';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('коллекция асыков: разбор ответа базы', () => {
  it('обычный ответ читается', () => {
    expect(parseCollection([{ id: 1, kind: 'bone' }, { id: 2, kind: 'bone', owner: 'x' }])).toEqual([
      { id: 1, kind: 'bone', locked: null },
      { id: 2, kind: 'bone', locked: null },
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
      { id: 1, kind: 'bone', locked: null },
      { id: 7, kind: 'bone', locked: null },
    ]);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });

  it('огромный ответ обрезается', () => {
    const rows = Array.from({ length: COLLECTION_MAX + 500 }, (_, i) => ({ id: i + 1, kind: 'bone' }));
    expect(parseCollection(rows)).toHaveLength(COLLECTION_MAX);
  });

  it('отметка «в коне»: uuid матча, null или нет колонки — свободен, мусор — строка пропускается', () => {
    const rows = [
      { id: 1, kind: 'bone', locked_match: MATCH.toUpperCase() },
      { id: 2, kind: 'bone', locked_match: null },
      { id: 3, kind: 'bone' },
      { id: 4, kind: 'bone', locked_match: 'not-a-uuid' },
      { id: 5, kind: 'bone', locked_match: 42 },
      { id: 6, kind: 'bone', locked_match: `${MATCH}x` },
    ];
    expect(parseCollection(rows)).toEqual([
      { id: 1, kind: 'bone', locked: MATCH },
      { id: 2, kind: 'bone', locked: null },
      { id: 3, kind: 'bone', locked: null },
    ]);
  });

  it('на ставку нужно не меньше STAKE_SIZE свободных асыков', () => {
    const many = (n: number, locked: string | null = null): OwnedAsyk[] =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'bone' as const, locked }));
    expect(STAKE_SIZE).toBeGreaterThanOrEqual(1);
    expect(STAKE_SIZE).toBeLessThanOrEqual(10); // не больше стартовых асыков: новый игрок может сыграть сразу
    expect(canStake(many(10))).toBe(true);
    expect(canStake(many(STAKE_SIZE))).toBe(true);
    expect(canStake(many(STAKE_SIZE - 1))).toBe(false);
    expect(canStake([])).toBe(false);
    // 10 асыков, но 6 уже в коне — свободных 4, ставка невозможна
    const mixed = [...many(6, MATCH), ...many(4).map((a) => ({ ...a, id: a.id + 100 }))];
    expect(freeCount(mixed)).toBe(4);
    expect(canStake(mixed)).toBe(false);
    expect(freeCount(many(10, MATCH))).toBe(0);
  });

  it('список матчей, где стоят асыки, — без повторов', () => {
    const c: OwnedAsyk[] = [
      { id: 1, kind: 'bone', locked: MATCH },
      { id: 2, kind: 'bone', locked: null },
      { id: 3, kind: 'bone', locked: MATCH },
      { id: 4, kind: 'bone', locked: OTHER },
    ];
    expect(lockedMatches(c)).toEqual([MATCH, OTHER]);
    expect(lockedMatches([])).toEqual([]);
  });
});
