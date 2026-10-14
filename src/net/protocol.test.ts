import { describe, expect, it } from 'vitest';
import { hashToRoute, routeToHash } from '../ui/routes';
import { CLIENT_ID_RE, formatRoomCode, makeClientId, makeRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from './protocol';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

describe('код комнаты', () => {
  it(`${ROOM_CODE_LENGTH} символов без похожих букв и цифр`, () => {
    for (let i = 0; i < 300; i++) {
      const code = makeRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(code).toMatch(/^[A-Z2-9]+$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('генерируется из криптостойкого источника: коды не повторяются', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(makeRoomCode());
    expect(seen.size).toBe(2000);
  });

  it('использует переданный источник байтов, а не Math.random', () => {
    const orig = Math.random;
    Math.random = () => {
      throw new Error('Math.random использовать нельзя');
    };
    try {
      let n = 0;
      const code = makeRoomCode((len) => Uint8Array.from({ length: len }, () => n++ % 256));
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
    } finally {
      Math.random = orig;
    }
  });

  it('равномерность: на случайном источнике каждый символ алфавита встречается одинаково часто', () => {
    let state = 0x9e3779b9;
    const bytes = (len: number) => Uint8Array.from({ length: len }, () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 24));
    const counts = new Map<string, number>();
    const codes = 4000;
    for (let i = 0; i < codes; i++) for (const ch of makeRoomCode(bytes)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(ALPHABET.length);
    const expected = (codes * ROOM_CODE_LENGTH) / ALPHABET.length;
    for (const v of counts.values()) expect(Math.abs(v - expected)).toBeLessThan(expected * 0.15);
  });

  it('без смещения: байты 248–255 отбрасываются и не превращаются в символы', () => {
    // первые восемь байтов «плохие» (248…255), дальше 0,1,2…: первым символом должен стать символ байта 0, а не остаток 248 % 31
    const seq = [248, 249, 250, 251, 252, 253, 254, 255, ...Array.from({ length: 32 }, (_, i) => i)];
    const code = makeRoomCode((len) => Uint8Array.from(seq.slice(0, len)));
    expect(code[0]).toBe(ALPHABET[0]);
    expect(code[1]).toBe(ALPHABET[1]);
  });

  it('если байты почти все «плохие», цикл всё равно завершается', () => {
    let n = 0;
    // 255 — отбрасывается; редкие «хорошие» байты пробиваются
    const code = makeRoomCode((len) => Uint8Array.from({ length: len }, () => (n++ % 7 === 0 ? 3 : 255)));
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
  });

  it('ввод вручную нормализуется, мусор и неверная длина отклоняются', () => {
    expect(normalizeRoomCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRoomCode(' abc de fgh jk ')).toBe('ABCDEFGHJK');
    expect(normalizeRoomCode('ABCDEFGHJ')).toBeNull(); // короткий
    expect(normalizeRoomCode('ABCDEFGHJKM')).toBeNull(); // длинный
    expect(normalizeRoomCode('ABCDEFGH0K')).toBeNull(); // 0 не входит в алфавит
    expect(normalizeRoomCode('../../etc/passwd')).toBeNull();
    expect(normalizeRoomCode('<script>')).toBeNull();
  });

  it('формат для человека', () => {
    expect(formatRoomCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });

  it('ссылка на комнату разбирается обратно, плохие ссылки ведут на главную', () => {
    const route = { name: 'ROOM' as const, code: 'ABCDEFGHJK' };
    expect(hashToRoute(routeToHash(route))).toEqual(route);
    expect(hashToRoute('#/room/bad')).toEqual({ name: 'MENU' });
    expect(hashToRoute('#/room/ABCDEFGHJ0')).toEqual({ name: 'MENU' });
    expect(hashToRoute('#/room/' + 'A'.repeat(200))).toEqual({ name: 'MENU' });
    expect(hashToRoute('#/play/../../x')).toEqual({ name: 'MENU' });
  });
});

describe('идентификатор клиента', () => {
  it('16 hex-символов, уникальный', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = makeClientId();
      expect(id).toMatch(CLIENT_ID_RE);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });
});
