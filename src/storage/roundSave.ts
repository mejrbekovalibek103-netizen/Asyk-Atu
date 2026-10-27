import type { MatchSyncState } from '../game/engine/GameEngine';
import { getMatchLayout, MATCH_LAYOUTS } from '../game/levels/matchLayouts';
import { parseMatchState } from '../game/rules/matchState';
import { parseSoloState } from '../game/rules/soloState';
import type { KonLayout, LevelConfig, MatchConfig } from '../game/types';
import { parseAsykStates, parseMatchConfig } from '../net/validate';

/**
 * Сохранение незавершённого раунда: перезагрузка страницы (или «убитая» телефоном вкладка) не обнуляет
 * счёт, раунд продолжается с того места, где закончился последний бросок.
 *
 * Сохраняется состояние между бросками (кон и счёт), а не полёт сақа: перезагрузка прямо во время броска
 * возвращает раунд к состоянию до этого броска, попытка не тратится.
 *
 * Данные лежат в localStorage, который кто угодно может править, поэтому читаются как недоверенный ввод:
 * ограничение размера, типы, диапазоны и взаимосвязи (число выбитых в счёте = числу убранных с поля).
 */

const SOLO_KEY = 'asyk-atu:round:solo:v1';
const DUEL_KEY = 'asyk-atu:round:duel:v1';

/** Старше — считаем забытым и начинаем раунд заново. */
export const ROUND_TTL_MS = 12 * 60 * 60 * 1000;
/** Сохранение — это кон (до 32 асыков) и несколько чисел; всё, что больше, не разбираем. */
const MAX_CHARS = 20_000;

type Stored = Record<string, unknown>;

function readRaw(key: string, now: number): Stored | null {
  try {
    const text = globalThis.localStorage?.getItem(key);
    if (!text || text.length > MAX_CHARS) return null;
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const r = raw as Stored;
    if (r.v !== 1) return null;
    const at = r.savedAt;
    // чуть вперёд допускаем (часы устройства), но сохранение «из будущего» — подделка
    if (typeof at !== 'number' || !Number.isFinite(at) || at > now + 60_000 || now - at > ROUND_TTL_MS) return null;
    return r;
  } catch {
    return null;
  }
}

function write(key: string, value: Stored): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ v: 1, savedAt: Date.now(), ...value }));
  } catch {
    // приватный режим / переполнение — игра продолжается, просто без сохранения
  }
}

function remove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ничего не делаем
  }
}

/**
 * Короткая подпись геометрии уровня (двор, асыки, камни, число бросков). Если уровень изменился в новой
 * версии игры, сохранение со старой расстановкой не подходит: асыки могли бы оказаться внутри нового камня.
 */
export function layoutSignature(layout: KonLayout, throws = 0): string {
  const s = JSON.stringify([layout.zone, layout.obstacles ?? [], layout.asyks.map((a) => [a.x, a.y, a.angle ?? 0, a.kind ?? 'asyk']), throws]);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

/** Все номера асыков расстановки по одному разу и ровно столько, сколько выбито по счёту. */
function asyksMatch(raw: unknown, count: number, knocked: number): MatchSyncState['asyks'] | null {
  const asyks = parseAsykStates(raw);
  if (!asyks || asyks.length !== count) return null;
  if (asyks.some((a) => a[0] >= count)) return null; // номера уникальны (проверено разбором) и в пределах расстановки
  const out = asyks.filter((a) => a[4] === 0).length;
  return out === knocked ? asyks : null;
}

// ——— одиночное испытание ———

export function saveSoloRound(level: LevelConfig, state: MatchSyncState): void {
  write(SOLO_KEY, { levelId: level.id, sig: layoutSignature(level, level.throws), state });
}

/** Сохранённый раунд этого испытания или null (нет, устарел, чужое или изменившееся испытание, повреждён). */
export function loadSoloRound(level: LevelConfig, now = Date.now()): MatchSyncState | null {
  const r = readRaw(SOLO_KEY, now);
  if (!r || r.levelId !== level.id || r.sig !== layoutSignature(level, level.throws)) return null;
  const st = r.state as Stored | null;
  if (typeof st !== 'object' || st === null) return null;
  const rules = parseSoloState(st.rules, level);
  if (!rules) return null;
  const asyks = asyksMatch(st.asyks, level.asyks.length, rules.knocked);
  return asyks ? { asyks, rules } : null;
}

/**
 * Испытание со временем: между бросками записываем, сколько времени уже прошло, иначе перезагрузка страницы
 * «возвращала» бы секунды, потраченные на прицеливание после последнего броска. Меняет только сохранённый
 * раунд этого же испытания; если сохранения ещё нет (первый бросок не сделан), ничего не делает.
 */
export function updateSoloElapsed(level: LevelConfig, elapsedMs: number, now = Date.now()): void {
  if (!level.timeLimit) return;
  const r = readRaw(SOLO_KEY, now);
  if (!r || r.levelId !== level.id || r.sig !== layoutSignature(level, level.throws)) return;
  const st = r.state as Stored | null;
  const rules = st && typeof st === 'object' ? (st.rules as Stored | null) : null;
  if (!st || !rules || typeof rules !== 'object') return;
  const clamped = Math.max(0, Math.min(Math.round(elapsedMs), level.timeLimit * 1000 - 1));
  // время только растёт (не откатываем при запоздалом вызове)
  if (typeof rules.elapsedMs === 'number' && rules.elapsedMs >= clamped) return;
  write(SOLO_KEY, { levelId: r.levelId, sig: r.sig, state: { ...st, rules: { ...rules, elapsedMs: clamped } } });
}

export function clearSoloRound(): void {
  remove(SOLO_KEY);
}

// ——— матч вдвоём на одном устройстве ———

export function saveDuelRound(config: MatchConfig, state: MatchSyncState): void {
  write(DUEL_KEY, { config, sig: layoutSignature(getMatchLayout(config.layoutId)), state });
}

export interface StoredDuel {
  config: MatchConfig;
  state: MatchSyncState;
}

const KNOWN_LAYOUTS = new Set(MATCH_LAYOUTS.map((l) => l.id));

/** Сохранённый матч или null. Состояние «матч окончен» не сохраняется и не принимается. */
export function loadDuelRound(now = Date.now()): StoredDuel | null {
  const r = readRaw(DUEL_KEY, now);
  if (!r) return null;
  const parsed = parseMatchConfig(r.config);
  // на одном устройстве играют ровно двое; состав онлайн-матча (ids) здесь не нужен
  if (!parsed || !KNOWN_LAYOUTS.has(parsed.layoutId) || parsed.players.length !== 2 || parsed.ids) return null;
  // «Передайте устройство» — настройка одиночной игры: parseMatchConfig намеренно не принимает её из сети
  const config: MatchConfig = (r.config as Stored).handoff === true ? { ...parsed, handoff: true } : parsed;

  const layout = getMatchLayout(config.layoutId);
  if (r.sig !== layoutSignature(layout)) return null;
  const st = r.state as Stored | null;
  if (typeof st !== 'object' || st === null) return null;
  const count = layout.asyks.length;
  const rules = parseMatchState(st.rules, count, 2);
  if (!rules || rules.finished || rules.total < 1) return null;
  const asyks = asyksMatch(st.asyks, count, rules.knocked[0] + rules.knocked[1]);
  return asyks ? { config, state: { asyks, rules } } : null;
}

export function clearDuelRound(): void {
  remove(DUEL_KEY);
}

export function clearAllRounds(): void {
  clearSoloRound();
  clearDuelRound();
}
