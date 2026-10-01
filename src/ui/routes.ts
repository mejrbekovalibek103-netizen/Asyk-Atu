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
  | { name: 'ABOUT' };

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
  }
}

export function hashToRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'how-to-play') return { name: 'HOW_TO' };
  if (h === 'levels') return { name: 'LEVEL_SELECT' };
  if (h === 'records') return { name: 'RECORDS' };
  if (h === 'about') return { name: 'ABOUT' };
  const m = /^play\/([a-z0-9-]+)$/.exec(h);
  if (m) return { name: 'PLAYING', levelId: m[1] };
  return { name: 'MENU' };
}
