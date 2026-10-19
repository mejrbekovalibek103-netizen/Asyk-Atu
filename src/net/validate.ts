import type { MatchSyncState } from '../game/engine/GameEngine';
import { MATCH_LAYOUTS } from '../game/levels/matchLayouts';
import type { AsykState } from '../game/physics/PhysicsWorld';
import type { ReplayEvent, ThrowChunk, ThrowEnd, ThrowStart } from '../game/replay/throwRecord';
import { parseMatchState } from '../game/rules/matchState';
import type { MatchConfig, Seat } from '../game/types';
import { cleanName } from '../ui/format';
import { LIMITS } from './limits';
import { CLIENT_ID_RE, type Envelope, type NetMessage, type PeerInfo } from './protocol';

/**
 * Проверка входящих данных. Всё, что приходит по сети, — недоверенный ввод: сообщение может быть
 * от модифицированного клиента. Каждая функция возвращает НОВЫЙ объект, собранный из проверенных
 * полей (лишние поля и прототипы не переносятся), либо null.
 *
 * Правила: тип, диапазон, размер, конечность чисел (NaN и Infinity ломают физику).
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

export function int(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

const coord = (v: unknown) => num(v, LIMITS.coordMin, LIMITS.coordMax);

const KNOWN_LAYOUTS = new Set(MATCH_LAYOUTS.map((l) => l.id));

/** Известный id кона (иначе подставить кон по умолчанию нельзя — отвергаем сообщение). */
export function isKnownLayout(id: unknown): id is string {
  return typeof id === 'string' && KNOWN_LAYOUTS.has(id);
}

function layoutAsykCount(layoutId: string): number {
  return MATCH_LAYOUTS.find((l) => l.id === layoutId)?.asyks.length ?? LIMITS.maxAsyks;
}

export function parseMatchConfig(raw: unknown): MatchConfig | null {
  if (!isObj(raw) || !isKnownLayout(raw.layoutId)) return null;
  const players = raw.players;
  if (!Array.isArray(players) || players.length !== 2) return null;
  const first = raw.first;
  if (first !== 0 && first !== 1) return null;
  const cfg: MatchConfig = {
    layoutId: raw.layoutId,
    players: [cleanName(players[0], 'Игрок 1'), cleanName(players[1], 'Игрок 2')],
    first: first as Seat,
  };
  if (raw.rematch === true) cfg.rematch = true;
  return cfg;
}

export function parsePeer(raw: unknown): PeerInfo | null {
  if (!isObj(raw)) return null;
  const { clientId, seat, name } = raw;
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) return null;
  if (seat !== 0 && seat !== 1) return null;
  return { clientId, seat, name: cleanName(name, seat === 0 ? 'Хозяин' : 'Гость') };
}

export function parseAsykState(raw: unknown): AsykState | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const [i, x, y, a, inZone] = raw as unknown[];
  const index = int(i, 0, LIMITS.maxAsyks - 1);
  const px = coord(x);
  const py = coord(y);
  const pa = num(a, -LIMITS.maxBodyAngle, LIMITS.maxBodyAngle);
  if (index === null || px === null || py === null || pa === null) return null;
  if (inZone !== 0 && inZone !== 1) return null;
  return [index, px, py, pa, inZone];
}

export function parseAsykStates(raw: unknown): AsykState[] | null {
  if (!Array.isArray(raw) || raw.length > LIMITS.maxAsyks) return null;
  const out: AsykState[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const s = parseAsykState(item);
    if (!s || seen.has(s[0])) return null; // повтор номера асыка — подделка
    seen.add(s[0]);
    out.push(s);
  }
  return out;
}

export function parseThrowStart(raw: unknown): ThrowStart | null {
  if (!isObj(raw)) return null;
  const throwIndex = int(raw.throwIndex, 1, LIMITS.maxThrows);
  const angle = num(raw.angle, -LIMITS.maxAimAngle, LIMITS.maxAimAngle);
  const power = num(raw.power, 0, 1);
  return throwIndex === null || angle === null || power === null ? null : { throwIndex, angle, power };
}

function parseEvent(raw: unknown): ReplayEvent | null {
  if (!isObj(raw)) return null;
  const s = int(raw.s, 0, LIMITS.maxSteps);
  if (s === null) return null;
  if (raw.t === 'k') {
    const i = int(raw.i, 0, LIMITS.maxAsyks - 1);
    return i === null ? null : { s, t: 'k', i };
  }
  if (raw.t === 'c') {
    const x = coord(raw.x);
    const y = coord(raw.y);
    const i = num(raw.i, 0, LIMITS.maxImpact);
    const k = int(raw.k, 0, 2);
    return x === null || y === null || i === null || k === null ? null : { s, t: 'c', x, y, i, k };
  }
  return null;
}

export function parseThrowChunk(raw: unknown): ThrowChunk | null {
  if (!isObj(raw)) return null;
  const seq = int(raw.seq, 0, LIMITS.maxChunksPerThrow - 1);
  if (seq === null) return null;
  const rawFrames = raw.frames;
  const rawEvents = raw.events;
  if (!Array.isArray(rawFrames) || rawFrames.length > LIMITS.maxFramesPerChunk) return null;
  if (!Array.isArray(rawEvents) || rawEvents.length > LIMITS.maxEventsPerChunk) return null;
  const frames: ThrowChunk['frames'] = [];
  for (const f of rawFrames) {
    if (!isObj(f)) return null;
    const s = int(f.s, 0, LIMITS.maxSteps);
    const b = f.b;
    // кадр: [индекс, x, y, угол] × число тел (асыки + сақа)
    if (s === null || !Array.isArray(b) || b.length % 4 !== 0 || b.length > (LIMITS.maxAsyks + 1) * 4) return null;
    const out: number[] = [];
    for (let k = 0; k < b.length; k += 4) {
      const idx = int(b[k], -1, LIMITS.maxAsyks - 1);
      const x = coord(b[k + 1]);
      const y = coord(b[k + 2]);
      const a = num(b[k + 3], -LIMITS.maxBodyAngle, LIMITS.maxBodyAngle);
      if (idx === null || x === null || y === null || a === null) return null;
      out.push(idx, x, y, a);
    }
    frames.push({ s, b: out });
  }
  const events: ReplayEvent[] = [];
  for (const e of rawEvents) {
    const ev = parseEvent(e);
    if (!ev) return null;
    events.push(ev);
  }
  return { seq, frames, events };
}

export function parseThrowEnd(raw: unknown): ThrowEnd | null {
  if (!isObj(raw)) return null;
  const steps = int(raw.steps, 1, LIMITS.maxSteps);
  const final = parseAsykStates(raw.final);
  if (steps === null || !final) return null;
  let saka: ThrowEnd['saka'] = null;
  if (raw.saka !== null) {
    if (!Array.isArray(raw.saka) || raw.saka.length !== 3) return null;
    const x = coord(raw.saka[0]);
    const y = coord(raw.saka[1]);
    const a = num(raw.saka[2], -LIMITS.maxBodyAngle, LIMITS.maxBodyAngle);
    if (x === null || y === null || a === null) return null;
    saka = [x, y, a];
  }
  return { steps, final, saka };
}

function parseSyncState(raw: unknown, layoutId: string): MatchSyncState | null {
  if (!isObj(raw)) return null;
  const asyks = parseAsykStates(raw.asyks);
  const total = layoutAsykCount(layoutId);
  if (!asyks || asyks.some((a) => a[0] >= total)) return null;
  const rules = parseMatchState(raw.rules, total);
  return rules ? { asyks, rules } : null;
}

/** Проверка снимка, сохранённого в sessionStorage (расстановка известна по id кона). */
export function parseStoredSyncState(raw: unknown, layoutId: string): MatchSyncState | null {
  return parseSyncState(raw, layoutId);
}

/** Разбор одного сообщения. null — сообщение недопустимо и должно быть отброшено. */
export function parseNetMessage(raw: unknown): NetMessage | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'start': {
      const config = parseMatchConfig(raw.config);
      const matchId = int(raw.matchId, 1, LIMITS.maxMatchId);
      return config && matchId !== null ? { t: 'start', config, matchId } : null;
    }
    case 'aim': {
      if (raw.a === null) return { t: 'aim', a: null };
      if (!isObj(raw.a)) return null;
      const angle = num(raw.a.angle, -LIMITS.maxAimAngle, LIMITS.maxAimAngle);
      const power = num(raw.a.power, 0, 1);
      return angle === null || power === null ? null : { t: 'aim', a: { angle, power } };
    }
    case 'throwStart': {
      const s = parseThrowStart(raw.s);
      return s ? { t: 'throwStart', s } : null;
    }
    case 'throwChunk': {
      const c = parseThrowChunk(raw.c);
      return c ? { t: 'throwChunk', c } : null;
    }
    case 'throwEnd': {
      const e = parseThrowEnd(raw.e);
      return e ? { t: 'throwEnd', e } : null;
    }
    case 'sync': {
      const config = parseMatchConfig(raw.config);
      const matchId = int(raw.matchId, 1, LIMITS.maxMatchId);
      if (!config || matchId === null) return null;
      const state = parseSyncState(raw.state, config.layoutId);
      return state ? { t: 'sync', config, matchId, state } : null;
    }
    case 'syncRequest':
    case 'rematch':
    case 'rematchAccept':
    case 'leave':
      return { t: raw.t };
    default:
      return null;
  }
}

/** Разбор конверта: отправитель (id клиента) и сообщение. */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (!isObj(raw)) return null;
  const { from } = raw;
  if (typeof from !== 'string' || !CLIENT_ID_RE.test(from)) return null;
  const msg = parseNetMessage(raw.msg);
  return msg ? { from, msg } : null;
}
