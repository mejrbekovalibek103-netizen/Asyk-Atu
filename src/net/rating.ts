import { cleanName, NAME_MAX } from '../ui/format';
import { getSupabase } from './client';

/**
 * Рейтинг и профиль игрока (supabase/rating.sql). Всё считает база; здесь — вызовы и строгий разбор ответов.
 * Наружу база отдаёт только номер игрока (player_no), ник и счётчики — ни почты, ни внутренних id.
 */

export const RATING_SORTS = ['asyks', 'wins', 'played'] as const;
export type RatingSort = (typeof RATING_SORTS)[number];

export interface RatingRow {
  place: number;
  /** Номер игрока («ID»), по нему игрок видит себя в «Игрок N». */
  playerNo: number;
  name: string;
  asyks: number;
  wins: number;
  played: number;
  me: boolean;
}

export interface Leaderboard {
  sort: RatingSort;
  total: number;
  rows: RatingRow[];
  /** Моя строка (даже если я не в топе); null — без входа. */
  me: RatingRow | null;
}

export interface MyProfile {
  nickname: string | null;
  /** Как меня видно в рейтинге: ник или «Игрок N». */
  name: string;
  playerNo: number;
  asyks: number;
  free: number;
  locked: number;
  wins: number;
  played: number;
}

export const RATING_ERROR_TEXT = {
  nick_short: 'Ник — хотя бы 2 символа.',
  nick_chars: 'Только буквы, цифры, пробел, точка, дефис и _; нужна хотя бы одна буква.',
  nick_reserved: 'Такой ник занят игрой — выбери другой.',
  nick_taken: 'Этот ник уже занят.',
  rate_limited: 'Слишком часто. Подожди немного.',
  google_required: 'Нужен вход через Google.',
  not_signed_in: 'Войди через Google.',
  no_profile: 'Профиль не создан. Открой «Мою коллекцию».',
  banned: 'Аккаунт заблокирован.',
  setup: 'Рейтинг ещё не настроен на сервере.',
  bad_response: 'Сервер ответил непонятно. Обнови страницу.',
  network: 'Нет связи. Проверь интернет.',
  server: 'Сбой сервера. Попробуй ещё раз.',
} as const;
export type RatingErrorCode = keyof typeof RATING_ERROR_TEXT;

export class RatingError extends Error {
  readonly code: RatingErrorCode;
  constructor(code: RatingErrorCode) {
    super(code);
    this.name = 'RatingError';
    this.code = code;
  }
  get text(): string {
    return RATING_ERROR_TEXT[this.code];
  }
}

export function ratingErrorText(e: unknown): string {
  return e instanceof RatingError ? e.text : RATING_ERROR_TEXT.network;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const COUNT_MAX = 10_000_000;
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNT_MAX ? v : null);
const isSort = (v: unknown): v is RatingSort => typeof v === 'string' && (RATING_SORTS as readonly string[]).includes(v);

/** Ошибка PostgREST → RatingError (известный текст из `raise exception`, иначе по SQLSTATE). */
export function ratingErrorFromDb(err: { message?: unknown; code?: unknown } | null | undefined): RatingError {
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  if (Object.prototype.hasOwnProperty.call(RATING_ERROR_TEXT, message)) return new RatingError(message as RatingErrorCode);
  if (code === 'PGRST202' || code === '42883' || code === '42P01' || code === 'PGRST205') return new RatingError('setup');
  if (code === '28000') return new RatingError('not_signed_in');
  if (code === '42501') return new RatingError('google_required');
  return new RatingError(code ? 'server' : 'network');
}

/** Имя из сети: чистим так же, как имена в матче (управляющие и невидимые символы, длина). */
const safeName = (v: unknown, playerNo: number): string => cleanName(typeof v === 'string' ? v : '', `Игрок ${playerNo}`);

export function parseRatingRow(raw: unknown): RatingRow | null {
  if (!isObj(raw)) return null;
  const place = count(raw.place);
  const playerNo = count(raw.player_no);
  const asyks = count(raw.asyks);
  const wins = count(raw.wins);
  const played = count(raw.played);
  if (place === null || place < 1 || playerNo === null || asyks === null || wins === null || played === null || typeof raw.me !== 'boolean') return null;
  return { place, playerNo, name: safeName(raw.name, playerNo), asyks, wins, played, me: raw.me };
}

export function parseLeaderboard(raw: unknown): Leaderboard | null {
  if (!isObj(raw) || !isSort(raw.sort) || !Array.isArray(raw.rows) || raw.rows.length > 100) return null;
  const total = count(raw.total);
  if (total === null) return null;
  const rows: RatingRow[] = [];
  for (const r of raw.rows) {
    const row = parseRatingRow(r);
    if (!row) return null;
    rows.push(row);
  }
  let me: RatingRow | null = null;
  if (raw.me !== null && raw.me !== undefined) {
    me = parseRatingRow(raw.me);
    if (!me) return null;
  }
  return { sort: raw.sort, total, rows, me };
}

export function parseMyProfile(raw: unknown): MyProfile | null {
  if (!isObj(raw)) return null;
  const playerNo = count(raw.player_no);
  const nums = [raw.asyks, raw.free, raw.locked, raw.wins, raw.played].map(count);
  if (playerNo === null || nums.some((n) => n === null)) return null;
  if (raw.nickname !== null && typeof raw.nickname !== 'string') return null;
  const [asyks, free, locked, wins, played] = nums as number[];
  const nickname = typeof raw.nickname === 'string' ? cleanName(raw.nickname, '') || null : null;
  return { nickname, name: safeName(raw.name, playerNo), playerNo, asyks, free, locked, wins, played };
}

/**
 * Проверка ника до отправки (база проверяет то же самое ещё раз). Пустой ник — «убрать ник».
 * Возвращает очищенный ник или код ошибки.
 */
export function checkNickname(raw: string): { ok: true; value: string } | { ok: false; error: RatingErrorCode } {
  const v = cleanName(raw, '');
  if (v === '') return { ok: true, value: '' };
  if (Array.from(v).length < 2) return { ok: false, error: 'nick_short' };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(v) || !/\p{L}/u.test(v)) return { ok: false, error: 'nick_chars' };
  if (/^(игрок|player|ойыншы)[ ._-]*\d*$/iu.test(v) || /(admin|админ|модератор|moderator)/iu.test(v)) return { ok: false, error: 'nick_reserved' };
  return { ok: true, value: v };
}

export { NAME_MAX as NICK_MAX };

export async function fetchLeaderboard(sort: RatingSort, limit = 50): Promise<Leaderboard> {
  const { data, error } = await getSupabase().rpc('leaderboard', { p_sort: sort, p_limit: limit });
  if (error) throw ratingErrorFromDb(error);
  const lb = parseLeaderboard(data);
  if (!lb) throw new RatingError('bad_response');
  return lb;
}

export async function fetchMyProfile(): Promise<MyProfile> {
  const { data, error } = await getSupabase().rpc('my_profile');
  if (error) throw ratingErrorFromDb(error);
  const p = parseMyProfile(data);
  if (!p) throw new RatingError('bad_response');
  return p;
}

export async function saveNickname(raw: string): Promise<MyProfile> {
  const checked = checkNickname(raw);
  if (!checked.ok) throw new RatingError(checked.error);
  const { data, error } = await getSupabase().rpc('set_nickname', { p_name: checked.value });
  if (error) throw ratingErrorFromDb(error);
  const p = parseMyProfile(data);
  if (!p) throw new RatingError('bad_response');
  return p;
}
