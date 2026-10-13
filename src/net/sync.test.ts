import { describe, expect, it } from 'vitest';
import type { MatchSyncState } from '../game/engine/GameEngine';
import { decideSync, totalOf } from './sync';

const snap = (total: unknown): MatchSyncState => ({ asyks: [], rules: { total } });

describe('синхронизация матча после переподключения', () => {
  it('число бросков берётся из снимка, мусор считается нулём', () => {
    expect(totalOf(snap(8))).toBe(8);
    expect(totalOf(snap('8'))).toBe(0);
    expect(totalOf(snap(NaN))).toBe(0);
    expect(totalOf(null)).toBe(0);
    expect(totalOf({ asyks: [], rules: undefined })).toBe(0);
  });

  it('вернувшийся игрок (состояние недостоверно) принимает любой снимок', () => {
    expect(decideSync(false, 8, 0)).toBe('apply');
    expect(decideSync(false, 0, 0)).toBe('apply');
  });

  it('достоверное состояние не затирается более старым снимком — вместо этого соперник получает ответ', () => {
    // сценарий найденной ошибки: гость перезагрузился и прислал пустой кон (0 бросков), у хозяина уже 8
    expect(decideSync(true, 0, 8)).toBe('reply');
    expect(decideSync(true, 5, 6)).toBe('reply');
  });

  it('более новый или равный снимок принимается', () => {
    expect(decideSync(true, 9, 8)).toBe('apply');
    expect(decideSync(true, 8, 8)).toBe('apply');
  });
});
