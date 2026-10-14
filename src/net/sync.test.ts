import { describe, expect, it } from 'vitest';
import type { MatchSyncState } from '../game/engine/GameEngine';
import { decideSync, factsOf, MAX_KNOCKS_PER_THROW, totalOf } from './sync';

/** Снимок матча: сколько выбито у каждого, какие асыки ещё в коне, сколько бросков сделано. */
function snap(opts: { throws?: [number, number]; knocked?: [number, number]; inZone?: number[]; combo?: [number, number] }): MatchSyncState {
  const throws = opts.throws ?? [0, 0];
  const total = throws[0] + throws[1];
  const inZone = opts.inZone ?? Array.from({ length: 12 }, (_, k) => k);
  return {
    asyks: Array.from({ length: 12 }, (_, i) => [i, 100 + i * 50, 400, 0, inZone.includes(i) ? 1 : 0] as MatchSyncState['asyks'][number]),
    rules: { current: 0, turnId: 1, knocked: opts.knocked ?? [0, 0], throws, bestCombo: opts.combo ?? [0, 0], total, finished: false },
  };
}

const ALL = Array.from({ length: 12 }, (_, k) => k);
const without = (...ids: number[]) => ALL.filter((i) => !ids.includes(i));

describe('totalOf / factsOf', () => {
  it('число бросков берётся из снимка, мусор считается нулём', () => {
    expect(totalOf(snap({ throws: [4, 4] }))).toBe(8);
    expect(totalOf({ asyks: [], rules: { total: '8' } })).toBe(0);
    expect(totalOf({ asyks: [], rules: { total: NaN } })).toBe(0);
    expect(totalOf(null)).toBe(0);
    expect(totalOf({ asyks: [], rules: undefined })).toBe(0);
  });

  it('факты: в коне остаются только асыки с флагом 1', () => {
    const f = factsOf(snap({ throws: [1, 1], knocked: [2, 0], inZone: [3, 4] }));
    expect([...f.inZone].sort()).toEqual([3, 4]);
    expect(f.knocked).toEqual([2, 0]);
  });
});

describe('решение о синхронизации', () => {
  // я — игрок 0 (хозяин); к 8-му броску: я выбил 3, соперник 2, в коне 7 асыков
  const mine = 0 as const;
  const local = factsOf(snap({ throws: [4, 4], knocked: [3, 2], inZone: without(0, 1, 2, 3, 4), combo: [2, 1] }));
  const next = (over: Parameters<typeof snap>[0]) => factsOf(snap({ throws: [5, 4], knocked: [3, 2], inZone: without(0, 1, 2, 3, 4), combo: [2, 1], ...over }));

  describe('уровни доверия', () => {
    it('нет состояния (после перезагрузки): принимается всё, даже пустой снимок', () => {
      expect(decideSync('none', factsOf(snap({})), factsOf(snap({})), mine)).toBe('apply');
      expect(decideSync('none', local, factsOf(snap({})), mine)).toBe('apply');
    });

    it('сохранённое состояние: принимается всё, что новее или такое же; отставшее — ответ', () => {
      expect(decideSync('restored', local, factsOf(snap({ throws: [3, 3], knocked: [2, 1], inZone: without(0, 1, 2) })), mine)).toBe('apply');
      expect(decideSync('restored', factsOf(snap({})), local, mine)).toBe('reply');
    });

    it('живое состояние не затирается пустым или отставшим снимком — соперник получает ответ', () => {
      // сценарий найденной ранее ошибки: гость перезагрузился и прислал пустой кон
      expect(decideSync('live', factsOf(snap({})), local, mine)).toBe('reply');
      expect(decideSync('live', factsOf(snap({ throws: [3, 3], knocked: [2, 1], inZone: without(0, 1, 2) })), local, mine)).toBe('reply');
    });
  });

  describe('честные снимки при живом состоянии', () => {
    it('такой же снимок', () => {
      expect(decideSync('live', local, local, mine)).toBe('apply');
    });

    it('соперник сделал свой бросок и выбил два асыка', () => {
      const honest = next({ throws: [4, 5], knocked: [3, 4], inZone: without(0, 1, 2, 3, 4, 5, 6) });
      expect(decideSync('live', honest, local, mine)).toBe('apply');
    });

    it('соперник бросил и промахнулся (асыки те же)', () => {
      expect(decideSync('live', next({ throws: [4, 5], knocked: [3, 2] }), local, mine)).toBe('apply');
    });
  });

  describe('подделки при живом состоянии', () => {
    it('«перемотка»: соперник присылает «все асыки выбиты мной, матч окончен»', () => {
      const cheat = factsOf(snap({ throws: [4, 4], knocked: [3, 9], inZone: [] }));
      expect(decideSync('live', cheat, local, mine)).toBe('reject'); // выбито 7 за «один» снимок: больше предела за бросок
    });

    it('соперник прыгает вперёд на несколько бросков', () => {
      expect(decideSync('live', factsOf(snap({ throws: [7, 6], knocked: [3, 4], inZone: without(0, 1, 2, 3, 4, 5, 6) })), local, mine)).toBe('reject');
    });

    it('соперник меняет МОИ броски, очки или комбо', () => {
      expect(decideSync('live', next({ throws: [5, 4] }), local, mine)).toBe('reject'); // мой бросок, которого не было
      expect(decideSync('live', next({ throws: [4, 5], knocked: [9, 2], inZone: without(0, 1, 2, 3, 4, 5, 6, 7, 8, 9) }), local, mine)).toBe('reject'); // мои очки выросли
      expect(decideSync('live', next({ throws: [4, 5], knocked: [3, 2], combo: [5, 1] }), local, mine)).toBe('reject'); // моё комбо выросло
    });

    it('счёт соперника «уменьшился»', () => {
      expect(decideSync('live', next({ throws: [4, 5], knocked: [3, 1] }), local, mine)).toBe('reject');
      expect(decideSync('live', next({ throws: [4, 5], knocked: [3, 2], combo: [2, 0] }), local, mine)).toBe('reject');
    });

    it('выбитый асык «воскрес»', () => {
      expect(decideSync('live', next({ throws: [4, 5], inZone: without(1, 2, 3, 4) }), local, mine)).toBe('reject'); // асык 0 уже был выбит
    });

    it('нарушен закон сохранения: выбито больше, чем убрано с поля (и наоборот)', () => {
      expect(decideSync('live', next({ throws: [4, 5], knocked: [3, 4], inZone: without(0, 1, 2, 3, 4, 5) }), local, mine)).toBe('reject'); // +2 очка, но убран один асык
      expect(decideSync('live', next({ throws: [4, 5], knocked: [3, 2], inZone: without(0, 1, 2, 3, 4, 5) }), local, mine)).toBe('reject'); // убран асык без очков
    });

    it(`за один бросок выбить больше ${MAX_KNOCKS_PER_THROW} асыков нельзя, даже если закон сохранения соблюдён`, () => {
      const big = factsOf(snap({ throws: [4, 5], knocked: [3, 2 + 9], inZone: [] }));
      expect(decideSync('live', big, factsOf(snap({ throws: [4, 4], knocked: [3, 2], inZone: without(0, 1, 2, 3, 4).slice(0, 7).concat([]) })), mine)).toBe('reject');
    });
  });

  it('за гостя (место 1) проверка зеркальна: чужие — это броски хозяина', () => {
    const guestLocal = factsOf(snap({ throws: [4, 4], knocked: [3, 2], inZone: without(0, 1, 2, 3, 4), combo: [2, 1] }));
    // хозяин (соперник гостя) сделал бросок и выбил один асык — честно
    const honest = factsOf(snap({ throws: [5, 4], knocked: [4, 2], inZone: without(0, 1, 2, 3, 4, 5), combo: [2, 1] }));
    expect(decideSync('live', honest, guestLocal, 1)).toBe('apply');
    // хозяин пытается изменить броски гостя
    const cheat = factsOf(snap({ throws: [5, 5], knocked: [4, 2], inZone: without(0, 1, 2, 3, 4, 5), combo: [2, 1] }));
    expect(decideSync('live', cheat, guestLocal, 1)).toBe('reject');
  });
});
