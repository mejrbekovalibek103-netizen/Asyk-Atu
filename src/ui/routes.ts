import { normalizeRoomCode } from '../net/protocol';

/**
 * Экраны приложения (верхний уровень машины состояний).
 * Синхронизируются с hash в адресе — работает кнопка «Назад» в браузере и на Android.
 *
 * Фазы внутри игры (READY → AIMING → THROWING → RESOLVING → ROUND_COMPLETE)
 * живут в GameEngine, а итоговый экран (RESULT) — это оверлей поверх игры.
 */
export type Route =
  | { name: 'MENU' }
  | { name: 'HOW_TO' }
  | { name: 'LEVEL_SELECT' }
  | { name: 'PLAYING'; levelId: string }
  | { name: 'RECORDS' }
  | { name: 'ABOUT' }
  | { name: 'MATCH_SETUP' }
  | { name: 'ONLINE_SETUP' }
  | { name: 'COLLECTION' }
  | { name: 'MATCH' }
  | { name: 'ROOM'; code: string }
  /** Соревновательный режим «на асыки»: создать матч или войти по коду. */
  | { name: 'COMP_SETUP' }
  /** Соревновательный матч по коду (как comp_matches.join_code). */
  | { name: 'COMP'; code: string };

/** Код соревновательного матча: 10 символов без похожих 0/O, 1/I/L (как join_code в базе). */
export const COMP_CODE_RE = /^[A-HJKMNP-Z2-9]{10}$/;

/** Код матча из адреса или ввода: регистр не важен, дефис и пробелы убираются; неверный код → null. */
export function normalizeCompCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return COMP_CODE_RE.test(code) ? code : null;
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'MENU':
      return '#/';
    case 'HOW_TO':
      return '#/how-to-play';
    case 'LEVEL_SELECT':
      return '#/levels';
    case 'PLAYING':
      return `#/play/${r.levelId}`;
    case 'RECORDS':
      return '#/records';
    case 'ABOUT':
      return '#/about';
    case 'MATCH_SETUP':
      return '#/duel';
    case 'ONLINE_SETUP':
      return '#/online';
    case 'COLLECTION':
      return '#/collection';
    case 'MATCH':
      return '#/duel/play';
    case 'ROOM':
      return `#/room/${r.code}`;
    case 'COMP_SETUP':
      return '#/comp';
    case 'COMP':
      return `#/comp/${r.code}`;
  }
}

/**
 * Возврат со страницы входа Google: в адресе сайта одноразовый код (`?code=…`) или ошибка (`?error=…`),
 * а # нет. Такой адрес ведёт на экран коллекции — там код обменивается на сессию.
 * Возвращает null, если это обычное открытие сайта; `error` — вход не удался.
 */
export function oauthReturn(search: string, hash: string): { error: boolean } | null {
  if (hash.replace(/^#\/?/, '') !== '') return null;
  const q = new URLSearchParams(search);
  if (q.has('error') || q.has('error_description')) return { error: true };
  return q.has('code') ? { error: false } : null;
}

export function hashToRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'how-to-play') return { name: 'HOW_TO' };
  if (h === 'levels') return { name: 'LEVEL_SELECT' };
  if (h === 'records') return { name: 'RECORDS' };
  if (h === 'about') return { name: 'ABOUT' };
  if (h === 'duel') return { name: 'MATCH_SETUP' };
  if (h === 'online') return { name: 'ONLINE_SETUP' };
  if (h === 'collection') return { name: 'COLLECTION' };
  if (h === 'duel/play') return { name: 'MATCH' };
  const room = /^room\/([A-Za-z0-9-]{4,24})$/.exec(h);
  if (room) {
    const code = normalizeRoomCode(room[1]);
    if (code) return { name: 'ROOM', code };
  }
  if (h === 'comp') return { name: 'COMP_SETUP' };
  const comp = /^comp\/([A-Za-z0-9-]{4,24})$/.exec(h);
  if (comp) {
    const code = normalizeCompCode(comp[1]);
    return code ? { name: 'COMP', code } : { name: 'COMP_SETUP' };
  }
  const m = /^play\/([a-z0-9-]+)$/.exec(h);
  if (m) return { name: 'PLAYING', levelId: m[1] };
  return { name: 'MENU' };
}

/**
 * Куда вернуть игрока после входа через Google. Google возвращает на адрес сайта без # (см. oauthReturn),
 * поэтому нужный экран (например, матч по ссылке `#/comp/<код>`) запоминается в sessionStorage вкладки
 * перед уходом на страницу входа и забирается один раз после возврата.
 */
const PENDING_ROUTE_KEY = 'asyk-atu:after-login';
/** Дольше этого вход не длится: старая запись (вкладка ушла на Google и не вернулась) не уводит игрока. */
export const PENDING_ROUTE_TTL_MS = 30 * 60_000;

export function savePendingRoute(r: Route, now = Date.now()): void {
  try {
    globalThis.sessionStorage?.setItem(PENDING_ROUTE_KEY, JSON.stringify({ h: routeToHash(r), at: now }));
  } catch {
    // приватный режим — после входа откроется экран по умолчанию
  }
}

export function clearPendingRoute(): void {
  try {
    globalThis.sessionStorage?.removeItem(PENDING_ROUTE_KEY);
  } catch {
    // нечего убирать
  }
}

/**
 * Забрать сохранённый экран (запись сразу удаляется). Запись проходит обычный разбор адреса: подделка через консоль
 * даёт в худшем случае другой экран игры. Нет записи, она устарела или ведёт в меню → null.
 */
export function takePendingRoute(now = Date.now()): Route | null {
  let raw: string | null = null;
  try {
    raw = globalThis.sessionStorage?.getItem(PENDING_ROUTE_KEY) ?? null;
  } catch {
    return null;
  }
  clearPendingRoute();
  if (!raw || raw.length > 200) return null;
  try {
    const v = JSON.parse(raw) as { h?: unknown; at?: unknown };
    if (typeof v !== 'object' || v === null || typeof v.h !== 'string' || typeof v.at !== 'number') return null;
    if (!Number.isFinite(v.at) || now - v.at > PENDING_ROUTE_TTL_MS || v.at - now > 60_000) return null;
    const r = hashToRoute(v.h);
    return r.name === 'MENU' ? null : r;
  } catch {
    return null;
  }
}
