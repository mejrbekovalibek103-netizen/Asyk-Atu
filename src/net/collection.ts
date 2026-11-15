/**
 * Коллекция асыков игрока — разбор ответа базы. Чистые функции без сети (их проверяют тесты).
 * Ответ сервера тоже проходит проверку: в интерфейс попадает только то, что имеет ожидаемый вид.
 */

/** Виды асыков, которые знает эта версия игры (редкие появятся позже). */
export const ASYK_KINDS = ['bone'] as const;
export type AsykKind = (typeof ASYK_KINDS)[number];

export interface OwnedAsyk {
  id: number;
  kind: AsykKind;
  /** Асык стоит в коне соревновательного матча: id матча (uuid). null — свободен. */
  locked: string | null;
}

/** Столько асыков нужно поставить в кон, чтобы войти в соревновательную игру (решение владельца проекта). */
export const STAKE_SIZE = 5;

/** Больше этого в одной коллекции не показываем (защита интерфейса от огромного ответа). */
export const COLLECTION_MAX = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isKind = (v: unknown): v is AsykKind => typeof v === 'string' && (ASYK_KINDS as readonly string[]).includes(v);

/**
 * Отметка «в коне» (asyks.locked_match): uuid → в нижнем регистре; null или нет колонки (соревновательный
 * SQL ещё не выполнен) → свободен; что-то другое → undefined (строка испорчена, её пропускаем).
 */
function parseLocked(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : undefined;
}

/** Строки таблицы `asyks` → коллекция. Неизвестные виды, испорченные строки и повторы пропускаются; не массив → null. */
export function parseCollection(raw: unknown): OwnedAsyk[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OwnedAsyk[] = [];
  const seen = new Set<number>();
  for (const row of raw.slice(0, COLLECTION_MAX)) {
    if (typeof row !== 'object' || row === null) continue;
    const { id, kind, locked_match } = row as { id?: unknown; kind?: unknown; locked_match?: unknown };
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !isKind(kind)) continue;
    const locked = parseLocked(locked_match);
    if (locked === undefined) continue;
    seen.add(id);
    out.push({ id, kind, locked });
  }
  return out;
}

/** Сколько асыков свободно (не стоят в коне ни одного матча). */
export function freeCount(collection: readonly OwnedAsyk[]): number {
  let n = 0;
  for (const a of collection) if (a.locked === null) n += 1;
  return n;
}

/** Хватает ли свободных асыков на ставку. */
export function canStake(collection: readonly OwnedAsyk[]): boolean {
  return freeCount(collection) >= STAKE_SIZE;
}

/** Матчи, в коне которых стоят асыки игрока (id без повторов, по порядку появления). */
export function lockedMatches(collection: readonly OwnedAsyk[]): string[] {
  const out: string[] = [];
  for (const a of collection) if (a.locked !== null && !out.includes(a.locked)) out.push(a.locked);
  return out;
}
