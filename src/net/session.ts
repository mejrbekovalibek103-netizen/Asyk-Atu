import type { MatchConfig, Seat } from '../game/types';

/**
 * Сессия игрока в комнате — в sessionStorage вкладки. Нужна, чтобы после перезагрузки
 * страницы или потери связи игрок вернулся на своё место и в свой матч.
 */
export interface RoomSession {
  clientId: string;
  seat: Seat;
  name: string;
  /** Кон, выбранный хостом при создании комнаты. */
  layoutId: string;
  /** Текущий матч (после старта). */
  match: { config: MatchConfig; matchId: number } | null;
}

const key = (code: string) => `asyk-atu:room:${code}`;

export function loadRoomSession(code: string): RoomSession | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(key(code));
    if (!raw) return null;
    const s = JSON.parse(raw) as RoomSession;
    if (!s || typeof s.clientId !== 'string' || (s.seat !== 0 && s.seat !== 1)) return null;
    return { clientId: s.clientId, seat: s.seat, name: String(s.name ?? ''), layoutId: String(s.layoutId ?? ''), match: s.match ?? null };
  } catch {
    return null;
  }
}

export function saveRoomSession(code: string, s: RoomSession): void {
  try {
    globalThis.sessionStorage?.setItem(key(code), JSON.stringify(s));
  } catch {
    // приватный режим — без восстановления после перезагрузки
  }
}
