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
}

/** Столько асыков нужно поставить в кон, чтобы войти в соревновательную игру (решение владельца проекта). */
export const STAKE_SIZE = 5;

/** Больше этого в одной коллекции не показываем (защита интерфейса от огромного ответа). */
export const COLLECTION_MAX = 2000;

const isKind = (v: unknown): v is AsykKind => typeof v === 'string' && (ASYK_KINDS as readonly string[]).includes(v);

/** Строки таблицы `asyks` → коллекция. Неизвестные виды и повторы пропускаются; не массив → null. */
export function parseCollection(raw: unknown): OwnedAsyk[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OwnedAsyk[] = [];
  const seen = new Set<number>();
  for (const row of raw.slice(0, COLLECTION_MAX)) {
    if (typeof row !== 'object' || row === null) continue;
    const { id, kind } = row as { id?: unknown; kind?: unknown };
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !isKind(kind)) continue;
    seen.add(id);
    out.push({ id, kind });
  }
  return out;
}

/** Хватает ли асыков на ставку. */
export function canStake(collection: readonly OwnedAsyk[]): boolean {
  return collection.length >= STAKE_SIZE;
}
