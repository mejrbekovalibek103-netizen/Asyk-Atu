import { MAX_PLAYERS } from '../game/rules/matchState';
import type { Seat } from '../game/types';
import type { PeerInfo } from './protocol';

/**
 * Места за «столом» комнаты (2–4 игрока). Чистые функции без сети — их легко проверить тестами.
 *
 * - Место 0 — хозяин (создатель комнаты), 1–3 — гости. Гость при входе занимает свободное место сам.
 * - Место закрепляется за первым, кто его занял, и остаётся за ним, пока он в комнате: позже пришедший с тем
 *   же местом его не «перехватит» (даже если подобрал себе id поменьше).
 * - Если два гостя одновременно выбрали одно место, уступает тот, у кого id больше: решение одинаково на всех
 *   устройствах, поэтому все приходят к одной и той же рассадке.
 */

export const GUEST_SEATS: readonly Seat[] = [1, 2, 3];

/** Свободное место для нового гостя (null — мест нет). */
export function pickFreeSeat(peers: readonly PeerInfo[]): Seat | null {
  const taken = new Set(peers.map((p) => p.seat));
  return GUEST_SEATS.find((s) => !taken.has(s)) ?? null;
}

/**
 * Нужно ли мне уступить своё место: кто-то ещё в комнате сидит на нём и у него id меньше.
 * Хозяин (место 0) не уступает никогда; во время матча места не меняются.
 */
export function mustYieldSeat(mySeat: Seat | null, myId: string, peers: readonly PeerInfo[]): boolean {
  if (mySeat === null || mySeat === 0) return false;
  return peers.some((p) => p.seat === mySeat && p.clientId < myId);
}

/**
 * Закрепление мест за игроками. `prev` — прежние закрепления (место → id), `peers` — кто сейчас в комнате
 * (без меня). Закреплённый игрок, пока он в комнате на своём месте, остаётся; свободное место достаётся
 * претенденту с наименьшим id. Возвращает новый список по местам (длина MAX_PLAYERS, null — место свободно).
 */
export function resolveSeats(prev: readonly (string | null)[], peers: readonly PeerInfo[]): (PeerInfo | null)[] {
  const out: (PeerInfo | null)[] = Array.from({ length: MAX_PLAYERS }, () => null);
  for (let s = 0; s < MAX_PLAYERS; s++) {
    const claimants = peers.filter((p) => p.seat === s);
    if (!claimants.length) continue;
    const kept = prev[s] ? claimants.find((p) => p.clientId === prev[s]) : undefined;
    out[s] = kept ?? [...claimants].sort((a, b) => (a.clientId < b.clientId ? -1 : 1))[0];
  }
  return out;
}

/** Сколько игроков сейчас в комнате (я + занятые места). */
export function seatedCount(seats: readonly (PeerInfo | null)[], mySeat: Seat | null): number {
  return seats.filter(Boolean).length + (mySeat !== null ? 1 : 0);
}
