import type { MatchSyncState } from '../game/engine/GameEngine';
import type { MatchConfig, Seat } from '../game/types';
import { cleanName } from '../ui/format';
import { LIMITS } from './limits';
import { CLIENT_ID_RE } from './protocol';
import { MAX_PLAYERS } from '../game/rules/matchState';
import { int, isKnownLayout, parseMatchConfig, parseStoredSyncState } from './validate';

/**
 * Сессия игрока в комнате — в sessionStorage вкладки. Нужна, чтобы после перезагрузки
 * страницы или потери связи игрок вернулся на своё место и в свой матч.
 */
export interface RoomSession {
  clientId: string;
  /** Место в комнате: 0 — хозяин, 1–3 — гости; null — гость ещё не занял место (только что вошёл). */
  seat: Seat | null;
  name: string;
  /** Кон следующего матча: хозяин выбирает его при создании комнаты и меняет в комнате ожидания (у гостя пусто). */
  layoutId: string;
  /**
   * Последний матч (после старта). state — последний снимок кона и счёта (после каждого броска): перезагрузка
   * не обнуляет матч; done — игрок вышел из итогов в комнату ожидания (после перезагрузки он снова там).
   */
  match: { config: MatchConfig; matchId: number; state?: MatchSyncState; done?: boolean } | null;
}

const key = (code: string) => `asyk-atu:room:${code}`;

/** Размер сохранённой сессии, который мы согласны разбирать (реальная — единицы килобайт). */
const SESSION_MAX_CHARS = 200_000;

/**
 * Чтение сессии комнаты. sessionStorage можно подделать через консоль, поэтому каждое поле проходит
 * ту же проверку, что и сообщение из сети: формат id, место, известный кон, конфиг матча и снимок состояния.
 * Подделанная часть отбрасывается, а не «чинится».
 */
export function loadRoomSession(code: string): RoomSession | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(key(code));
    if (!raw || raw.length > SESSION_MAX_CHARS) return null;
    const s = JSON.parse(raw) as unknown;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return null;
    const r = s as Record<string, unknown>;
    if (typeof r.clientId !== 'string' || !CLIENT_ID_RE.test(r.clientId)) return null;
    const seat = r.seat === null ? null : int(r.seat, 0, MAX_PLAYERS - 1);
    if (seat === null && r.seat !== null) return null;
    let match: RoomSession['match'] = null;
    if (typeof r.match === 'object' && r.match !== null) {
      const m = r.match as Record<string, unknown>;
      const config = parseMatchConfig(m.config);
      const matchId = int(m.matchId, 1, LIMITS.maxMatchId);
      if (config && matchId !== null) {
        match = { config, matchId };
        const state = m.state === undefined ? null : parseStoredSyncState(m.state, config.layoutId, config.players.length);
        if (state) match.state = state;
        if (m.done === true) match.done = true;
      }
    }
    return {
      clientId: r.clientId,
      seat: seat as Seat | null,
      name: cleanName(r.name, seat === 0 ? 'Хозяин' : 'Гость'),
      layoutId: isKnownLayout(r.layoutId) ? r.layoutId : '',
      match,
    };
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
