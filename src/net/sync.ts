import type { MatchSyncState } from '../game/engine/GameEngine';

/** Сколько бросков сделано в матче по снимку: по этому числу определяется, чьё состояние новее. */
export function totalOf(st: MatchSyncState | null | undefined): number {
  const total = (st?.rules as { total?: number } | undefined)?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/**
 * Что делать с присланным снимком матча.
 *
 * - `apply` — принять: наше состояние ещё не достоверно (после перезагрузки), либо у соперника
 *   сделано не меньше бросков;
 * - `reply` — соперник отстал (например, вернулся со старым снимком): отвечаем ему своим состоянием.
 *
 * Именно это правило не даёт вернувшемуся игроку «обнулить» чужой матч своим пустым коном.
 */
export type SyncDecision = 'apply' | 'reply';

export function decideSync(localAuthoritative: boolean, incomingTotal: number, localTotal: number): SyncDecision {
  return !localAuthoritative || incomingTotal >= localTotal ? 'apply' : 'reply';
}
