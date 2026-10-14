import type { MatchSyncState } from '../game/engine/GameEngine';
import type { ThrowChunk, ThrowEnd, ThrowStart } from '../game/replay/throwRecord';
import type { MatchConfig, Seat } from '../game/types';

/**
 * Протокол онлайн-матча. Все сообщения идут через broadcast-канал комнаты Supabase Realtime.
 * Сервер ничего не считает: он только пересылает сообщения второму игроку.
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
  /** Предложение реванша и согласие. */
  | { t: 'rematch' }
  | { t: 'rematchAccept' }
  /** Игрок сам вышел из матча. */
  | { t: 'leave' };

/** Что каждый игрок сообщает о себе через presence. */
export interface PeerInfo {
  clientId: string;
  seat: Seat;
  name: string;
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

/** Код для показа человеку: ABCDE-FGHJK. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, ROOM_CODE_LENGTH / 2)}-${code.slice(ROOM_CODE_LENGTH / 2)}`;
}

export const CLIENT_ID_RE = /^[0-9a-f]{16}$/;

export function makeClientId(bytes: RandomBytes = cryptoBytes): string {
  return Array.from(bytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
}
