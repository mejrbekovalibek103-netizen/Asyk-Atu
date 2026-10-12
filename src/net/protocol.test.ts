import { describe, expect, it } from 'vitest';
import { hashToRoute, routeToHash } from '../ui/routes';
import { makeRoomCode, normalizeRoomCode } from './protocol';

describe('код комнаты', () => {
  it('6 символов без похожих букв и цифр', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('ввод вручную нормализуется, мусор отклоняется', () => {
    expect(normalizeRoomCode('ab3-k7x')).toBe('AB3K7X');
    expect(normalizeRoomCode('AB3K7')).toBeNull();
    expect(normalizeRoomCode('ABOK7X')).toBeNull(); // буква O не используется
  });

  it('ссылка на комнату разбирается обратно', () => {
    const route = { name: 'ROOM' as const, code: 'AB3K7X' };
    expect(hashToRoute(routeToHash(route))).toEqual(route);
    expect(hashToRoute('#/room/bad')).toEqual({ name: 'MENU' });
  });
});
