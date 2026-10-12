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
  | { name: 'MATCH' }
  | { name: 'ROOM'; code: string };

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
    case 'MATCH':
      return '#/duel/play';
    case 'ROOM':
      return `#/room/${r.code}`;
  }
}

export function hashToRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'how-to-play') return { name: 'HOW_TO' };
  if (h === 'levels') return { name: 'LEVEL_SELECT' };
  if (h === 'records') return { name: 'RECORDS' };
  if (h === 'about') return { name: 'ABOUT' };
  if (h === 'duel') return { name: 'MATCH_SETUP' };
  if (h === 'duel/play') return { name: 'MATCH' };
  const room = /^room\/([A-Za-z0-9-]{4,12})$/.exec(h);
  if (room) {
    const code = normalizeRoomCode(room[1]);
    if (code) return { name: 'ROOM', code };
  }
  const m = /^play\/([a-z0-9-]+)$/.exec(h);
  if (m) return { name: 'PLAYING', levelId: m[1] };
  return { name: 'MENU' };
}
