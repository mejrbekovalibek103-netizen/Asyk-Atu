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

/** Короткий код комнаты, удобный для диктовки: 6 символов ≈ 900 млн вариантов. */
export function makeRoomCode(rnd: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[Math.floor(rnd() * ROOM_ALPHABET.length)];
  return s;
}

export function normalizeRoomCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 6 && [...code].every((c) => ROOM_ALPHABET.includes(c)) ? code : null;
}

export function makeClientId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
