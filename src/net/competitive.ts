import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PHYS } from '../game/config';
import { isStakeLayout, type StakeLayoutId } from '../game/levels/matchLayouts';
import type { AsykState } from '../game/physics/PhysicsWorld';
import type { ThrowChunk, ThrowEnd, ThrowStart } from '../game/replay/throwRecord';
import { SIM_VERSION } from '../game/sim/version';
import { cleanName } from '../ui/format';
import { normalizeCompCode } from '../ui/routes';
import { getSupabase } from './client';
import { onlineAvailable } from './config';
import { LIMITS, RateLimiter } from './limits';
import { CLIENT_ID_RE, makeClientId, parseRoomCodeInput } from './protocol';
import { int, num, parseAsykState, parseThrowChunk, parseThrowEnd, parseThrowStart } from './validate';

/**
 * Сеть соревновательного режима «на асыки» (docs/competitive-mode.md, разделы 0.1 и 7).
 *
 * Здесь решает сервер: банк (Postgres, функции comp_*) и судья (Edge Function comp-throw). Клиент только
 * просит («поставить», «бросить под таким углом», «пропустить ход отсутствующего») и показывает ответ.
 * Поэтому всё, что приходит из сети, — недоверенный ввод: ответы базы, функции и канала проходят строгий разбор
 * (тип, диапазон, размер), а при отказе разбора данные отбрасываются, а не «чинятся».
 *
 * Каналы Realtime матча (оба закрытые, слушать могут только участники — политики в supabase/competitive.sql):
 * - `comp:<id>` — запись броска от сервера (broadcast 'srv'), присутствие и postgres_changes строки матча;
 *   клиенту broadcast сюда запрещён, подделать 'srv' нельзя;
 * - `comp-aim:<id>` — линия прицела (broadcast 'aim'), это только картинка.
 * comp_players в публикацию Realtime не входит: о смене состава говорит comp_matches.players_rev.
 * Запасной путь — опрос comp_state каждые 5 с.
 */

// ——— общие проверки ———

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Игроков в матче (схема готова к 3–4, первая версия — 2). */
const MAX_COMP_PLAYERS = 4;
/** Номер броска: в матче их не больше 15 × 2 (пропуски тоже занимают номер), предел с запасом — как у сервера. */
const MAX_THROW_NO = 9_999;
/** Целые счётчики из базы (броски, выбитые, ревизия состава). */
const MAX_COUNTER = 2_147_483_647;
/** Асыков в матче на асыки: 5 · игроков, не больше 20. */
const MAX_KON = 5 * MAX_COMP_PLAYERS;
/** Самый маленький разрешённый запрошенный бросок (PHYS.minSlide / PHYS.maxSlide), как проверяет сервер. */
export const COMP_MIN_POWER = PHYS.minSlide / PHYS.maxSlide;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Время из базы: ISO (`2026-11-13T10:00:00.123456+00:00`, так jsonb отдаёт timestamptz) или текст Postgres
 * (`2026-11-13 10:00:01.123456+00`, так приходит detail у too_early). → миллисекунды эпохи; иначе null.
 * Свой разбор, а не Date.parse: браузеры по-разному понимают формат с пробелом и микросекундами.
 */
export function parseDbTime(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const off = Number(digits.slice(0, 2)) * 60 + (digits.length > 2 ? Number(digits.slice(2, 4)) : 0);
    if (off > 18 * 60) return null;
    t -= sign * off * 60_000;
  }
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 60) return null;
  return Number.isFinite(t) ? t : null;
}

/** Поле времени: null разрешён; не время и не null → undefined (ответ испорчен). */
function timeOrNull(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  const t = parseDbTime(v);
  return t === null ? undefined : t;
}

/** Целое или null; не то и не другое → undefined. */
function intOrNull(v: unknown, lo: number, hi: number): number | null | undefined {
  if (v === null || v === undefined) return null;
  const n = int(v, lo, hi);
  return n === null ? undefined : n;
}

/** Массив целых без повторов (слоты, id асыков). Не массив, мусор или повтор → null. */
function intList(v: unknown, lo: number, hi: number, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = int(x, lo, hi);
    if (n === null || out.includes(n)) return null;
    out.push(n);
  }
  return out;
}

/**
 * Состояние кона из базы (kon_state, kon_before): ровно `count` записей [слот, x, y, угол, 1|0], слот k на месте k.
 * null — исходная раскладка. Неверная форма → undefined.
 */
export function parseCompKon(raw: unknown, count: number): AsykState[] | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length !== count || count < 1 || count > MAX_KON) return undefined;
  const out: AsykState[] = [];
  for (let k = 0; k < count; k++) {
    const s = parseAsykState(raw[k]);
    if (!s || s[0] !== k) return undefined;
    out.push(s);
  }
  return out;
}

// ——— ошибки ———

/**
 * Коды ошибок: из базы (текст `raise exception`), из функции comp-throw и свои (сеть, разбор ответа).
 * Список — для подсказок редактора; неизвестный код сервера превращается в 'server'.
 */
export const COMP_ERROR_TEXT = {
  // вход и аккаунт
  not_signed_in: 'Войди через Google.',
  google_required: 'Нужен вход через Google.',
  no_profile: 'Профиль не создан. Открой «Мою коллекцию».',
  banned: 'Аккаунт заблокирован.',
  forbidden: 'Нет доступа.',
  // создание и вход в матч
  bad_layout: 'Такого кона нет.',
  bad_client_id: 'Сбой вкладки. Обнови страницу.',
  already_in_match: 'Ты уже в другом матче.',
  rate_limited: 'Слишком часто. Подожди минуту.',
  busy: 'Сервер занят. Попробуй ещё раз.',
  bad_code: 'Неверный код.',
  not_found: 'Матч не найден.',
  kicked: 'Хозяин тебя исключил.',
  not_forming: 'Матч уже начался.',
  expired: 'Время лобби вышло.',
  full: 'Мест нет.',
  not_member: 'Ты не в этом матче.',
  not_over: 'Матч ещё идёт.',
  // лобби
  not_host: 'Это может только хозяин.',
  bad_slot: 'Такого игрока нет.',
  not_enough: 'Не хватает свободных асыков.',
  not_staked: 'Сначала поставь асыки.',
  not_enough_players: 'Нужен соперник со ставкой.',
  stake_mismatch: 'Ставки не сошлись. Попробуй ещё раз.',
  not_ready_stage: 'Проверка готовности уже прошла.',
  // ход
  not_active: 'Матч не идёт.',
  stale_throw: 'Ход уже сменился.',
  pending: 'Бросок ещё считается.',
  too_early: 'Пропускать ход ещё рано.',
  forfeited: 'Ты сдался в этом матче.',
  not_your_turn: 'Сейчас не твой ход.',
  deadline: 'Время хода вышло.',
  version: 'Игра обновилась. Обнови страницу.',
  bad_throw: 'Так бросить нельзя.',
  // свои
  bad_request: 'Неверный запрос.',
  network: 'Нет связи. Проверь интернет.',
  timeout: 'Сервер не отвечает. Попробуй ещё раз.',
  bad_response: 'Сервер ответил непонятно. Обнови страницу.',
  setup: 'Режим ещё не настроен на сервере.',
  unavailable: 'Онлайн выключен в этой сборке.',
  server: 'Сбой сервера. Попробуй ещё раз.',
} as const;

export type CompErrorCode = keyof typeof COMP_ERROR_TEXT;

const isCode = (v: unknown): v is CompErrorCode => typeof v === 'string' && Object.prototype.hasOwnProperty.call(COMP_ERROR_TEXT, v);

/** Ошибки разбора броска от функции (bad_angle, bad_power, bad_body…) показываются одним текстом. */
const THROW_INPUT_CODES = new Set(['bad_body', 'bad_match', 'bad_throw_no', 'bad_angle', 'bad_power', 'too_large', 'bad_input']);

export class CompError extends Error {
  readonly code: CompErrorCode;
  /** Подробность от базы: join_code текущего матча (already_in_match), число свободных (not_enough), время (too_early). */
  readonly detail: string | null;

  constructor(code: CompErrorCode, detail: string | null = null) {
    super(code);
    this.name = 'CompError';
    this.code = code;
    this.detail = detail;
  }

  /** Короткий текст для игрока. */
  get text(): string {
    if (this.code === 'not_enough' && this.detail !== null && /^\d{1,2}$/.test(this.detail)) return `Свободных асыков: ${this.detail}, нужно 5.`;
    return COMP_ERROR_TEXT[this.code];
  }

  /** Код матча, в котором игрок уже состоит (already_in_match), — для ссылки «Вернуться в матч». */
  get joinCode(): string | null {
    return this.code === 'already_in_match' ? normalizeCompCode(this.detail) : null;
  }

  /** Время из detail у too_early (мс эпохи) или null. */
  get notBefore(): number | null {
    return this.code === 'too_early' ? parseDbTime(this.detail) : null;
  }
}

/** Код ошибки из ответа сервера (база или функция). Неизвестный — 'server'. */
export function compCodeFrom(raw: unknown): CompErrorCode {
  if (typeof raw !== 'string') return 'server';
  const c = raw.trim();
  if (THROW_INPUT_CODES.has(c)) return 'bad_throw';
  return isCode(c) ? c : 'server';
}

/**
 * Ошибка PostgREST (supabase.rpc) → CompError. message — код из `raise exception` (если он нам известен),
 * code — SQLSTATE. Нет функции в базе (скрипт не выполнен) — 'setup'; нет права на функцию — 'forbidden';
 * ошибка без кода и без ответа сервера — сеть.
 */
export function compErrorFromDb(err: { message?: unknown; code?: unknown; details?: unknown } | null | undefined): CompError {
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  const details = typeof err?.details === 'string' && err.details.length <= 200 ? err.details : null;
  if (isCode(message)) return new CompError(message, details);
  if (code === 'PGRST202' || code === '42883' || code === '42P01' || code === 'PGRST205') return new CompError('setup');
  if (code === '42501') return new CompError('forbidden');
  if (code === '28000') return new CompError('not_signed_in');
  if (!code) return new CompError('network');
  return new CompError('server');
}

/** Текст для игрока из любой ошибки (CompError — свой текст, остальное — «нет связи»). */
export function compErrorText(e: unknown): string {
  return e instanceof CompError ? e.text : COMP_ERROR_TEXT.network;
}

// ——— состояние матча (comp_state) ———

export const COMP_STATUSES = ['forming', 'ready', 'active', 'settled', 'cancelled', 'void'] as const;
export type CompStatus = (typeof COMP_STATUSES)[number];

export const COMP_END_REASONS = [
  'cleared',
  'throws_out',
  'all_forfeited',
  'stale',
  'server',
  'version',
  'host_left',
  'left',
  'not_ready',
  'lobby_expired',
] as const;
export type CompEndReason = (typeof COMP_END_REASONS)[number];

const isStatus = (v: unknown): v is CompStatus => typeof v === 'string' && (COMP_STATUSES as readonly string[]).includes(v);
/** Причина конца: неизвестная (сервер новее клиента) — null, а не отказ всего ответа. */
const endReason = (v: unknown): CompEndReason | null => (typeof v === 'string' && (COMP_END_REASONS as readonly string[]).includes(v) ? (v as CompEndReason) : null);

/** Матч окончен: асыки розданы или возвращены. */
export function isCompOver(status: CompStatus): boolean {
  return status === 'settled' || status === 'cancelled' || status === 'void';
}

/** Последний бросок (comp_matches.last_throw). */
export interface CompLastThrow {
  throwNo: number;
  seat: number;
  /** Запрошенный угол и сила (до разброса). */
  angle: number;
  power: number;
  /** Кон до броска (null — исходная раскладка). */
  konBefore: AsykState[] | null;
  /** Слоты, выбитые этим броском. */
  knocked: number[];
  steps: number;
}

/** Матч. Все времена — миллисекунды эпохи по часам сервера (см. serverNow). */
export interface CompMatch {
  id: string;
  joinCode: string;
  layoutId: StakeLayoutId;
  simVersion: number;
  status: CompStatus;
  /** Игроков в матче (заполняется на старте), до старта null. */
  players: number | null;
  maxPlayers: number;
  stakeSize: number;
  /** Асыков в коне (5 · игроков; до старта — 5 · текущее число). */
  konSize: number;
  throwsPerPlayer: number;
  turnSeconds: number;
  /** Чей ход (место), null — до старта и после конца. */
  currentSeat: number | null;
  /** Последний занятый номер броска; следующий бросок — throwNo + 1. */
  throwNo: number;
  /** Кон после последнего броска; null — исходная раскладка. */
  konState: AsykState[] | null;
  lastThrow: CompLastThrow | null;
  /** Начало и конец хода (уже сдвинуты на время показа прошлого броска). */
  turnStartedAt: number | null;
  turnDeadline: number | null;
  /** С этого момента можно пропустить ход отсутствующего (начало хода + 20 с; ещё нужен пульс старше 15 с). */
  skipAbsentAt: number | null;
  /** С этого момента можно пропустить любой ход (дедлайн + 5 с). */
  skipAt: number | null;
  /** forming — срок жизни лобби, ready — срок «Я здесь». */
  readyDeadline: number | null;
  /** Сервер принял бросок и считает его. */
  pending: boolean;
  pendingAt: number | null;
  /** Растёт при каждом изменении состава (вход, ставка, «Я здесь», выход, сдача, счёт). */
  playersRev: number;
  createdAt: number | null;
  startedAt: number | null;
  settledAt: number | null;
  endReason: CompEndReason | null;
  /** Реванш: код следующего матча той же компании (пока в него можно войти или он идёт), иначе null. */
  nextCode: string | null;
}

export interface CompMe {
  lobbySlot: number | null;
  /** Место в матче (назначается жребием при старте), до старта null. */
  seat: number | null;
  isHost: boolean;
  staked: boolean;
  ready: boolean;
  forfeited: boolean;
  /** id моих асыков в коне этого матча. */
  stakedIds: number[];
}

export interface CompPlayer {
  lobbySlot: number;
  seat: number | null;
  /** Имя из лобби (очищено ещё раз). */
  name: string;
  isHost: boolean;
  isMe: boolean;
  staked: boolean;
  ready: boolean;
  forfeited: boolean;
  active: boolean;
  /** Израсходованные ходы (бросок, пропуск, сбой). */
  throws: number;
  realThrows: number;
  knocked: number;
  bestCombo: number;
  skipsInRow: number;
  /** Сколько мс назад был пульс (на момент ответа), null — не было. */
  seenAgoMs: number | null;
  /** Пульс моложе 15 с. */
  online: boolean;
}

/** Асык в коне: чей он, кто и каким броском его выбил. */
export interface CompSlot {
  /** Индекс асыка в раскладке (= Piece.index). */
  slot: number;
  ownerSeat: number;
  knockedBySeat: number | null;
  knockedThrow: number | null;
  mine: boolean;
  /** id асыка — только у своих. */
  asykId: number | null;
}

/** Итог для меня: какие слоты выиграл, какие вернулись, какие ушли; delta — изменение коллекции. */
export interface CompOutcome {
  /** Ставки возвращены (матч отменён или аннулирован). */
  refunded: boolean;
  won: number[];
  returned: number[];
  lost: number[];
  delta: number;
}

export interface CompState {
  /** Серверное время ответа (мс эпохи). */
  now: number;
  /** Местное время получения (Date.now()): вместе с now даёт сдвиг часов (serverNow). */
  receivedAt: number;
  match: CompMatch;
  me: CompMe;
  players: CompPlayer[];
  slots: CompSlot[];
  result: CompOutcome | null;
}

/** Серверное «сейчас» по последнему ответу базы (сдвиг часов устройства не важен). */
export function serverNow(state: Pick<CompState, 'now' | 'receivedAt'>, localNow = Date.now()): number {
  return state.now + (localNow - state.receivedAt);
}

/** Момент по часам сервера → местное время (для таймеров). */
export function toLocalTime(state: Pick<CompState, 'now' | 'receivedAt'>, serverTime: number): number {
  return serverTime - state.now + state.receivedAt;
}

/** Секунд до конца хода по часам сервера (не меньше 0), null — хода нет. */
export function turnSecondsLeft(state: CompState, localNow = Date.now()): number | null {
  if (state.match.status !== 'active' || state.match.turnDeadline === null) return null;
  return Math.max(0, Math.ceil((state.match.turnDeadline - serverNow(state, localNow)) / 1000));
}

/** Сейчас мой ход (матч идёт, место моё, я не сдался). */
export function isMyTurn(state: CompState): boolean {
  return state.match.status === 'active' && state.me.seat !== null && state.match.currentSeat === state.me.seat && !state.me.forfeited;
}

function parseLastThrow(raw: unknown, konSize: number): CompLastThrow | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw)) return undefined;
  const throwNo = int(raw.throw_no, 1, MAX_THROW_NO);
  const seat = int(raw.seat, 0, MAX_COMP_PLAYERS - 1);
  const angle = num(raw.angle, -LIMITS.maxAimAngle, LIMITS.maxAimAngle);
  const power = num(raw.power, 0, 1);
  const konBefore = parseCompKon(raw.kon_before, konSize);
  const knocked = intList(raw.knocked, 0, konSize - 1, konSize);
  const steps = int(raw.steps, 0, LIMITS.maxSteps * 3);
  if (throwNo === null || seat === null || angle === null || power === null || konBefore === undefined || !knocked || steps === null) return undefined;
  return { throwNo, seat, angle, power, konBefore, knocked, steps };
}

function parseMatch(raw: unknown): CompMatch | null {
  if (!isObj(raw)) return null;
  const id = isUuid(raw.id) ? raw.id.toLowerCase() : null;
  const joinCode = normalizeCompCode(raw.join_code);
  const layoutId = isStakeLayout(raw.layout_id) ? raw.layout_id : null;
  const simVersion = int(raw.sim_version, 0, 1_000_000);
  const status = isStatus(raw.status) ? raw.status : null;
  const players = intOrNull(raw.players, 2, MAX_COMP_PLAYERS);
  const maxPlayers = int(raw.max_players, 2, MAX_COMP_PLAYERS);
  const stakeSize = int(raw.stake_size, 1, 10);
  const konSize = int(raw.kon_size, 0, MAX_KON);
  const throwsPerPlayer = int(raw.throws_per_player, 1, 100);
  const turnSeconds = int(raw.turn_seconds, 1, 600);
  const currentSeat = intOrNull(raw.current_seat, 0, MAX_COMP_PLAYERS - 1);
  const throwNo = int(raw.throw_no, 0, MAX_THROW_NO);
  const playersRev = raw.players_rev === undefined ? 0 : int(raw.players_rev, 0, MAX_COUNTER);
  const pending = bool(raw.pending);
  // поля next_code нет у старой базы — значит, реванша нет
  const nextCode = raw.next_code === undefined || raw.next_code === null ? null : normalizeCompCode(raw.next_code);
  if (
    nextCode === undefined ||
    (raw.next_code !== undefined && raw.next_code !== null && !nextCode) ||
    !id ||
    !joinCode ||
    !layoutId ||
    simVersion === null ||
    !status ||
    players === undefined ||
    maxPlayers === null ||
    stakeSize === null ||
    konSize === null ||
    throwsPerPlayer === null ||
    turnSeconds === null ||
    currentSeat === undefined ||
    throwNo === null ||
    playersRev === null ||
    pending === null
  )
    return null;
  // после старта кон — ровно ставка · игроки
  if (players !== null && konSize !== players * stakeSize) return null;
  const konState = konSize > 0 ? parseCompKon(raw.kon_state, konSize) : raw.kon_state === null || raw.kon_state === undefined ? null : undefined;
  const lastThrow = konSize > 0 ? parseLastThrow(raw.last_throw, konSize) : raw.last_throw === null || raw.last_throw === undefined ? null : undefined;
  if (konState === undefined || lastThrow === undefined) return null;
  const times = {
    turnStartedAt: timeOrNull(raw.turn_started_at),
    turnDeadline: timeOrNull(raw.turn_deadline),
    skipAbsentAt: timeOrNull(raw.skip_absent_at),
    skipAt: timeOrNull(raw.skip_at),
    readyDeadline: timeOrNull(raw.ready_deadline),
    pendingAt: timeOrNull(raw.pending_at),
    createdAt: timeOrNull(raw.created_at),
    startedAt: timeOrNull(raw.started_at),
    settledAt: timeOrNull(raw.settled_at),
  };
  for (const v of Object.values(times)) if (v === undefined) return null;
  const t = times as { [K in keyof typeof times]: number | null };
  return {
    id,
    joinCode,
    layoutId,
    simVersion,
    status,
    players,
    maxPlayers,
    stakeSize,
    konSize,
    throwsPerPlayer,
    turnSeconds,
    currentSeat,
    throwNo,
    konState,
    lastThrow,
    ...t,
    pending,
    playersRev,
    endReason: endReason(raw.end_reason),
    nextCode: nextCode ?? null,
  };
}

function parseMe(raw: unknown): CompMe | null {
  if (!isObj(raw)) return null;
  const lobbySlot = intOrNull(raw.lobby_slot, 0, MAX_COMP_PLAYERS - 1);
  const seat = intOrNull(raw.seat, 0, MAX_COMP_PLAYERS - 1);
  const isHost = bool(raw.is_host);
  const staked = bool(raw.staked);
  const ready = bool(raw.ready);
  const forfeited = bool(raw.forfeited);
  const stakedIds = intList(raw.staked_ids, 1, Number.MAX_SAFE_INTEGER, 10);
  if (lobbySlot === undefined || seat === undefined || isHost === null || staked === null || ready === null || forfeited === null || !stakedIds) return null;
  return { lobbySlot, seat, isHost, staked, ready, forfeited, stakedIds };
}

function parsePlayer(raw: unknown): CompPlayer | null {
  if (!isObj(raw)) return null;
  const lobbySlot = int(raw.lobby_slot, 0, MAX_COMP_PLAYERS - 1);
  const seat = intOrNull(raw.seat, 0, MAX_COMP_PLAYERS - 1);
  const flags = {
    isHost: bool(raw.is_host),
    isMe: bool(raw.is_me),
    staked: bool(raw.staked),
    ready: bool(raw.ready),
    forfeited: bool(raw.forfeited),
    active: bool(raw.active),
    online: bool(raw.online),
  };
  const counters = {
    throws: int(raw.throws, 0, MAX_COUNTER),
    realThrows: int(raw.real_throws, 0, MAX_COUNTER),
    knocked: int(raw.knocked, 0, MAX_COUNTER),
    bestCombo: int(raw.best_combo, 0, MAX_COUNTER),
    skipsInRow: int(raw.skips_in_row, 0, MAX_COUNTER),
  };
  const seenAgoMs = intOrNull(raw.seen_ago_ms, 0, Number.MAX_SAFE_INTEGER);
  if (lobbySlot === null || seat === undefined || seenAgoMs === undefined) return null;
  if (Object.values(flags).some((v) => v === null) || Object.values(counters).some((v) => v === null)) return null;
  return {
    lobbySlot,
    seat,
    name: cleanName(raw.name, lobbySlot === 0 ? 'Хозяин' : 'Гость'),
    ...(flags as { [K in keyof typeof flags]: boolean }),
    ...(counters as { [K in keyof typeof counters]: number }),
    seenAgoMs,
  };
}

function parseSlot(raw: unknown, konSize: number): CompSlot | null {
  if (!isObj(raw)) return null;
  const slot = int(raw.slot, 0, konSize - 1);
  const ownerSeat = int(raw.owner_seat, 0, MAX_COMP_PLAYERS - 1);
  const knockedBySeat = intOrNull(raw.knocked_by_seat, 0, MAX_COMP_PLAYERS - 1);
  const knockedThrow = intOrNull(raw.knocked_throw, 1, MAX_THROW_NO);
  const mine = bool(raw.mine);
  const asykId = intOrNull(raw.asyk_id, 1, Number.MAX_SAFE_INTEGER);
  if (slot === null || ownerSeat === null || knockedBySeat === undefined || knockedThrow === undefined || mine === null || asykId === undefined) return null;
  return { slot, ownerSeat, knockedBySeat, knockedThrow, mine, asykId };
}

function parseOutcome(raw: unknown, konSize: number): CompOutcome | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw)) return undefined;
  const refunded = bool(raw.refunded);
  const won = intList(raw.won, 0, MAX_KON - 1, MAX_KON);
  const returned = intList(raw.returned, 0, MAX_KON - 1, MAX_KON);
  const lost = intList(raw.lost, 0, MAX_KON - 1, MAX_KON);
  const delta = int(raw.delta, -MAX_KON, MAX_KON);
  if (refunded === null || !won || !returned || !lost || delta === null) return undefined;
  const limit = Math.max(konSize, 1);
  if ([...won, ...returned, ...lost].some((s) => s >= limit)) return undefined;
  return { refunded, won, returned, lost, delta };
}

/**
 * Разбор CompState (ответ comp_state, comp_rebind, comp_start, comp_ready, comp_skip, comp_forfeit, comp_settle_stale).
 * Любая неверная часть → null: состояние матча нельзя показывать «наполовину».
 */
export function parseCompState(raw: unknown, receivedAt = Date.now()): CompState | null {
  if (!isObj(raw)) return null;
  const now = parseDbTime(raw.now);
  const match = parseMatch(raw.match);
  const me = parseMe(raw.me);
  if (now === null || !match || !me) return null;
  if (!Array.isArray(raw.players) || raw.players.length > MAX_COMP_PLAYERS) return null;
  const players: CompPlayer[] = [];
  for (const p of raw.players) {
    const pl = parsePlayer(p);
    if (!pl || players.some((x) => x.lobbySlot === pl.lobbySlot || (pl.seat !== null && x.seat === pl.seat))) return null;
    players.push(pl);
  }
  if (players.filter((p) => p.isMe).length > 1) return null;
  if (!Array.isArray(raw.slots) || raw.slots.length > match.konSize) return null;
  const slots: CompSlot[] = [];
  for (const s of raw.slots) {
    const sl = parseSlot(s, match.konSize);
    if (!sl || slots.some((x) => x.slot === sl.slot)) return null;
    slots.push(sl);
  }
  const result = parseOutcome(raw.result, match.konSize);
  if (result === undefined) return null;
  return { now, receivedAt, match, me, players, slots, result };
}

// ——— создание и вход ———

export interface CompOpenResult {
  matchId: string;
  joinCode: string;
  lobbySlot: number;
}

export interface CompJoinResult extends CompOpenResult {
  status: CompStatus;
}

export function parseOpenResult(raw: unknown): CompOpenResult | null {
  if (!isObj(raw)) return null;
  const joinCode = normalizeCompCode(raw.join_code);
  const lobbySlot = int(raw.lobby_slot, 0, MAX_COMP_PLAYERS - 1);
  if (!isUuid(raw.match_id) || !joinCode || lobbySlot === null) return null;
  return { matchId: raw.match_id.toLowerCase(), joinCode, lobbySlot };
}

export function parseJoinResult(raw: unknown): CompJoinResult | null {
  const base = parseOpenResult(raw);
  if (!base || !isObj(raw) || !isStatus(raw.status)) return null;
  return { ...base, status: raw.status };
}

/**
 * Код матча из того, что игрок ввёл или вставил: код (с дефисом, пробелами, строчными), ссылка `…#/comp/<код>`
 * или фраза с кодом. Только ищет 10 допустимых символов; неверный ввод → null.
 */
export function parseCompCodeInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.slice(0, 300);
  const direct = normalizeCompCode(text.trim());
  if (direct) return direct;
  const link = /\/comp\/([A-Za-z0-9-]{4,24})/.exec(text);
  if (link) return normalizeCompCode(link[1]);
  const any = parseRoomCodeInput(text);
  return any ? normalizeCompCode(any) : null;
}

// ——— история ———

export interface CompHistoryEntry {
  matchId: string;
  status: 'settled' | 'void';
  endReason: CompEndReason | null;
  layoutId: string;
  players: number | null;
  startedAt: number | null;
  settledAt: number | null;
  mySeat: number | null;
  forfeited: boolean;
  knocked: number;
  realThrows: number;
  bestCombo: number;
  /** Сколько асыков получил и сколько отдал в этом матче. */
  won: number;
  lost: number;
  /** Имена соперников. */
  opponents: string[];
}

/** Разбор my_comp_history. Не массив → null; испорченные записи пропускаются. */
export function parseCompHistory(raw: unknown): CompHistoryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CompHistoryEntry[] = [];
  for (const r of raw.slice(0, 50)) {
    if (!isObj(r) || !isUuid(r.match_id) || (r.status !== 'settled' && r.status !== 'void')) continue;
    const players = intOrNull(r.players, 2, MAX_COMP_PLAYERS);
    const startedAt = timeOrNull(r.started_at);
    const settledAt = timeOrNull(r.settled_at);
    const mySeat = intOrNull(r.my_seat, 0, MAX_COMP_PLAYERS - 1);
    const forfeited = bool(r.forfeited);
    const knocked = int(r.knocked, 0, MAX_COUNTER);
    const realThrows = int(r.real_throws, 0, MAX_COUNTER);
    const bestCombo = int(r.best_combo, 0, MAX_COUNTER);
    const won = int(r.won, 0, MAX_KON);
    const lost = int(r.lost, 0, MAX_KON);
    if (players === undefined || startedAt === undefined || settledAt === undefined || mySeat === undefined) continue;
    if (forfeited === null || knocked === null || realThrows === null || bestCombo === null || won === null || lost === null) continue;
    if (!Array.isArray(r.opponents) || r.opponents.length > MAX_COMP_PLAYERS) continue;
    out.push({
      matchId: r.match_id.toLowerCase(),
      status: r.status,
      endReason: endReason(r.end_reason),
      layoutId: isStakeLayout(r.layout_id) ? r.layout_id : 'stake-line',
      players,
      startedAt,
      settledAt,
      mySeat,
      forfeited,
      knocked,
      realThrows,
      bestCombo,
      won,
      lost,
      opponents: r.opponents.map((n) => cleanName(n, 'Соперник')),
    });
  }
  return out;
}

// ——— вызовы базы ———

const CLIENT_KEY = 'asyk-atu:comp:client';
let memoryClientId: string | null = null;

/**
 * id этой вкладки для матча на асыки (presence key и comp_*.p_client_id). Хранится в sessionStorage:
 * после перезагрузки вкладка остаётся той же, а вторая вкладка получает свой id (последняя вкладка побеждает — comp_rebind).
 */
export function compClientId(): string {
  try {
    const saved = globalThis.sessionStorage?.getItem(CLIENT_KEY);
    if (saved && CLIENT_ID_RE.test(saved)) return saved;
    const id = memoryClientId ?? makeClientId();
    globalThis.sessionStorage?.setItem(CLIENT_KEY, id);
    memoryClientId = id;
    return id;
  } catch {
    memoryClientId ??= makeClientId();
    return memoryClientId;
  }
}

async function rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!onlineAvailable) throw new CompError('unavailable');
  let res: { data: unknown; error: { message?: unknown; code?: unknown; details?: unknown } | null };
  try {
    res = await getSupabase().rpc(name, args);
  } catch {
    throw new CompError('network');
  }
  if (res.error) throw compErrorFromDb(res.error);
  return res.data;
}

function needMatch(matchId: string): string {
  if (!isUuid(matchId)) throw new CompError('bad_request');
  return matchId.toLowerCase();
}

async function stateCall(name: string, args: Record<string, unknown>): Promise<CompState> {
  const data = await rpc(name, args);
  const st = parseCompState(data);
  if (!st) throw new CompError('bad_response');
  return st;
}

/** Профиль и стартовые асыки (ensure_profile). База требует его перед comp_open и comp_join. */
async function ensureProfile(): Promise<void> {
  try {
    await rpc('ensure_profile');
  } catch (e) {
    if (e instanceof CompError && e.code === 'forbidden') throw new CompError('google_required');
    throw e;
  }
}

/** Создать матч (хозяин). Перед этим — ensure_profile. */
export async function compOpen(p: { layoutId: StakeLayoutId; name: string; clientId?: string }): Promise<CompOpenResult> {
  if (!isStakeLayout(p.layoutId)) throw new CompError('bad_layout');
  await ensureProfile();
  const data = await rpc('comp_open', { p_layout: p.layoutId, p_client_id: p.clientId ?? compClientId(), p_name: cleanName(p.name, 'Хозяин') });
  const r = parseOpenResult(data);
  if (!r) throw new CompError('bad_response');
  return r;
}

/** Войти по коду. Участнику матча база возвращает его место в любом статусе. Перед этим — ensure_profile. */
export async function compJoin(p: { code: string; name: string; clientId?: string }): Promise<CompJoinResult> {
  const code = parseCompCodeInput(p.code);
  if (!code) throw new CompError('bad_code');
  await ensureProfile();
  const data = await rpc('comp_join', { p_code: code, p_client_id: p.clientId ?? compClientId(), p_name: cleanName(p.name, 'Гость') });
  const r = parseJoinResult(data);
  if (!r) throw new CompError('bad_response');
  return r;
}

/** Перепривязать вкладку к матчу и получить состояние. */
export function compRebind(matchId: string, clientId = compClientId()): Promise<CompState> {
  return stateCall('comp_rebind', { p_match: needMatch(matchId), p_client_id: clientId });
}

export async function compKick(matchId: string, lobbySlot: number): Promise<void> {
  if (!Number.isInteger(lobbySlot) || lobbySlot < 1 || lobbySlot >= MAX_COMP_PLAYERS) throw new CompError('bad_slot');
  await rpc('comp_kick', { p_match: needMatch(matchId), p_lobby_slot: lobbySlot });
}

/** Больше id в списке ставки не отправляем (столько асыков в коллекции не бывает). */
const COLLECTION_IDS_MAX = 2000;

/** Поставить 5 свободных асыков (по желанию — из списка). Возвращает id поставленных. */
export async function compStake(matchId: string, ids?: number[]): Promise<number[]> {
  const args: Record<string, unknown> = { p_match: needMatch(matchId) };
  if (ids !== undefined) {
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0) || ids.length > COLLECTION_IDS_MAX) throw new CompError('bad_request');
    args.p_ids = ids;
  }
  const data = await rpc('comp_stake', args);
  const out = intList(data, 1, Number.MAX_SAFE_INTEGER, 10);
  if (!out) throw new CompError('bad_response');
  return out;
}
export async function compUnstake(matchId: string): Promise<void> {
  await rpc('comp_unstake', { p_match: needMatch(matchId) });
}

/** Выйти: в лобби — ставка возвращается (хозяин — матч отменяется), на «Я здесь» — отмена, в игре — сдача. */
export async function compLeave(matchId: string): Promise<void> {
  await rpc('comp_leave', { p_match: needMatch(matchId) });
}

/** Хозяин запускает проверку готовности (60 с). */
export function compStart(matchId: string): Promise<CompState> {
  return stateCall('comp_start', { p_match: needMatch(matchId) });
}

/** Хозяин меняет кон в лобби (до жребия). */
export function compSetLayout(matchId: string, layoutId: StakeLayoutId): Promise<CompState> {
  if (!isStakeLayout(layoutId)) return Promise.reject(new CompError('bad_layout'));
  return stateCall('comp_set_layout', { p_match: needMatch(matchId), p_layout: layoutId });
}

export interface CompRematchResult extends CompOpenResult {
  /** true — это нажатие создало новое лобби (ты в нём хозяин); false — вошёл в лобби соперника. */
  created: boolean;
}

export function parseRematchResult(raw: unknown): CompRematchResult | null {
  const base = parseOpenResult(raw);
  if (!base || !isObj(raw) || typeof raw.created !== 'boolean') return null;
  return { ...base, created: raw.created };
}

/** Реванш / «В комнату» после матча: первый нажавший создаёт лобби с тем же коном, остальные входят в него. */
export async function compRematch(matchId: string, clientId = compClientId()): Promise<CompRematchResult> {
  const data = await rpc('comp_rematch', { p_match: needMatch(matchId), p_client_id: clientId });
  const r = parseRematchResult(data);
  if (!r) throw new CompError('bad_response');
  return r;
}

/** «Я здесь». Последний нажавший переводит матч в active (жребий мест и кона). */
export function compReady(matchId: string): Promise<CompState> {
  return stateCall('comp_ready', { p_match: needMatch(matchId) });
}

/** Пульс. Возвращает серверное время (мс эпохи) или null, если ответ не похож на время. */
export async function compHeartbeat(matchId: string): Promise<number | null> {
  const data = await rpc('comp_heartbeat', { p_match: needMatch(matchId) });
  return parseDbTime(data);
}

/** Пропустить ход (номер броска — match.throwNo + 1). База сама проверяет, можно ли. */
export function compSkip(matchId: string, throwNo: number): Promise<CompState> {
  if (!Number.isInteger(throwNo) || throwNo < 1 || throwNo > MAX_THROW_NO) return Promise.reject(new CompError('bad_request'));
  return stateCall('comp_skip', { p_match: needMatch(matchId), p_throw_no: throwNo });
}

export function compForfeit(matchId: string): Promise<CompState> {
  return stateCall('comp_forfeit', { p_match: needMatch(matchId) });
}

/** Уборка зависшего матча (active без изменений 15 мин — раздача по уже выбитому). */
export function compSettleStale(matchId: string): Promise<CompState> {
  return stateCall('comp_settle_stale', { p_match: needMatch(matchId) });
}

export function compState(matchId: string): Promise<CompState> {
  return stateCall('comp_state', { p_match: needMatch(matchId) });
}

export async function myCompHistory(limit = 20): Promise<CompHistoryEntry[]> {
  const data = await rpc('my_comp_history', { p_limit: Math.max(1, Math.min(50, Math.floor(limit) || 20)) });
  const r = parseCompHistory(data);
  if (!r) throw new CompError('bad_response');
  return r;
}

// ——— запись броска (ответ comp-throw и сообщения 'srv') ———

/** Часть записи броска от сервера (канал comp:<id>, событие 'srv'; тот же формат, что у обычного онлайна). */
export type CompThrowEvent =
  | { k: 'start'; throwNo: number; start: ThrowStart }
  | { k: 'chunk'; throwNo: number; chunk: ThrowChunk }
  | { k: 'end'; throwNo: number; end: ThrowEnd; knocked: number[] };

function parseKnocked(raw: unknown, end: ThrowEnd): number[] | null {
  const knocked = intList(raw, 0, LIMITS.maxAsyks - 1, LIMITS.maxAsyks);
  if (!knocked) return null;
  // выбитый этим броском асык в итоге обязан быть вне кона
  for (const k of knocked) {
    const f = end.final.find((s) => s[0] === k);
    if (!f || f[4] !== 0) return null;
  }
  return knocked;
}

/** Разбор сообщения 'srv'. Неверное → null. */
export function parseSrv(raw: unknown): CompThrowEvent | null {
  if (!isObj(raw)) return null;
  const throwNo = int(raw.throwNo, 1, LIMITS.maxThrows);
  if (throwNo === null) return null;
  switch (raw.k) {
    case 'start': {
      const start = parseThrowStart({ throwIndex: throwNo, angle: raw.angle, power: raw.power });
      return start ? { k: 'start', throwNo, start } : null;
    }
    case 'chunk': {
      const chunk = parseThrowChunk({ seq: raw.seq, frames: raw.frames, events: raw.events });
      return chunk ? { k: 'chunk', throwNo, chunk } : null;
    }
    case 'end': {
      const end = parseThrowEnd({ steps: raw.steps, final: raw.final, saka: raw.saka });
      if (!end) return null;
      const knocked = parseKnocked(raw.knocked, end);
      return knocked ? { k: 'end', throwNo, end, knocked } : null;
    }
    default:
      return null;
  }
}

/** Что база сделала после броска (ответ comp_apply_throw.next). */
export interface CompThrowNext {
  status: CompStatus;
  currentSeat: number | null;
  throwNo: number;
  turnStartedAt: number | null;
  turnDeadline: number | null;
  endReason: CompEndReason | null;
}

/** Ответ comp-throw бросающему: вся запись сразу. */
export interface CompThrowResult {
  throwNo: number;
  start: ThrowStart;
  /** Части по порядку seq. */
  chunks: ThrowChunk[];
  end: ThrowEnd;
  /** Слоты, выбитые этим броском. */
  knocked: number[];
  next: CompThrowNext | null;
}

function parseNext(raw: unknown): CompThrowNext | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw) || !isStatus(raw.status)) return undefined;
  const currentSeat = intOrNull(raw.current_seat, 0, MAX_COMP_PLAYERS - 1);
  const throwNo = int(raw.throw_no, 0, MAX_THROW_NO);
  const turnStartedAt = timeOrNull(raw.turn_started_at);
  const turnDeadline = timeOrNull(raw.turn_deadline);
  if (currentSeat === undefined || throwNo === null || turnStartedAt === undefined || turnDeadline === undefined) return undefined;
  return { status: raw.status, currentSeat, throwNo, turnStartedAt, turnDeadline, endReason: endReason(raw.end_reason) };
}

/**
 * Разбор ответа comp-throw `{ start, chunks, end, knocked, next }` теми же проверками, что и запись обычного онлайна
 * (validate.ts), плюс: номер броска совпадает с запрошенным, части не повторяются, общий объём в пределах,
 * выбитые этим броском — вне кона, итог кона — ровно konSize асыков (если он известен). Неверное → null.
 */
export function parseThrowResponse(raw: unknown, throwNo: number, konSize?: number): CompThrowResult | null {
  if (!isObj(raw)) return null;
  const start = parseThrowStart(raw.start);
  if (!start || start.throwIndex !== throwNo) return null;
  if (!Array.isArray(raw.chunks) || raw.chunks.length > LIMITS.maxChunksPerThrow) return null;
  const chunks: ThrowChunk[] = [];
  let frames = 0;
  let events = 0;
  for (const c of raw.chunks) {
    const chunk = parseThrowChunk(c);
    if (!chunk || chunks.some((x) => x.seq === chunk.seq)) return null;
    frames += chunk.frames.length;
    events += chunk.events.length;
    chunks.push(chunk);
  }
  if (frames > LIMITS.maxFramesPerThrow || events > LIMITS.maxEventsPerThrow) return null;
  chunks.sort((a, b) => a.seq - b.seq);
  const end = parseThrowEnd(raw.end);
  if (!end) return null;
  if (konSize !== undefined && (end.final.length !== konSize || end.final.some((s, k) => s[0] !== k))) return null;
  const knocked = parseKnocked(raw.knocked, end);
  const next = parseNext(raw.next);
  if (!knocked || next === undefined) return null;
  return { throwNo, start, chunks, end, knocked, next };
}

/** Тело запроса comp-throw. angle — запрошенный угол (до разброса), power — сила прицела. */
export interface CompThrowBody {
  matchId: string;
  throwNo: number;
  angle: number;
  power: number;
}

/** Один вызов функции comp-throw: ответ или ошибка (retry — можно повторить тот же бросок). */
export type CompThrowInvoker = (body: CompThrowBody, timeoutMs: number) => Promise<{ data: unknown } | { error: CompError; retry: boolean }>;

/** Через сколько повторять бросок, если ответа нет (сервер идемпотентен: повтор того же throwNo безопасен). */
export const THROW_TIMEOUT_MS = 8_000;
/** Попыток всего (первая + повторы): 3 × 8 с укладываются в 45 с хода и в SERVER_THROW_TIMEOUT_MS движка. */
export const THROW_ATTEMPTS = 3;
export const RETRY_PAUSE_MS = 600;

/** Ошибки сети и сбои сервера можно повторить; отказы по правилам (не твой ход, лимит…) — нет. */
const RETRYABLE: ReadonlySet<CompErrorCode> = new Set<CompErrorCode>(['network', 'timeout', 'server', 'pending']);

async function readErrorBody(res: unknown): Promise<unknown> {
  if (!res || typeof (res as Response).json !== 'function') return null;
  try {
    const text = await (res as Response).text();
    if (text.length > 4096) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Вызов через supabase.functions.invoke: токен игрока подставляется сам. */
const defaultInvoker: CompThrowInvoker = async (body, timeoutMs) => {
  if (!onlineAvailable) return { error: new CompError('unavailable'), retry: false };
  let out: { data: unknown; error: unknown; response?: Response };
  try {
    out = await getSupabase().functions.invoke('comp-throw', { body, timeout: timeoutMs });
  } catch {
    return { error: new CompError('network'), retry: true };
  }
  if (!out.error) {
    let data = out.data;
    if (typeof data === 'string' && data.length < 1_000_000) {
      try {
        data = JSON.parse(data) as unknown;
      } catch {
        return { error: new CompError('bad_response'), retry: false };
      }
    }
    return { data };
  }
  const err = out.error as { name?: unknown; context?: unknown };
  if (err.name === 'FunctionsHttpError' || err.name === 'FunctionsRelayError') {
    const res = (out.response ?? err.context) as Response | undefined;
    const status = typeof res?.status === 'number' ? res.status : 500;
    const payload = await readErrorBody(res);
    const raw = isObj(payload) ? (payload.error ?? payload.code) : null;
    let code = compCodeFrom(raw);
    if (code === 'server' && status === 429) code = 'rate_limited';
    if (code === 'server' && status === 410) code = 'version';
    if (code === 'server' && status === 401) code = 'not_signed_in';
    // функция ещё не задеплоена (404 от шлюза без нашего кода) или не настроена (503 config) — режим недоступен
    if (code === 'server' && (status === 404 || raw === 'config')) code = 'setup';
    const retry = RETRYABLE.has(code) && (status >= 500 || code === 'pending');
    return { error: new CompError(code, null), retry };
  }
  // FunctionsFetchError: нет связи или сработал таймаут
  const ctx = err.context as { name?: unknown } | undefined;
  const timedOut = ctx?.name === 'AbortError' || ctx?.name === 'TimeoutError';
  return { error: new CompError(timedOut ? 'timeout' : 'network'), retry: true };
};

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Бросок через сервер: POST comp-throw { matchId, throwNo, angle, power }. Нет ответа за 8 с или сбой связи —
 * тот же бросок (тот же throwNo) отправляется снова: сервер вернёт уже посчитанный результат, второго броска не будет.
 * Ответ проходит parseThrowResponse; отказ — CompError.
 */
export async function submitThrow(
  body: CompThrowBody,
  opts: { konSize?: number; invoke?: CompThrowInvoker; attempts?: number; timeoutMs?: number; pauseMs?: number } = {},
): Promise<CompThrowResult> {
  if (!isUuid(body.matchId) || !Number.isInteger(body.throwNo) || body.throwNo < 1 || body.throwNo > MAX_THROW_NO) throw new CompError('bad_request');
  if (!Number.isFinite(body.angle) || Math.abs(body.angle) > PHYS.maxAimAngle) throw new CompError('bad_throw');
  if (!Number.isFinite(body.power) || body.power < COMP_MIN_POWER || body.power > 1) throw new CompError('bad_throw');
  const req: CompThrowBody = { matchId: body.matchId.toLowerCase(), throwNo: body.throwNo, angle: body.angle, power: body.power };
  const invoke = opts.invoke ?? defaultInvoker;
  const attempts = Math.max(1, opts.attempts ?? THROW_ATTEMPTS);
  let last = new CompError('timeout');
  for (let a = 0; a < attempts; a++) {
    if (a > 0) await pause(opts.pauseMs ?? RETRY_PAUSE_MS);
    const r = await invoke(req, opts.timeoutMs ?? THROW_TIMEOUT_MS);
    if ('data' in r) {
      const parsed = parseThrowResponse(r.data, req.throwNo, opts.konSize);
      if (!parsed) throw new CompError('bad_response');
      return parsed;
    }
    last = r.error;
    if (!r.retry) throw r.error;
  }
  throw last;
}

/** Ответ функции → те же сообщения, что приходят в канале (для ThrowFeed). */
export function throwResultEvents(r: CompThrowResult): CompThrowEvent[] {
  return [
    { k: 'start', throwNo: r.throwNo, start: r.start },
    ...r.chunks.map((chunk): CompThrowEvent => ({ k: 'chunk', throwNo: r.throwNo, chunk })),
    { k: 'end', throwNo: r.throwNo, end: r.end, knocked: r.knocked },
  ];
}

/**
 * Лента записи бросков: склеивает два источника (канал 'srv' и ответ функции бросающему) без повторов
 * и отдаёт движку в порядке start → части → end. Части, пришедшие раньше start, ждут его.
 * Броски старше `floor` (уже показанные или известные по базе) игнорируются.
 */
export class ThrowFeed {
  private readonly throws = new Map<number, { started: boolean; ended: boolean; seqs: Set<number>; early: CompThrowEvent[] }>();
  private floor = 1;

  /** Не показывать броски с номером меньше n (например, после загрузки состояния из базы). */
  ignoreBefore(n: number): void {
    if (n > this.floor) this.floor = n;
    for (const k of [...this.throws.keys()]) if (k < this.floor) this.throws.delete(k);
  }

  /** Принять часть записи. Возвращает то, что нужно отдать движку сейчас (по порядку). */
  push(ev: CompThrowEvent): CompThrowEvent[] {
    if (ev.throwNo < this.floor) return [];
    let t = this.throws.get(ev.throwNo);
    if (!t) {
      t = { started: false, ended: false, seqs: new Set(), early: [] };
      this.throws.set(ev.throwNo, t);
      // помним несколько последних бросков, не больше
      while (this.throws.size > 4) this.throws.delete(Math.min(...this.throws.keys()));
      if (!this.throws.has(ev.throwNo)) return [];
    }
    if (ev.k === 'start') {
      if (t.started) return [];
      t.started = true;
      // ждавшие части — по seq, конец — последним
      const order = (e: CompThrowEvent) => (e.k === 'chunk' ? e.chunk.seq : Infinity);
      const early = [...t.early].sort((a, b) => order(a) - order(b));
      t.early = [];
      // начался новый бросок — старые больше не нужны
      this.ignoreBefore(ev.throwNo - 1);
      return [ev, ...early];
    }
    if (ev.k === 'chunk') {
      if (t.seqs.has(ev.chunk.seq) || t.seqs.size >= LIMITS.maxChunksPerThrow) return [];
      t.seqs.add(ev.chunk.seq);
    } else {
      if (t.ended) return [];
      t.ended = true;
    }
    if (!t.started) {
      t.early.push(ev);
      return [];
    }
    return [ev];
  }
}

// ——— прицел ———

export interface CompAim {
  angle: number;
  power: number;
}

/** Разбор прицела соперника `{ a: {angle, power} | null, n?: номер броска }`. Неверное → undefined. */
export function parseAimPayload(raw: unknown): { aim: CompAim | null; throwNo: number | null } | undefined {
  if (!isObj(raw)) return undefined;
  const throwNo = raw.n === undefined ? null : int(raw.n, 1, MAX_THROW_NO);
  if (throwNo === null && raw.n !== undefined) return undefined;
  if (raw.a === null) return { aim: null, throwNo };
  if (!isObj(raw.a)) return undefined;
  const angle = num(raw.a.angle, -LIMITS.maxAimAngle, LIMITS.maxAimAngle);
  const power = num(raw.a.power, 0, 1);
  return angle === null || power === null ? undefined : { aim: { angle, power }, throwNo };
}

/** Не чаще 8 раз в секунду (docs 7.4). */
export const AIM_INTERVAL_MS = 125;

/**
 * Отправка прицела не чаще раза в AIM_INTERVAL_MS: промежуточные положения отбрасываются, последнее (в том числе
 * «прицел убран») уходит обязательно — с задержкой до конца интервала.
 */
export class AimThrottle {
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued: { a: CompAim | null; n: number | null } | null = null;

  constructor(
    private readonly sendNow: (payload: { a: CompAim | null; n?: number }) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly interval = AIM_INTERVAL_MS,
  ) {}

  send(a: CompAim | null, throwNo: number | null = null): void {
    this.queued = { a: a ? { angle: a.angle, power: a.power } : null, n: throwNo };
    if (this.timer !== null) return;
    const wait = this.lastAt + this.interval - this.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = null;
    const q = this.queued;
    this.queued = null;
    if (!q) return;
    this.lastAt = this.now();
    this.sendNow(q.n === null ? { a: q.a } : { a: q.a, n: q.n });
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queued = null;
  }
}

// ——— пропуск хода ———

/** Запас к серверным границам (часы сервера мы знаем с точностью до задержки сети). */
const SKIP_MARGIN_MS = 600;
/** Пульс старше этого — игрок не в сети (как в comp_skip). */
const ABSENT_MS = 15_000;
/** Пока сервер считает бросок (pending моложе этого), пропуск запрещён. */
const PENDING_GUARD_MS = 20_000;

/**
 * Когда можно попросить базу пропустить текущий ход (comp_skip) — по данным comp_state:
 * - наступил дедлайн + 5 с (skipAt) — любой ход, в том числе мой;
 * - или прошло 20 с с начала хода (skipAbsentAt) и пульс текущего игрока старше 15 с — только чужой ход;
 * - и нет отметки «бросок принят» моложе 20 с.
 * Возвращает номер броска и момент по местным часам; null — пропускать нечего. База всё равно проверяет сама.
 */
export function skipPlan(state: CompState): { throwNo: number; at: number } | null {
  const m = state.match;
  if (m.status !== 'active' || m.currentSeat === null) return null;
  const cur = state.players.find((p) => p.seat === m.currentSeat);
  if (!cur) return null;
  let at = m.skipAt ?? Infinity;
  if (!cur.isMe && m.skipAbsentAt !== null) {
    const seenAt = cur.seenAgoMs === null ? -Infinity : state.now - cur.seenAgoMs;
    at = Math.min(at, Math.max(m.skipAbsentAt, seenAt + ABSENT_MS));
  }
  if (!Number.isFinite(at)) return null;
  if (m.pending && m.pendingAt !== null) at = Math.max(at, m.pendingAt + PENDING_GUARD_MS);
  return { throwNo: m.throwNo + 1, at: toLocalTime(state, at) + SKIP_MARGIN_MS };
}

// ——— каналы Realtime ———

export type CompConnection = 'connecting' | 'online' | 'reconnecting' | 'closed';

interface LinkHandlers {
  srv: Set<(ev: CompThrowEvent) => void>;
  aim: Set<(aim: CompAim | null, throwNo: number | null) => void>;
  change: Set<() => void>;
  status: Set<() => void>;
}

/**
 * Каналы одного матча для одной вкладки. Один объект на пару «матч + вкладка»: повторное подключение
 * (StrictMode, быстрый уход и возврат) получает тот же объект и отменяет его отложенное закрытие, поэтому
 * двух каналов с одной темой не бывает (realtime-js переиспользует канал с тем же именем).
 */
class CompLink {
  private main: RealtimeChannel | null = null;
  private aimCh: RealtimeChannel | null = null;
  private refs = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private disposed = false;
  private presenceSlot: number | null = null;
  private readonly aimLimiter = new RateLimiter(20, 12);
  private readonly throttle = new AimThrottle((p) => {
    void this.aimCh?.send({ type: 'broadcast', event: 'aim', payload: p });
  });
  readonly on: LinkHandlers = { srv: new Set(), aim: new Set(), change: new Set(), status: new Set() };
  mainStatus: CompConnection = 'connecting';
  /** Места в лобби (lobby_slot), которые сейчас в канале по presence. Только подсказка: решения — по comp_state. */
  present: number[] = [];

  constructor(
    readonly matchId: string,
    readonly clientId: string,
    private readonly onDisposed: () => void,
  ) {}

  acquire(): void {
    this.refs += 1;
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (!this.main && !this.connecting) void this.connect();
  }

  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0 || this.closeTimer !== null) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.refs === 0) void this.closeNow();
    }, 150);
  }

  private setStatus(s: CompConnection): void {
    if (this.mainStatus === s) return;
    this.mainStatus = s;
    for (const f of this.on.status) f();
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    const sb = getSupabase();
    const topic = `comp:${this.matchId}`;
    const aimTopic = `comp-aim:${this.matchId}`;
    try {
      // закрытый канал: Realtime проверяет токен игрока и политики competitive.sql
      await sb.realtime.setAuth();
      // страховка: в клиенте остался закрывающийся канал с тем же именем — дожидаемся его удаления
      for (const stale of sb.getChannels().filter((c) => c.topic === `realtime:${topic}` || c.topic === `realtime:${aimTopic}`)) {
        await sb.removeChannel(stale);
      }
    } catch {
      // нет связи — канал всё равно создаём: realtime-js переподключится сам
    }
    this.connecting = false;
    if (this.disposed || this.refs === 0) return;

    const main = sb.channel(topic, { config: { private: true, broadcast: { self: false, ack: false }, presence: { key: this.clientId, enabled: true } } });
    main.on('broadcast', { event: 'srv' }, ({ payload }) => {
      const ev = parseSrv(payload);
      if (!ev) return;
      for (const f of this.on.srv) f(ev);
    });
    main.on('presence', { event: 'sync' }, () => this.readPresence(main));
    main.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'comp_matches', filter: `id=eq.${this.matchId}` }, () => {
      for (const f of this.on.change) f();
    });
    main.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.setStatus('online');
        if (this.presenceSlot !== null) void main.track({ slot: this.presenceSlot });
        // переподключились — могли пропустить изменения
        for (const f of this.on.change) f();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.setStatus('reconnecting');
      } else if (status === 'CLOSED') {
        this.setStatus('closed');
      }
    });

    const aimCh = sb.channel(aimTopic, { config: { private: true, broadcast: { self: false, ack: false } } });
    aimCh.on('broadcast', { event: 'aim' }, ({ payload }) => {
      if (!this.aimLimiter.take()) return;
      let size = 0;
      try {
        size = JSON.stringify(payload).length;
      } catch {
        return;
      }
      if (size > 300) return;
      const p = parseAimPayload(payload);
      if (!p) return;
      for (const f of this.on.aim) f(p.aim, p.throwNo);
    });
    aimCh.subscribe();

    this.main = main;
    this.aimCh = aimCh;
  }

  private readPresence(ch: RealtimeChannel): void {
    const slots: number[] = [];
    const state = ch.presenceState();
    for (const [key, list] of Object.entries(state)) {
      if (key === this.clientId || !CLIENT_ID_RE.test(key) || !Array.isArray(list)) continue;
      for (const meta of list.slice(0, 4) as unknown[]) {
        const slot = isObj(meta) ? int(meta.slot, 0, MAX_COMP_PLAYERS - 1) : null;
        if (slot !== null && !slots.includes(slot)) slots.push(slot);
      }
    }
    slots.sort((a, b) => a - b);
    if (slots.join() === this.present.join()) return;
    this.present = slots;
    for (const f of this.on.status) f();
  }

  /** Сообщить о себе в presence (место в лобби). */
  setPresence(slot: number | null): void {
    if (slot === this.presenceSlot) return;
    this.presenceSlot = slot;
    if (this.main && this.mainStatus === 'online' && slot !== null) void this.main.track({ slot });
  }

  sendAim(a: CompAim | null, throwNo: number | null): void {
    this.throttle.send(a, throwNo);
  }

  private async closeNow(): Promise<void> {
    this.disposed = true;
    this.throttle.dispose();
    const chans = [this.main, this.aimCh];
    this.main = null;
    this.aimCh = null;
    this.onDisposed();
    const sb = getSupabase();
    for (const ch of chans) if (ch) await sb.removeChannel(ch).catch(() => undefined);
  }
}

const links = new Map<string, CompLink>();

function acquireLink(matchId: string, clientId: string): CompLink {
  const key = `${matchId}:${clientId}`;
  let link = links.get(key);
  if (!link) {
    const created: CompLink = new CompLink(matchId, clientId, () => {
      if (links.get(key) === created) links.delete(key);
    });
    link = created;
    links.set(key, link);
  }
  link.acquire();
  return link;
}

// ——— матч целиком: состояние, опрос, пульс, автоматические действия ———

export interface CompMatchSnapshot {
  /** Последнее состояние из базы (null — ещё не загружено). */
  state: CompState | null;
  /** Ошибка, из-за которой матч не показать (не участник, исключён, нет матча, не вошёл, режим не настроен). */
  error: CompError | null;
  /** Временная беда: последний опрос не удался (показываем последнее известное состояние). */
  warning: CompError | null;
  /** Канал записи бросков и изменений базы. */
  connection: CompConnection;
  /** Мой бросок отправлен и ждёт ответа сервера (индикатор «Бросок…»). */
  throwing: boolean;
  /** Места в лобби (lobby_slot) соперников, которые сейчас в канале. Подсказка; «в сети» — players[].online. */
  present: number[];
  /** Матч создан более новой версией игры (sim_version больше нашей): надо обновить страницу. */
  outdated: boolean;
}

export interface CompMatchActions {
  /** Перечитать comp_state сейчас. */
  refresh(): Promise<void>;
  stake(ids?: number[]): Promise<number[]>;
  unstake(): Promise<void>;
  kick(lobbySlot: number): Promise<void>;
  start(): Promise<void>;
  ready(): Promise<void>;
  leave(): Promise<void>;
  forfeit(): Promise<void>;
  settleStale(): Promise<void>;
  /** Хозяин меняет кон в лобби. */
  setLayout(layoutId: StakeLayoutId): Promise<void>;
  /** После матча: войти в лобби реванша (создать, если его ещё нет). */
  rematch(): Promise<CompRematchResult>;
  /**
   * Бросок через сервер (номер — match.throwNo + 1). Запись приходит в onThrow (и из ответа, и из канала — без повторов);
   * промис — тот же результат целиком. Отказ — CompError.
   */
  throwAsyk(angle: number, power: number): Promise<CompThrowResult>;
  /** Мой прицел соперникам (не чаще 8/с); null — прицел убран. */
  sendAim(aim: CompAim | null): void;
  /** Запись бросков по порядку: start → chunk… → end (для engine.remoteThrowStart/Chunk/End). Возвращает отписку. */
  onThrow(fn: (ev: CompThrowEvent) => void): () => void;
  /** Прицел соперника (throwNo — для какого броска, если указан). Возвращает отписку. */
  onAim(fn: (aim: CompAim | null, throwNo: number | null) => void): () => void;
}

/** Сколько после конца матча ждём, что соперник позовёт на реванш (столько же живёт доступ к каналу матча). */
export const REMATCH_WATCH_MS = 10 * 60_000;

/** Опрос comp_state и пульс (docs 0.1: пульс каждые 5 с). */
export const COMP_POLL_MS = 5_000;
/** Сигнал из базы приходит пачкой — перечитываем один раз. */
const CHANGE_DEBOUNCE_MS = 120;
/** Эти ошибки означают, что матч в этой вкладке больше не показать. */
const FATAL: ReadonlySet<CompErrorCode> = new Set<CompErrorCode>([
  'not_member',
  'not_found',
  'not_signed_in',
  'google_required',
  'banned',
  'setup',
  'forbidden',
  'unavailable',
  'bad_request',
]);

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * Матч для одной вкладки: держит состояние из базы, каналы, опрос и пульс; сам жмёт «Я здесь» (если вкладка видна)
 * и сам просит пропустить ход отсутствующего, когда по данным comp_state это разрешено.
 */
export class CompMatchClient {
  private snap: CompMatchSnapshot = { state: null, error: null, warning: null, connection: 'connecting', throwing: false, present: [], outdated: false };
  private readonly listeners = new Set<() => void>();
  private readonly throwListeners = new Set<(ev: CompThrowEvent) => void>();
  private readonly aimListeners = new Set<(aim: CompAim | null, throwNo: number | null) => void>();
  private readonly feed = new ThrowFeed();
  private link: CompLink | null = null;
  private unbind: (() => void)[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private skipTimer: ReturnType<typeof setTimeout> | null = null;
  private skipKey = '';
  private skipBusy = false;
  private readyBusy = false;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private stopped = false;
  private started = false;
  private firstState = true;

  constructor(
    readonly matchId: string,
    private readonly opts: { clientId?: string; autoReady?: boolean; autoSkip?: boolean } = {},
  ) {}

  get clientId(): string {
    return this.opts.clientId ?? compClientId();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): CompMatchSnapshot => this.snap;

  private set(patch: Partial<CompMatchSnapshot>): void {
    if (this.stopped) return;
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!isUuid(this.matchId)) {
      this.set({ error: new CompError('bad_request') });
      return;
    }
    const link = acquireLink(this.matchId.toLowerCase(), this.clientId);
    this.link = link;
    const onSrv = (ev: CompThrowEvent) => this.emitThrow(ev);
    const onAim = (aim: CompAim | null, n: number | null) => {
      for (const f of this.aimListeners) f(aim, n);
    };
    const onChange = () => this.scheduleChange();
    const onStatus = () => this.set({ connection: link.mainStatus, present: link.present });
    link.on.srv.add(onSrv);
    link.on.aim.add(onAim);
    link.on.change.add(onChange);
    link.on.status.add(onStatus);
    this.unbind.push(() => {
      link.on.srv.delete(onSrv);
      link.on.aim.delete(onAim);
      link.on.change.delete(onChange);
      link.on.status.delete(onStatus);
    });
    this.set({ connection: link.mainStatus, present: link.present });

    if (typeof document !== 'undefined') {
      const onVis = () => {
        if (visible()) this.tick();
      };
      document.addEventListener('visibilitychange', onVis);
      this.unbind.push(() => document.removeEventListener('visibilitychange', onVis));
    }

    // первая загрузка — перепривязка вкладки (последняя вкладка побеждает)
    this.refreshing = compRebind(this.matchId, this.clientId)
      .then((st) => this.apply(st))
      .catch((e: unknown) => this.fail(e))
      .finally(() => {
        this.refreshing = null;
      });
    this.poll = setInterval(() => this.tick(), COMP_POLL_MS);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.poll !== null) clearInterval(this.poll);
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    if (this.skipTimer !== null) clearTimeout(this.skipTimer);
    this.poll = this.changeTimer = this.skipTimer = null;
    for (const u of this.unbind) u();
    this.unbind = [];
    this.link?.release();
    this.link = null;
    this.listeners.clear();
    this.throwListeners.clear();
    this.aimListeners.clear();
  }

  /** Раз в 5 с: пульс (если вкладка видна) и опрос. После конца матча — ничего. */
  private tick(): void {
    if (this.stopped || this.snap.error) return;
    const st = this.snap.state;
    if (st && isCompOver(st.match.status)) {
      // после конца ждём только код реванша (соперник может позвать) — без пульса и не дольше 10 минут
      const since = st.match.settledAt ?? st.match.createdAt;
      if (st.match.nextCode !== null || (since !== null && serverNow(st) - since > REMATCH_WATCH_MS)) {
        if (this.poll !== null) clearInterval(this.poll);
        this.poll = null;
        return;
      }
      if (visible()) void this.refresh();
      return;
    }
    if (visible() && st && st.me.lobbySlot !== null) {
      compHeartbeat(this.matchId).catch((e: unknown) => {
        if (e instanceof CompError && FATAL.has(e.code)) void this.refresh();
      });
    }
    void this.refresh();
  }

  private scheduleChange(): void {
    if (this.changeTimer !== null || this.stopped) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.refresh();
    }, CHANGE_DEBOUNCE_MS);
  }

  /** Перечитать comp_state; параллельные запросы склеиваются (после текущего — ещё один). */
  refresh = (): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = async (): Promise<void> => {
      do {
        this.refreshAgain = false;
        try {
          this.apply(await compState(this.matchId));
        } catch (e) {
          this.fail(e);
        }
      } while (this.refreshAgain && !this.stopped);
    };
    this.refreshing = run().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  };

  private fail(e: unknown): void {
    const err = e instanceof CompError ? e : new CompError('network');
    if (FATAL.has(err.code)) {
      this.set({ error: err, warning: null });
      if (this.poll !== null) clearInterval(this.poll);
      this.poll = null;
    } else {
      this.set({ warning: err });
    }
  }

  /** Новое состояние из базы. Ответ старее уже показанного (по серверному времени) не применяется. */
  private apply(st: CompState): void {
    if (this.stopped) return;
    const prev = this.snap.state;
    if (prev && st.now < prev.now) return;
    if (this.firstState) {
      this.firstState = false;
      // броски, уже записанные в базу до открытия, не проигрываем: кон берётся из kon_state
      // (бросок, который сервер считает сейчас, — throwNo + 1 — показываем)
      this.feed.ignoreBefore(st.match.throwNo + 1);
    }
    this.link?.setPresence(st.me.lobbySlot);
    this.set({ state: st, error: null, warning: null, outdated: st.match.simVersion > SIM_VERSION });
    this.autoReady(st);
    this.planSkip(st);
  }

  private autoReady(st: CompState): void {
    if (this.opts.autoReady === false || this.readyBusy) return;
    if (st.match.status !== 'ready' || st.me.ready || !visible()) return;
    this.readyBusy = true;
    compReady(this.matchId)
      .then((s) => this.apply(s))
      .catch((e: unknown) => this.fail(e))
      .finally(() => {
        this.readyBusy = false;
      });
  }

  private planSkip(st: CompState): void {
    if (this.opts.autoSkip === false) return;
    const plan = skipPlan(st);
    const key = plan ? `${plan.throwNo}:${Math.round(plan.at / 250)}` : '';
    if (key === this.skipKey) return;
    this.skipKey = key;
    if (this.skipTimer !== null) clearTimeout(this.skipTimer);
    this.skipTimer = null;
    if (!plan) return;
    this.armSkip(plan.throwNo, plan.at);
  }

  private armSkip(throwNo: number, at: number): void {
    if (this.skipTimer !== null) clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(() => this.trySkip(throwNo), Math.max(250, Math.min(at - Date.now(), 120_000)));
  }

  private trySkip(throwNo: number): void {
    this.skipTimer = null;
    const st = this.snap.state;
    // пока мой бросок считается, свой ход не пропускаем (skipPlan и так ждёт дедлайна для своего хода)
    if (this.stopped || this.skipBusy || this.snap.throwing || !st || st.match.status !== 'active' || st.match.throwNo + 1 !== throwNo) return;
    this.skipBusy = true;
    compSkip(this.matchId, throwNo)
      .then((s) => this.apply(s))
      .catch((e: unknown) => {
        if (e instanceof CompError && e.code === 'too_early') {
          const nb = e.notBefore;
          const cur = this.snap.state;
          // detail — время сервера; переводим в местное по последнему ответу
          if (nb !== null && cur) this.armSkip(throwNo, toLocalTime(cur, nb) + SKIP_MARGIN_MS);
          else void this.refresh();
        } else if (e instanceof CompError && FATAL.has(e.code)) {
          this.fail(e);
        } else {
          // stale_throw, pending, not_active, сеть — состояние изменилось: перечитать и решить заново
          this.skipKey = '';
          void this.refresh();
        }
      })
      .finally(() => {
        this.skipBusy = false;
      });
  }

  private emitThrow(ev: CompThrowEvent): void {
    for (const out of this.feed.push(ev)) {
      for (const f of this.throwListeners) {
        try {
          f(out);
        } catch {
          // ошибка в обработчике не должна рвать приём следующих частей
        }
      }
    }
  }

  // ——— действия ———

  private withState = async (p: Promise<CompState>): Promise<void> => {
    this.apply(await p);
  };

  private thenRefresh = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } finally {
      void this.refresh();
    }
  };

  readonly actions: CompMatchActions = {
    refresh: () => this.refresh(),
    stake: (ids) => this.thenRefresh(compStake(this.matchId, ids)),
    unstake: () => this.thenRefresh(compUnstake(this.matchId)),
    kick: (slot) => this.thenRefresh(compKick(this.matchId, slot)),
    start: () => this.withState(compStart(this.matchId)),
    ready: () => this.withState(compReady(this.matchId)),
    leave: () => this.thenRefresh(compLeave(this.matchId)),
    forfeit: () => this.withState(compForfeit(this.matchId)),
    settleStale: () => this.withState(compSettleStale(this.matchId)),
    setLayout: (layoutId) => this.withState(compSetLayout(this.matchId, layoutId)),
    rematch: () => compRematch(this.matchId),
    throwAsyk: async (angle, power) => {
      const st = this.snap.state;
      if (!st) throw new CompError('not_active');
      if (!isMyTurn(st)) throw new CompError('not_your_turn');
      if (this.snap.throwing) throw new CompError('pending');
      const throwNo = st.match.throwNo + 1;
      this.link?.sendAim(null, throwNo);
      this.set({ throwing: true });
      try {
        const r = await submitThrow({ matchId: this.matchId, throwNo, angle, power }, { konSize: st.match.konSize });
        for (const ev of throwResultEvents(r)) this.emitThrow(ev);
        return r;
      } finally {
        this.set({ throwing: false });
        void this.refresh();
      }
    },
    sendAim: (aim) => {
      const st = this.snap.state;
      if (!st || !isMyTurn(st) || this.snap.throwing) return;
      this.link?.sendAim(aim, st.match.throwNo + 1);
    },
    onThrow: (fn) => {
      this.throwListeners.add(fn);
      return () => this.throwListeners.delete(fn);
    },
    onAim: (fn) => {
      this.aimListeners.add(fn);
      return () => this.aimListeners.delete(fn);
    },
  };
}

const EMPTY: CompMatchSnapshot = { state: null, error: null, warning: null, connection: 'closed', throwing: false, present: [], outdated: false };

const noMatch = (): Promise<never> => Promise.reject(new CompError('bad_request'));
const NO_ACTIONS: CompMatchActions = {
  refresh: () => Promise.resolve(),
  stake: noMatch,
  unstake: noMatch,
  kick: noMatch,
  start: noMatch,
  ready: noMatch,
  leave: noMatch,
  forfeit: noMatch,
  settleStale: noMatch,
  setLayout: noMatch,
  rematch: noMatch,
  throwAsyk: noMatch,
  sendAim: () => undefined,
  onThrow: () => () => undefined,
  onAim: () => () => undefined,
};

export interface CompMatchView extends CompMatchSnapshot {
  actions: CompMatchActions;
}

/**
 * Матч на асыки для экрана. matchId — из compOpen/compJoin (null — ещё не известен). Подписки, таймеры и каналы
 * снимаются при размонтировании и при смене matchId. `actions` стабильны, пока не сменился matchId.
 *
 * Параметры: autoReady (по умолчанию да) — сам жмёт «Я здесь», когда вкладка видна; autoSkip (по умолчанию да) —
 * сам просит пропустить ход отсутствующего или просроченный ход.
 */
export function useCompMatch(matchId: string | null, opts: { autoReady?: boolean; autoSkip?: boolean } = {}): CompMatchView {
  const { autoReady = true, autoSkip = true } = opts;
  const [client, setClient] = useState<CompMatchClient | null>(null);
  const [snap, setSnap] = useState<CompMatchSnapshot>(EMPTY);
  const optsRef = useRef({ autoReady, autoSkip });
  optsRef.current = { autoReady, autoSkip };

  useEffect(() => {
    if (!matchId) {
      setClient(null);
      setSnap(EMPTY);
      return;
    }
    const c = new CompMatchClient(matchId, { ...optsRef.current });
    const unsub = c.subscribe(() => setSnap(c.getSnapshot()));
    c.start();
    setClient(c);
    setSnap(c.getSnapshot());
    return () => {
      unsub();
      c.stop();
    };
  }, [matchId]);

  const actions = useMemo(() => client?.actions ?? NO_ACTIONS, [client]);
  return useMemo(() => ({ ...snap, actions }), [snap, actions]);
}
