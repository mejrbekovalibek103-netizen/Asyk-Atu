import { describe, expect, it } from 'vitest';
import { checkNickname, parseLeaderboard, parseMyProfile, ratingErrorFromDb } from './rating';

const row = (over: Record<string, unknown> = {}) => ({ place: 1, player_no: 7, name: 'Алибек', asyks: 12, wins: 3, played: 5, me: false, ...over });

describe('рейтинг: разбор ответа базы', () => {
  it('нормальный ответ', () => {
    const lb = parseLeaderboard({ sort: 'wins', total: 2, rows: [row(), row({ place: 2, player_no: 9, name: 'Игрок 9', me: true })], me: row({ place: 2, player_no: 9, me: true }) });
    expect(lb?.rows).toHaveLength(2);
    expect(lb?.rows[1]).toMatchObject({ playerNo: 9, name: 'Игрок 9', me: true });
    expect(lb?.me?.place).toBe(2);
  });

  it('без входа me = null', () => {
    expect(parseLeaderboard({ sort: 'asyks', total: 0, rows: [], me: null })?.me).toBeNull();
  });

  it('мусор — отказ целиком', () => {
    expect(parseLeaderboard(null)).toBeNull();
    expect(parseLeaderboard({ sort: 'money', total: 0, rows: [], me: null })).toBeNull();
    expect(parseLeaderboard({ sort: 'asyks', total: 1, rows: [row({ asyks: -1 })], me: null })).toBeNull();
    expect(parseLeaderboard({ sort: 'asyks', total: 1, rows: [row({ wins: 1.5 })], me: null })).toBeNull();
    expect(parseLeaderboard({ sort: 'asyks', total: 1, rows: [row({ place: 0 })], me: null })).toBeNull();
    expect(parseLeaderboard({ sort: 'asyks', total: 1, rows: Array.from({ length: 101 }, () => row()), me: null })).toBeNull();
  });

  it('имя чистится от управляющих символов; пустое — «Игрок N»', () => {
    const lb = parseLeaderboard({ sort: 'asyks', total: 2, rows: [row({ name: 'А‮либек' }), row({ place: 2, player_no: 5, name: '' })], me: null });
    expect(lb?.rows.map((r) => r.name)).toEqual(['Алибек', 'Игрок 5']);
  });

  it('профиль', () => {
    expect(parseMyProfile({ nickname: null, name: 'Игрок 7', player_no: 7, asyks: 10, free: 5, locked: 5, wins: 0, played: 1 })).toEqual({
      nickname: null,
      name: 'Игрок 7',
      playerNo: 7,
      asyks: 10,
      free: 5,
      locked: 5,
      wins: 0,
      played: 1,
    });
    expect(parseMyProfile({ nickname: 5, name: 'x', player_no: 7, asyks: 10, free: 5, locked: 5, wins: 0, played: 1 })).toBeNull();
    expect(parseMyProfile({ nickname: null, name: 'x', player_no: 7, asyks: 10, free: 5, locked: 5, wins: 0 })).toBeNull();
  });
});

describe('ник: проверка до отправки', () => {
  it('принимает и чистит', () => {
    expect(checkNickname('  Алибек_7  ')).toEqual({ ok: true, value: 'Алибек_7' });
    expect(checkNickname('Әлібек')).toEqual({ ok: true, value: 'Әлібек' });
    expect(checkNickname('')).toEqual({ ok: true, value: '' });
  });
  it('отказы', () => {
    expect(checkNickname('А')).toEqual({ ok: false, error: 'nick_short' });
    expect(checkNickname('<b>x</b>')).toEqual({ ok: false, error: 'nick_chars' });
    expect(checkNickname('1234')).toEqual({ ok: false, error: 'nick_chars' });
    expect(checkNickname('Игрок 12')).toEqual({ ok: false, error: 'nick_reserved' });
    expect(checkNickname('SuperAdmin')).toEqual({ ok: false, error: 'nick_reserved' });
  });
});

describe('ошибки базы', () => {
  it('известные коды и запасные', () => {
    expect(ratingErrorFromDb({ message: 'nick_taken', code: 'P0001' }).code).toBe('nick_taken');
    expect(ratingErrorFromDb({ message: 'x', code: 'PGRST202' }).code).toBe('setup');
    expect(ratingErrorFromDb({ message: 'x', code: '42501' }).code).toBe('google_required');
    expect(ratingErrorFromDb({ message: '' }).code).toBe('network');
  });
});
