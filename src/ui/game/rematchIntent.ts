/**
 * «Реванш» после матча на асыки: игрок уже согласился играть снова на тех же правилах. Лобби следующего матча
 * (другой код, новый экран) по этой отметке само ставит его 5 асыков, а у хозяина — само бросает жребий,
 * как только вернулась и поставила вся прежняя компания (поэтому в отметке есть число игроков). «В комнату» отметку не ставит: там всё вручную, хозяин может сменить кон.
 * Отметка живёт в sessionStorage этой вкладки и снимается при первом чтении.
 */
const KEY = 'asyk-comp-rematch';

export function markRematchIntent(code: string, players: number): void {
  try {
    sessionStorage.setItem(KEY, `${code}:${players}`);
  } catch {
    // приватный режим без хранилища: реванш просто пройдёт вручную
  }
}

/** Отметка «Реванш» для этого матча: сколько игроков было в прошлом (и снять её); null — отметки нет. */
export function takeRematchIntent(code: string): number | null {
  try {
    const [marked, n] = (sessionStorage.getItem(KEY) ?? '').split(':');
    if (marked !== code) return null;
    sessionStorage.removeItem(KEY);
    const players = Number(n);
    return players >= 2 && players <= 4 ? Math.floor(players) : 2;
  } catch {
    return null;
  }
}
