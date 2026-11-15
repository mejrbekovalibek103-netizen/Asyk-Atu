/**
 * Только для тестов: ответ comp_state соревновательного матча на двоих (кон «Линия») в том виде,
 * как его собирает private.comp_state_json в supabase/competitive.sql. Поля можно переопределить.
 */

export const COMP_MATCH_ID = '0b6f7a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
export type Json = Record<string, unknown>;

/** Ответ comp_state для матча на двоих в том виде, как его собирает private.comp_state_json. */
export function compStateFixture(over: { match?: Json; me?: Json; players?: Json[]; slots?: Json[]; result?: Json | null; now?: string } = {}): Json {
  const players = over.players ?? [
    { lobby_slot: 0, seat: 0, name: 'Айдос', is_host: true, is_me: true, staked: true, ready: true, forfeited: false, active: true, throws: 0, real_throws: 0, knocked: 0, best_combo: 0, skips_in_row: 0, seen_ago_ms: 1200, online: true },
    { lobby_slot: 1, seat: 1, name: 'Дана', is_host: false, is_me: false, staked: true, ready: true, forfeited: false, active: true, throws: 0, real_throws: 0, knocked: 0, best_combo: 0, skips_in_row: 0, seen_ago_ms: null, online: false },
  ];
  const slots =
    over.slots ??
    Array.from({ length: 10 }, (_, k) => ({ slot: k, owner_seat: k % 2, knocked_by_seat: null, knocked_throw: null, mine: k % 2 === 0, asyk_id: k % 2 === 0 ? 100 + k : null }));
  return {
    now: over.now ?? '2026-11-13T10:00:00.000Z',
    match: {
      id: COMP_MATCH_ID,
      join_code: 'ABCDE12345',
      layout_id: 'stake-line',
      sim_version: 1,
      status: 'active',
      players: 2,
      max_players: 2,
      stake_size: 5,
      kon_size: 10,
      throws_per_player: 15,
      turn_seconds: 45,
      current_seat: 0,
      throw_no: 0,
      kon_state: null,
      last_throw: null,
      turn_started_at: '2026-11-13T09:59:58.000Z',
      turn_deadline: '2026-11-13T10:00:43.000Z',
      skip_absent_at: '2026-11-13T10:00:18.000Z',
      skip_at: '2026-11-13T10:00:48.000Z',
      ready_deadline: null,
      pending: false,
      pending_at: null,
      players_rev: 7,
      created_at: '2026-11-13T09:55:00.000Z',
      started_at: '2026-11-13T09:59:58.000Z',
      settled_at: null,
      end_reason: null,
      ...over.match,
    },
    me: { lobby_slot: 0, seat: 0, is_host: true, staked: true, ready: true, forfeited: false, staked_ids: [100, 102, 104, 106, 108], ...over.me },
    players,
    slots,
    result: over.result ?? null,
  };
}
