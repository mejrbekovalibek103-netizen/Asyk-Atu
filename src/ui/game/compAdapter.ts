import type { CompState } from '../../net/competitive';

/**
 * Состояние соревновательного матча для движка. Сеть (`useCompMatch`) отдаёт уже разобранный CompState
 * (camelCase, времена в мс), а движок и CompetitiveRules разбирают ответ comp_state в виде базы (snake_case,
 * времена ISO). Здесь — обратное превращение: те же числа, только в форме базы. Движок всё равно проверяет
 * результат сам (parseCompState в CompetitiveRules), так что ошибка здесь даст отказ, а не неверный кон.
 */

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function compStateToJson(st: CompState): Record<string, unknown> {
  const m = st.match;
  const lt = m.lastThrow;
  return {
    now: iso(st.now),
    match: {
      id: m.id,
      join_code: m.joinCode,
      layout_id: m.layoutId,
      sim_version: m.simVersion,
      status: m.status,
      players: m.players,
      max_players: m.maxPlayers,
      stake_size: m.stakeSize,
      kon_size: m.konSize,
      throws_per_player: m.throwsPerPlayer,
      turn_seconds: m.turnSeconds,
      current_seat: m.currentSeat,
      throw_no: m.throwNo,
      kon_state: m.konState,
      last_throw: lt
        ? { throw_no: lt.throwNo, seat: lt.seat, angle: lt.angle, power: lt.power, kon_before: lt.konBefore, knocked: lt.knocked, steps: lt.steps }
        : null,
      turn_started_at: iso(m.turnStartedAt),
      turn_deadline: iso(m.turnDeadline),
      skip_absent_at: iso(m.skipAbsentAt),
      skip_at: iso(m.skipAt),
      ready_deadline: iso(m.readyDeadline),
      pending: m.pending,
      pending_at: iso(m.pendingAt),
      players_rev: m.playersRev,
      created_at: iso(m.createdAt),
      started_at: iso(m.startedAt),
      settled_at: iso(m.settledAt),
      end_reason: m.endReason,
    },
    me: {
      lobby_slot: st.me.lobbySlot,
      seat: st.me.seat,
      is_host: st.me.isHost,
      staked: st.me.staked,
      ready: st.me.ready,
      forfeited: st.me.forfeited,
      staked_ids: st.me.stakedIds,
    },
    players: st.players.map((p) => ({
      lobby_slot: p.lobbySlot,
      seat: p.seat,
      name: p.name,
      is_host: p.isHost,
      is_me: p.isMe,
      staked: p.staked,
      ready: p.ready,
      forfeited: p.forfeited,
      active: p.active,
      throws: p.throws,
      real_throws: p.realThrows,
      knocked: p.knocked,
      best_combo: p.bestCombo,
      skips_in_row: p.skipsInRow,
      seen_ago_ms: p.seenAgoMs,
      online: p.online,
    })),
    slots: [...st.slots]
      .sort((a, b) => a.slot - b.slot)
      .map((s) => ({ slot: s.slot, owner_seat: s.ownerSeat, knocked_by_seat: s.knockedBySeat, knocked_throw: s.knockedThrow, mine: s.mine, asyk_id: s.asykId })),
    result: st.result ? { ...st.result } : null,
  };
}
