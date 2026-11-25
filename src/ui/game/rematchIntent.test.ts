import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placesByKnocked } from '../screens/CompResultOverlay';
import { markRematchIntent, takeRematchIntent } from './rematchIntent';

describe('отметка «Реванш»', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('помнит число игроков и читается один раз', () => {
    markRematchIntent('ABCDEFGHJK', 4);
    expect(takeRematchIntent('ABCDEFGHJK')).toBe(4);
    expect(takeRematchIntent('ABCDEFGHJK')).toBeNull();
  });

  it('чужой код не подходит и отметку не снимает', () => {
    markRematchIntent('ABCDEFGHJK', 3);
    expect(takeRematchIntent('KJHGFEDCBA')).toBeNull();
    expect(takeRematchIntent('ABCDEFGHJK')).toBe(3);
  });

  it('отметка старой версии (только код) или испорченная — как на двоих', () => {
    for (const raw of ['ABCDEFGHJK', 'ABCDEFGHJK:9', 'ABCDEFGHJK:x']) {
      sessionStorage.setItem('asyk-comp-rematch', raw);
      expect(takeRematchIntent('ABCDEFGHJK')).toBe(2);
    }
  });
});

describe('места в итогах', () => {
  it('поровну — одно место: 1, 1, 3, 4', () => {
    const r = placesByKnocked([{ knocked: 2 }, { knocked: 5 }, { knocked: 5 }, { knocked: 0 }]);
    expect(r.map((x) => [x.p.knocked, x.place])).toEqual([[5, 1], [5, 1], [2, 3], [0, 4]]);
  });
});
