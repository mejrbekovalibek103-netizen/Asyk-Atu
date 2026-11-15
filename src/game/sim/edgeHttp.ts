import type { ThrowChunk, ThrowEnd, ThrowStart } from '../replay/throwRecord';
import { validateThrowBody, type BodyCheck, type ThrowBody } from './edgeEntry';

/**
 * Чистая HTTP-логика Edge Function `comp-throw`: CORS, чтение и разбор тела, токен, ключ из окружения,
 * коды ответов и разбиение записи броска на сообщения Realtime. Без Deno и без сети — поэтому покрыта тестами
 * vitest, а в функцию попадает через sim.js (edgeEntry реэкспортирует всё отсюда).
 */

/**
 * Сайты, с которых браузер может звать функцию (origin — без пути и без «/» в конце).
 * Плюс любой порт localhost (см. LOCAL_DEV_ORIGIN ниже). Адреса LAN (`npm run dev:lan`, http://192.168.x.x:5173) сюда не входят:
 * живую проверку с телефона делаем на опубликованном сайте (supabase/README.md, 5.4).
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://mejrbekovalibek103-netizen.github.io',
  'https://asyk-atu.onrender.com',
];

/**
 * Локальная разработка: http://localhost или http://127.0.0.1 на ЛЮБОМ порту (Vite берёт следующий свободный —
 * 5173, 5174, 5176…). Это безопасно: CORS не защищает от самого игрока, а сессия игрока хранится отдельно
 * для каждого адреса, и чужой сайт до неё не дотянется. Защиту бросков держат токен и проверки базы.
 */
const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;

/** Тело запроса броска — несколько чисел и uuid; всё, что больше 1 КБ, даже не читаем до конца. */
export const MAX_BODY_BYTES = 1024;

/** Заголовки, которые шлёт supabase-js (functions.invoke) и fetch с токеном. */
const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type, x-region';

export function isAllowedOrigin(origin: string | null | undefined): origin is string {
  return typeof origin === 'string' && (ALLOWED_ORIGINS.includes(origin) || LOCAL_DEV_ORIGIN.test(origin));
}

/**
 * Заголовки CORS для ответа. Разрешённому сайту — его origin (не «*»), чужому — ничего: браузер сам не отдаст
 * ответ странице. `Vary: Origin` — чтобы промежуточный кэш не перепутал ответы для разных сайтов.
 */
export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  if (!isAllowedOrigin(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '7200',
    Vary: 'Origin',
  };
}

/**
 * Можно ли обслужить запрос с таким Origin. Без заголовка Origin (curl, проверка владельца) — можно: CORS защищает
 * только браузер, а токен игрока функция проверяет всегда. Чужой сайт — отказ.
 */
export function originPermitted(origin: string | null | undefined): boolean {
  return origin === null || origin === undefined || isAllowedOrigin(origin);
}

/** Токен из `Authorization: Bearer <jwt>`; без пробелов внутри и разумной длины. Иначе null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1];
  return token.length >= 20 && token.length <= 8192 ? token : null;
}

/** Алгоритмы подписи токенов входа Supabase (старый общий секрет и новые асимметричные ключи). */
const JWT_ALGS: ReadonlySet<string> = new Set(['HS256', 'ES256', 'RS256', 'EdDSA']);
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function decodeJwtPart(part: string): unknown {
  if (!B64URL_RE.test(part)) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Дешёвая проверка токена до сетевого запроса в Auth: три части base64url, известный alg, не просрочен,
 * role и aud — authenticated, есть sub. Подпись здесь НЕ проверяется — это делает auth.getUser дальше;
 * задача — не тратить запрос в Auth на мусор и просроченные токены. `nowSec` — секунды Unix.
 */
export function jwtLooksValid(token: string, nowSec: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0) || !B64URL_RE.test(parts[2])) return false;
  const head = decodeJwtPart(parts[0]);
  if (!isRecord(head) || typeof head.alg !== 'string' || !JWT_ALGS.has(head.alg)) return false;
  const body = decodeJwtPart(parts[1]);
  if (!isRecord(body)) return false;
  if (!isNum(body.exp) || body.exp <= nowSec) return false;
  if (body.role !== 'authenticated') return false;
  const aud = body.aud;
  if (!(aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated')))) return false;
  return typeof body.sub === 'string' && body.sub.length > 0;
}

export type BodyRead = { ok: true; text: string } | { ok: false; error: 'too_large' | 'bad_body' };

/**
 * Читает тело не больше `max` байт: поток обрывается, как только предел превышен (большой запрос не держит
 * память и время функции). Не UTF-8 — bad_body.
 */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, max = MAX_BODY_BYTES): Promise<BodyRead> {
  if (!body) return { ok: false, error: 'bad_body' };
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, error: 'too_large' };
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: 'bad_body' };
  }
}

/** Заголовок Content-Length обещает тело больше предела — отказ сразу, не читая тело. */
export function declaredTooLarge(header: string | null | undefined, max = MAX_BODY_BYTES): boolean {
  if (typeof header !== 'string' || !/^\d+$/.test(header.trim())) return false;
  return Number(header.trim()) > max;
}

/** Разбор тела `{ matchId, throwNo, angle, power }`: не JSON — bad_body, дальше строгая validateThrowBody. */
export function parseThrowRequest(text: string): BodyCheck {
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: 'too_large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'bad_body' };
  }
  return validateThrowBody(raw);
}

/**
 * Служебный ключ Supabase из окружения функции. Сначала `SUPABASE_SERVICE_ROLE_KEY` (старый ключ service_role),
 * иначе `SUPABASE_SECRET_KEYS` — JSON с новыми ключами sb_secret_ (объект «имя → ключ», берётся `default`
 * или первый; допускается массив или одна строка). Ключ нигде не печатается и не возвращается.
 */
export function serviceKeyFromEnv(get: (name: string) => string | undefined): string | null {
  const direct = get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if (direct) return direct;
  const raw = get('SUPABASE_SECRET_KEYS')?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (typeof parsed === 'string') return pick(parsed);
  if (Array.isArray(parsed)) {
    for (const v of parsed) if (pick(v)) return pick(v);
    return null;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (pick(obj.default)) return pick(obj.default);
    for (const v of Object.values(obj)) if (pick(v)) return pick(v);
  }
  return null;
}

/** Коды ошибок, которые функция отдаёт клиенту, и их HTTP-статусы. Всё неизвестное — 'server' (500). */
const STATUS: Record<string, number> = {
  bad_request: 400,
  bad_body: 422,
  bad_match: 422,
  bad_throw_no: 422,
  bad_angle: 422,
  bad_power: 422,
  not_signed_in: 401,
  origin: 403,
  banned: 403,
  no_profile: 403,
  google_required: 403,
  not_member: 403,
  not_found: 404,
  method: 405,
  not_active: 409,
  forfeited: 409,
  not_your_turn: 409,
  stale_throw: 409,
  deadline: 409,
  pending: 409,
  not_pending: 409,
  version: 410,
  too_large: 413,
  rate_limited: 429,
  config: 503,
};

const known = (code: string) => Object.prototype.hasOwnProperty.call(STATUS, code);

export function errorStatus(code: string): number {
  return known(code) ? STATUS[code] : 500;
}

/**
 * Код ошибки из ответа базы (supabase-js: error.message = текст `raise exception`). Известный код —
 * как есть; ошибки данных броска (bad_final, resurrection, …) и всё прочее — 'server': виноват сервер, не игрок.
 */
export function dbErrorCode(err: { message?: unknown } | null | undefined): string {
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  return known(msg) && msg !== 'config' && msg !== 'origin' && msg !== 'method' ? msg : 'server';
}

/** Запись броска сервера в канале матча, событие 'srv' (docs/competitive-mode.md, 7.4). */
export type SrvPayload =
  | { k: 'start'; throwNo: number; angle: number; power: number }
  | ({ k: 'chunk'; throwNo: number } & ThrowChunk)
  | ({ k: 'end'; throwNo: number; knocked: number[] } & ThrowEnd);

/** Части записи по порядку: start, chunk × N (по seq), end вместе со списком выбитых слотов. */
export function srvPayloads(run: { start: ThrowStart; chunks: ThrowChunk[]; end: ThrowEnd; knocked: number[] }, throwNo: number): SrvPayload[] {
  const out: SrvPayload[] = [{ k: 'start', throwNo, angle: run.start.angle, power: run.start.power }];
  for (const c of [...run.chunks].sort((a, b) => a.seq - b.seq)) {
    out.push({ k: 'chunk', throwNo, seq: c.seq, frames: c.frames, events: c.events });
  }
  out.push({ k: 'end', throwNo, steps: run.end.steps, final: run.end.final, saka: run.end.saka, knocked: [...run.knocked] });
  return out;
}

/** Закрытый канал матча, куда сервер шлёт запись (клиентам писать туда broadcast запрещено политикой). */
export function compTopic(matchId: string): string {
  return `comp:${matchId.toLowerCase()}`;
}

export interface BroadcastMessage {
  topic: string;
  event: 'srv';
  payload: SrvPayload;
  private: true;
}

export interface BroadcastBody {
  messages: BroadcastMessage[];
}

/**
 * Пределы Realtime. Сообщение бесплатного тарифа — до 256 КБ, берём с запасом; число сообщений в секунду на
 * проект тоже ограничено (100 на бесплатном), поэтому запросы небольшие и уходят с паузой (BROADCAST_PAUSE_MS).
 */
export const BROADCAST_LIMITS = { maxMessageBytes: 200_000, maxBatchBytes: 60_000, maxBatchMessages: 20 };
/** Пауза между запросами рассылки: 20 сообщений раз в 250 мс — 80 в секунду. */
export const BROADCAST_PAUSE_MS = 250;

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/**
 * Разбивает запись на тела запросов `POST /realtime/v1/api/broadcast`, сохраняя порядок. Каждый запрос — не больше
 * maxBatchMessages сообщений и maxBatchBytes байт (одно большое сообщение идёт отдельным запросом).
 * Сообщение больше maxMessageBytes Realtime не пропустит — оно выбрасывается и попадает в `dropped`
 * (соперник тогда возьмёт итог кона из базы, клиент ждёт запись не дольше 3 с).
 */
export function broadcastBatches(
  topic: string,
  payloads: SrvPayload[],
  limits: typeof BROADCAST_LIMITS = BROADCAST_LIMITS,
): { batches: BroadcastBody[]; dropped: number } {
  const batches: BroadcastBody[] = [];
  let cur: BroadcastMessage[] = [];
  let curBytes = 0;
  let dropped = 0;
  for (const payload of payloads) {
    const msg: BroadcastMessage = { topic, event: 'srv', payload, private: true };
    const size = byteLength(JSON.stringify(msg));
    if (size > limits.maxMessageBytes) {
      dropped += 1;
      continue;
    }
    if (cur.length > 0 && (cur.length >= limits.maxBatchMessages || curBytes + size > limits.maxBatchBytes)) {
      batches.push({ messages: cur });
      cur = [];
      curBytes = 0;
    }
    cur.push(msg);
    curBytes += size + 1;
  }
  if (cur.length) batches.push({ messages: cur });
  return { batches, dropped };
}

/** Ответ comp_begin_throw, проверенный и сведённый к входу броска. */
export interface ThrowContext {
  /** true — этот бросок уже записан (повтор запроса после обрыва связи): угол, сила и кон — из базы. */
  replay: boolean;
  /** Секрет матча в hex — только для computeServerThrow, нигде не печатается. */
  seedHex: string;
  layoutId: string;
  players: number;
  simVersion: number;
  /** Запрошенный угол (до разброса): из запроса или, при повторе, сохранённый. */
  angle: number;
  power: number;
  /** kon_state до броска ровно как пришёл из базы (null — начальная раскладка); его же получает comp_apply_throw. */
  konBefore: unknown;
  /** При повторе — выбитые слоты из базы (для сверки с пересчётом), иначе null. */
  replayKnocked: number[] | null;
}

export type ContextCheck = { ok: true; value: ThrowContext } | { ok: false; error: 'bad_context' };

const SEED_RE = /^(?:\\x|0x)?(?:[0-9a-f]{2}){16,}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Разбирает ответ comp_begin_throw. Форма: `{ replay: null | last_throw, seed, kon_state, layout_id, players,
 * sim_version, throw_no, … }`. Ответ базы тоже проверяется: не та форма — 'bad_context' (ошибка сервера, не игрока).
 * Сами угол, сила и кон дальше ещё раз строго проверит computeServerThrow.
 */
export function throwContext(raw: unknown, body: ThrowBody): ContextCheck {
  const bad: ContextCheck = { ok: false, error: 'bad_context' };
  if (!isRecord(raw)) return bad;
  const { seed, layout_id, players, sim_version, throw_no, replay } = raw;
  if (typeof seed !== 'string' || !SEED_RE.test(seed)) return bad;
  if (typeof layout_id !== 'string' || !isInt(players) || !isInt(sim_version)) return bad;
  if (throw_no !== body.throwNo) return bad;
  // ключ обязан быть: отсутствие kon_state не должно молча вернуть кон в начальную раскладку
  if (!('kon_state' in raw) || (raw.kon_state !== null && !Array.isArray(raw.kon_state))) return bad;
  const base = { seedHex: seed, layoutId: layout_id, players, simVersion: sim_version, konBefore: raw.kon_state };
  if (replay === null || replay === undefined) {
    return { ok: true, value: { ...base, replay: false, angle: body.angle, power: body.power, replayKnocked: null } };
  }
  if (!isRecord(replay) || replay.throw_no !== body.throwNo || !isNum(replay.angle) || !isNum(replay.power)) return bad;
  const knocked = replay.knocked;
  if (!Array.isArray(knocked) || !knocked.every(isInt)) return bad;
  return { ok: true, value: { ...base, replay: true, angle: replay.angle, power: replay.power, replayKnocked: [...knocked] } };
}

/** Совпадают ли выбитые слоты как множества (порядок выбивания в базе не хранится — там они по возрастанию). */
export function sameSlots(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}
