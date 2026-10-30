import { describe, expect, it } from 'vitest';
import type { PeerInfo } from './protocol';
import { awayFromLobby, mustYieldSeat, pickFreeSeat, resolveSeats, seatedCount } from './seats';

const peer = (clientId: string, seat: 0 | 1 | 2 | 3, name = clientId): PeerInfo => ({ clientId, seat, name });
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
const LOW = '0000000000000000'; // «подобранный» маленький id

describe('рассадка в комнате (2–4 игрока)', () => {
  it('гость занимает первое свободное место 1–3, хозяйское место 0 не занимает', () => {
    expect(pickFreeSeat([])).toBe(1);
    expect(pickFreeSeat([peer(A, 0)])).toBe(1);
    expect(pickFreeSeat([peer(A, 0), peer(B, 1)])).toBe(2);
    expect(pickFreeSeat([peer(A, 0), peer(B, 2)])).toBe(1);
    expect(pickFreeSeat([peer(A, 0), peer(B, 1), peer(C, 2)])).toBe(3);
  });

  it('мест нет — null (за столом уже четверо)', () => {
    expect(pickFreeSeat([peer(A, 0), peer(B, 1), peer(C, 2), peer('dddddddddddddddd', 3)])).toBeNull();
  });

  it('одновременный вход на одно место: уступает тот, у кого id больше; хозяин не уступает никогда', () => {
    expect(mustYieldSeat(1, B, [peer(A, 1)])).toBe(true);
    expect(mustYieldSeat(1, A, [peer(B, 1)])).toBe(false);
    expect(mustYieldSeat(0, B, [peer(A, 0)])).toBe(false);
    expect(mustYieldSeat(null, B, [peer(A, 1)])).toBe(false);
    expect(mustYieldSeat(2, B, [peer(A, 1)])).toBe(false);
  });

  it('закреплённого игрока не «перехватить» даже маленьким id, пока он в комнате', () => {
    const first = resolveSeats([null, null, null, null], [peer(A, 0), peer(B, 1)]);
    expect(first.map((p) => p?.clientId ?? null)).toEqual([A, B, null, null]);
    const pins = first.map((p) => p?.clientId ?? null);
    const later = resolveSeats(pins, [peer(A, 0), peer(B, 1), peer(LOW, 1), peer(LOW + '1'.slice(0, 0), 0)]);
    expect(later[0]?.clientId).toBe(A);
    expect(later[1]?.clientId).toBe(B);
  });

  it('место освободилось — достаётся претенденту с наименьшим id (одинаково на всех устройствах)', () => {
    const r = resolveSeats([A, B, null, null], [peer(A, 0), peer(C, 1), peer(LOW, 1)]);
    expect(r[1]?.clientId).toBe(LOW);
  });

  it('сколько игроков за столом: я + занятые места', () => {
    expect(seatedCount([peer(A, 0), null, peer(B, 2), null], 1)).toBe(3);
    expect(seatedCount([null, null, null, null], 0)).toBe(1);
    expect(seatedCount([null, null, null, null], null)).toBe(0);
  });

  it('кто не вернулся в комнату ожидания: смотрит итоги или ещё в матче; ушедший место освободил', () => {
    const inResults = { ...peer(B, 1), results: true };
    const inMatch = { ...peer(C, 2), busy: true };
    expect(awayFromLobby([null, inResults, inMatch, peer(LOW, 3)])).toEqual([inResults, inMatch]);
    expect(awayFromLobby([null, peer(B, 1), null, null])).toEqual([]);
    expect(awayFromLobby([null, null, null, null])).toEqual([]);
  });
});
