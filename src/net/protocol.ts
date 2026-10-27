import type { MatchSyncState } from '../game/engine/GameEngine';
import type { ThrowChunk, ThrowEnd, ThrowStart } from '../game/replay/throwRecord';
import type { MatchConfig, Seat } from '../game/types';

/**
 * Протокол онлайн-матча. Все сообщения идут через broadcast-канал комнаты Supabase Realtime.
 * Сервер ничего не считает: он только пересылает сообщения остальным игрокам комнаты (2–4 игрока).
 */
export type NetMessage =
  /** Хост бросил жребий: матч начинается. */
  | { t: 'start'; config: MatchConfig; matchId: number }
  /** Прицел бросающего (≈12 раз в секунду), null — прицел отменён. */
  | { t: 'aim'; a: { angle: number; power: number } | null }
  | { t: 'throwStart'; s: ThrowStart }
  | { t: 'throwChunk'; c: ThrowChunk }
  | { t: 'throwEnd'; e: ThrowEnd }
  /** Полное состояние матча — для переподключившегося или отставшего игрока. */
  | { t: 'sync'; config: MatchConfig; matchId: number; state: MatchSyncState }
  | { t: 'syncRequest' }
  /**
   * Ход игрока, который не в сети, пропущен (матч на 3–4 игрока). Получатели проверяют сами: это текущий ход,
   * игрок действительно давно молчит; иначе сообщение игнорируется.
   */
  | { t: 'skip'; seat: Seat; /** номер броска: сделано бросков + 1 (одинаков у всех игроков) */ turnId: number }
  /** Готов к реваншу (у двоих — предложение и согласие; хозяин начинает, когда готовы все в сети). */
  | { t: 'rematch' }
  | { t: 'rematchAccept' }
  /** Игрок сам вышел из матча. */
  | { t: 'leave' };

/** Что каждый игрок сообщает о себе через presence. */
export interface PeerInfo {
  clientId: string;
  /** Место за «столом» комнаты: 0 — хозяин, 1–3 — гости. */
  seat: Seat;
  name: string;
  /** Игрок сейчас в матче: новичок не занимает место и ждёт конца матча. */
  busy?: boolean;
}

export interface Envelope {
  from: string;
  msg: NetMessage;
}

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I/L

/**
 * Длина кода комнаты. Код — единственный «секрет» комнаты (по нему открывается канал), поэтому он длинный:
 * 31^10 ≈ 8·10^14 вариантов (≈ 49 бит). Перебрать такое число каналов нереально.
 */
export const ROOM_CODE_LENGTH = 10;

export type RandomBytes = (n: number) => Uint8Array;

/** Криптостойкие случайные байты браузера (не Math.random: тот предсказуем по нескольким выходам). */
export const cryptoBytes: RandomBytes = (n) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
};

/**
 * Код комнаты: символы выбираются из криптостойкого источника без смещения
 * (байты ≥ 248 отбрасываются, чтобы остаток от деления на 31 был равномерным).
 */
export function makeRoomCode(bytes: RandomBytes = cryptoBytes): string {
  const limit = 256 - (256 % ROOM_ALPHABET.length);
  let s = '';
  while (s.length < ROOM_CODE_LENGTH) {
    for (const b of bytes(ROOM_CODE_LENGTH * 2)) {
      if (b < limit) {
        s += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
        if (s.length === ROOM_CODE_LENGTH) break;
      }
    }
  }
  return s;
}

/** Приводит введённый или пришедший по ссылке код к каноническому виду; неверный код → null. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => ROOM_ALPHABET.includes(c)) ? code : null;
}

/**
 * Код комнаты из того, что игрок ввёл или вставил: сам код (с дефисом, пробелами, строчными буквами),
 * ссылка на комнату (`…#/room/ABCDEFGHJK`) или фраза с кодом («Комната ABCDE-FGHJK»).
 * Ничего не открывает и не исполняет — только ищет 10 допустимых символов; неверный ввод → null.
 */
export function parseRoomCodeInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.slice(0, 300); // огромные вставки не разбираем
  const direct = normalizeRoomCode(text);
  if (direct) return direct;
  const link = /\/room\/([A-Za-z0-9-]{4,24})/.exec(text);
  if (link) return normalizeRoomCode(link[1]);
  // два блока по 5 символов, отделённых дефисом, пробелом или слитно, не внутри длинного слова
  const block = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]{5})[-\s]?([A-Za-z0-9]{5})(?![A-Za-z0-9])/.exec(text);
  return block ? normalizeRoomCode(block[1] + block[2]) : null;
}

/** Код для показа человеку: ABCDE-FGHJK. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, ROOM_CODE_LENGTH / 2)}-${code.slice(ROOM_CODE_LENGTH / 2)}`;
}

export const CLIENT_ID_RE = /^[0-9a-f]{16}$/;

export function makeClientId(bytes: RandomBytes = cryptoBytes): string {
  return Array.from(bytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
}
