import type { MatchSyncState } from '../game/engine/GameEngine';
import type { Seat } from '../game/types';

/** Сколько бросков сделано в матче по снимку: по этому числу определяется, чьё состояние новее. */
export function totalOf(st: MatchSyncState | null | undefined): number {
  const total = (st?.rules as { total?: number } | undefined)?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/** Всё, что нужно знать о снимке для сравнения двух версий матча. */
export interface SyncFacts {
  total: number;
  knocked: [number, number];
  throws: [number, number];
  bestCombo: [number, number];
  /** Номера асыков, которые ещё в коне. */
  inZone: Set<number>;
}

const pair = (v: unknown): [number, number] => {
  const a = Array.isArray(v) ? v : [];
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return [n(a[0]), n(a[1])];
};

export function factsOf(st: MatchSyncState | null | undefined): SyncFacts {
  const r = (st?.rules ?? {}) as { knocked?: unknown; throws?: unknown; bestCombo?: unknown };
  return {
    total: totalOf(st),
    knocked: pair(r.knocked),
    throws: pair(r.throws),
    bestCombo: pair(r.bestCombo),
    inZone: new Set((st?.asyks ?? []).filter((a) => a[4] === 1).map((a) => a[0])),
  };
}

/**
 * Насколько этому экрану можно доверять собственному состоянию матча:
 * - `none` — состояния нет (после перезагрузки без сохранения): принимаем всё, своё не навязываем;
 * - `restored` — состояние из сохранения до перезагрузки: оно могло отстать, поэтому принимаем всё, что новее;
 * - `live` — мы всё время были в матче и сами видели каждый бросок: чужой снимок проверяется строго.
 */
export type SyncTrust = 'none' | 'restored' | 'live';

/**
 * Что делать с присланным снимком матча.
 *
 * - `apply` — принять;
 * - `reply` — соперник отстал (например, вернулся со старым снимком): отвечаем ему своим состоянием;
 * - `reject` — снимок невозможен в честной игре: игнорируем.
 *
 * Для `live` «невозможно» значит: изменились МОИ броски или очки (соперник не может бросать за меня);
 * счёт или комбо уменьшились; выбитый асык «воскрес»; соперник ушёл вперёд больше чем на один бросок
 * (броски строго по очереди); выбито больше асыков, чем убрано с поля, или больше, чем возможно за бросок.
 * Именно эти проверки не дают подделанному клиенту «перемотать» матч одним сообщением.
 */
export type SyncDecision = 'apply' | 'reply' | 'reject';

/** Больше асыков за один бросок не выбить (лучшие броски — 4–5; запас для подделки не нужен). */
export const MAX_KNOCKS_PER_THROW = 8;

export function decideSync(trust: SyncTrust, incoming: SyncFacts, local: SyncFacts, mySeat: Seat): SyncDecision {
  if (incoming.total < local.total) return 'reply';
  if (trust !== 'live') return 'apply';

  const peer: Seat = mySeat === 0 ? 1 : 0;
  // соперник может опережать меня не больше, чем на свой текущий бросок
  if (incoming.total > local.total + 1) return 'reject';
  // мои броски, мои очки и моё комбо — только мои: соперник не может их менять
  if (incoming.throws[mySeat] !== local.throws[mySeat]) return 'reject';
  if (incoming.knocked[mySeat] !== local.knocked[mySeat]) return 'reject';
  if (incoming.bestCombo[mySeat] !== local.bestCombo[mySeat]) return 'reject';
  // счёт соперника не уменьшается
  if (incoming.throws[peer] < local.throws[peer] || incoming.knocked[peer] < local.knocked[peer] || incoming.bestCombo[peer] < local.bestCombo[peer]) return 'reject';
  // выбитый асык не «воскресает»
  for (const id of incoming.inZone) if (!local.inZone.has(id)) return 'reject';
  // закон сохранения: сколько асыков убрано с поля — столько выбито, и не больше, чем бывает за бросок
  const removed = local.inZone.size - incoming.inZone.size;
  const credited = incoming.knocked[0] + incoming.knocked[1] - (local.knocked[0] + local.knocked[1]);
  if (removed !== credited || removed > MAX_KNOCKS_PER_THROW) return 'reject';
  return 'apply';
}
