/**
 * «Реванш» после матча на асыки: игрок уже согласился играть снова на тех же правилах. Лобби следующего матча
 * (другой код, новый экран) по этой отметке само ставит его 5 асыков, а у хозяина — само бросает жребий,
 * как только оба поставили. «В комнату» отметку не ставит: там всё вручную, хозяин может сменить кон.
 * Отметка живёт в sessionStorage этой вкладки и снимается при первом чтении.
 */
const KEY = 'asyk-comp-rematch';

export function markRematchIntent(code: string): void {
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    // приватный режим без хранилища: реванш просто пройдёт вручную
  }
}

/** Была ли отметка «Реванш» для этого матча (и снять её). */
export function takeRematchIntent(code: string): boolean {
  try {
    if (sessionStorage.getItem(KEY) !== code) return false;
    sessionStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
