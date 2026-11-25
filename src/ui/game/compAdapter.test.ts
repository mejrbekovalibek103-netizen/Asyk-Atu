import { describe, expect, it } from 'vitest';
import { compStateFixture } from '../../game/rules/compFixture';
import { STAKE_LAYOUT_IDS } from '../../game/levels/matchLayouts';
import { compLayout, parseCompState as parseView } from '../../game/rules/CompetitiveRules';
import { parseCompState } from '../../net/competitive';
import { compStateToJson } from './compAdapter';

/** Сеть разбирает comp_state в CompState, экран превращает его обратно для движка — числа не должны меняться. */
describe('compStateToJson', () => {
  // код в образце базы содержит 1 — такой код сеть не примет (в настоящих кодах нет 0/O/1/I/L)
  const fixture = (over: Parameters<typeof compStateFixture>[0] = {}) => compStateFixture({ ...over, match: { join_code: 'ABCDEFGHJK', ...over.match } });
  const roundTrip = (raw: unknown) => {
    const st = parseCompState(raw);
    expect(st).not.toBeNull();
    return parseView(compStateToJson(st!));
  };

  it('даёт движку то же состояние, что и исходный ответ базы', () => {
    const raw = fixture();
    expect(roundTrip(raw)).toEqual(parseView(raw));
  });

  it('сохраняет кон, последний бросок и итоги', () => {
    const kon = Array.from({ length: 10 }, (_, k) => (k === 3 ? [3, 0, 0, 0, 0] : [k, 120 + k * 50.25, 420.5, 0.012, 1]));
    const raw = fixture({
      match: {
        status: 'settled',
        throw_no: 4,
        kon_state: kon,
        last_throw: { throw_no: 4, seat: 1, angle: -0.2, power: 0.7, kon_before: null, knocked: [3], steps: 410 },
        settled_at: '2026-11-13T10:05:00.123Z',
        end_reason: 'throws_out',
        current_seat: null,
      },
      result: { refunded: false, won: [3], returned: [0, 2, 4, 6, 8], lost: [], delta: 1 },
    });
    const v = roundTrip(raw);
    expect(v).toEqual(parseView(raw));
    expect(v?.konState?.[3]).toEqual([3, 0, 0, 0, 0]);
    expect(v?.result?.delta).toBe(1);
  });

  it('лобби (места ещё не розданы) тоже переводится без потерь', () => {
    const raw = fixture({
      match: { status: 'forming', players: null, kon_size: 5, current_seat: null, turn_started_at: null, turn_deadline: null, skip_absent_at: null, skip_at: null, started_at: null },
      me: { seat: null, ready: false },
      players: [
        { lobby_slot: 0, seat: null, name: 'Айдос', is_host: true, is_me: true, staked: true, ready: false, forfeited: false, active: true, throws: 0, real_throws: 0, knocked: 0, best_combo: 0, skips_in_row: 0, seen_ago_ms: 0, online: true },
      ],
      slots: [],
    });
    expect(roundTrip(raw)).toEqual(parseView(raw));
  });
});

describe('матч на четверых', () => {
  const players = Array.from({ length: 4 }, (_, k) => ({ lobby_slot: k, seat: k, name: `Игрок ${k}`, is_host: k === 0, is_me: k === 2, staked: true, ready: true, forfeited: k === 1, active: true, throws: 3, real_throws: 3, knocked: k, best_combo: Math.min(1, k), skips_in_row: 0, seen_ago_ms: 500, online: true }));
  const slots = Array.from({ length: 20 }, (_, k) => ({ slot: k, owner_seat: k % 4, knocked_by_seat: null, knocked_throw: null, mine: k % 4 === 2, asyk_id: k % 4 === 2 ? 100 + k : null }));
  const raw = (layout: string) =>
    compStateFixture({
      match: { join_code: 'ABCDEFGHJK', layout_id: layout, players: 4, max_players: 4, kon_size: 20, throws_per_player: 10, current_seat: 3, throw_no: 11 },
      me: { lobby_slot: 2, seat: 2, is_host: false, staked_ids: [102, 106, 110, 114, 118] },
      players,
      slots,
    });

  it('сеть и движок принимают состояние на любом коне', () => {
    for (const id of STAKE_LAYOUT_IDS) {
      const st = parseCompState(raw(id));
      expect(st).not.toBeNull();
      const v = parseView(compStateToJson(st!));
      expect(v).toEqual(parseView(raw(id)));
      expect(v?.players).toBe(4);
      expect(compLayout(v!).asyks).toHaveLength(20);
    }
  });
});
