import type { MatchSyncState } from '../game/engine/GameEngine';
import type { Seat } from '../game/types';

/** Сколько бросков сделано в матче по снимку: по этому числу определяется, чьё состояние новее. */
export function totalOf(st: MatchSyncState | null | undefined): number {
  const total = (st?.rules as { total?: number } | undefined)?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/** Всё, что нужно знать о снимке для сравнения двух версий матча. Массивы — по местам игроков. */
export interface SyncFacts {
  total: number;
  knocked: number[];
  throws: number[];
  bestCombo: number[];
  /** Номера асыков, которые ещё в коне. */
  inZone: Set<number>;
}

/** Массив ровно из `n` чисел: недостающее и мусор считаются нулём (снимок уже проверен при разборе). */
const list = (v: unknown, n: number): number[] => {
  const a = Array.isArray(v) ? v : [];
  return Array.from({ length: n }, (_, i) => (typeof a[i] === 'number' && Number.isFinite(a[i]) ? (a[i] as number) : 0));
};

/** Факты снимка матча на `players` игроков. */
export function factsOf(st: MatchSyncState | null | undefined, players = 2): SyncFacts {
  const r = (st?.rules ?? {}) as { knocked?: unknown; throws?: unknown; bestCombo?: unknown };
  return {
    total: totalOf(st),
    knocked: list(r.knocked, players),
    throws: list(r.throws, players),
    bestCombo: list(r.bestCombo, players),
    inZone: new Set((st?.asyks ?? []).filter((a) => a[4] === 1).map((a) => a[0])),
  };
}

/**
 * Насколько этому экрану можно доверять собственному состоянию матча:
 * - `none` — состояния нет (после перезагрузки без сохранения): принимаем всё, своё не навязываем;
 * - `restored` — состояние из сохранения или после потери связи: оно могло отстать, поэтому принимаем всё, что новее;
 * - `live` — мы всё время были в матче и сами видели каждый бросок: чужой снимок проверяется строго.
 */
export type SyncTrust = 'none' | 'restored' | 'live';

/**
 * Что делать с присланным снимком матча.
 *
 * - `apply` — принять;
 * - `reply` — отправитель отстал (например, вернулся со старым снимком): отвечаем ему своим состоянием;
 * - `reject` — снимок невозможен в честной игре: игнорируем.
 *
 * Для `live` «невозможно» значит: изменились МОИ броски или очки (никто не может бросать за меня);
 * у кого-то счёт или комбо уменьшились; выбитый асык «воскрес»; другой игрок ушёл вперёд больше чем на
 * один бросок (броски строго по кругу: пока я жду своего хода, каждый из остальных бросает не больше раза);
 * выбито больше асыков, чем убрано с поля, или больше, чем возможно за эти броски.
 * Именно эти проверки не дают подделанному клиенту «перемотать» матч одним сообщением.
 */
export type SyncDecision = 'apply' | 'reply' | 'reject';

/** Больше асыков за один бросок не выбить (лучшие броски — 4–5; запас для подделки не нужен). */
export const MAX_KNOCKS_PER_THROW = 8;

export function decideSync(trust: SyncTrust, incoming: SyncFacts, local: SyncFacts, mySeat: Seat): SyncDecision {
  if (incoming.total < local.total) return 'reply';
  if (trust !== 'live') return 'apply';

  const n = local.throws.length;
  if (incoming.throws.length !== n || incoming.knocked.length !== n || incoming.bestCombo.length !== n) return 'reject';
  const ahead = incoming.total - local.total;
  // пока я жду своего хода, остальные бросают по очереди — не больше чем (n − 1) бросков вперёд
  if (ahead > n - 1) return 'reject';
  // мои броски, мои очки и моё комбо — только мои: другие не могут их менять
  if (incoming.throws[mySeat] !== local.throws[mySeat]) return 'reject';
  if (incoming.knocked[mySeat] !== local.knocked[mySeat]) return 'reject';
  if (incoming.bestCombo[mySeat] !== local.bestCombo[mySeat]) return 'reject';
  // у остальных: не больше одного броска на каждого, счёт и комбо не уменьшаются
  let extra = 0;
  for (let s = 0; s < n; s++) {
    if (s === mySeat) continue;
    const d = incoming.throws[s] - local.throws[s];
    if (d < 0 || d > 1) return 'reject';
    extra += d;
    if (incoming.knocked[s] < local.knocked[s] || incoming.bestCombo[s] < local.bestCombo[s]) return 'reject';
  }
  if (extra !== ahead) return 'reject';
  // выбитый асык не «воскресает»
  for (const id of incoming.inZone) if (!local.inZone.has(id)) return 'reject';
  // закон сохранения: сколько асыков убрано с поля — столько выбито, и не больше, чем бывает за эти броски
  const removed = local.inZone.size - incoming.inZone.size;
  const credited = incoming.knocked.reduce((a, b) => a + b, 0) - local.knocked.reduce((a, b) => a + b, 0);
  if (removed !== credited || removed > MAX_KNOCKS_PER_THROW * Math.max(1, ahead)) return 'reject';
  return 'apply';
}
