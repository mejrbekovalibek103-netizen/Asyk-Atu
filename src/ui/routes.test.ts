import { describe, expect, it } from 'vitest';
import { hashToRoute, oauthReturn, routeToHash } from './routes';

describe('маршруты: онлайн и коллекция', () => {
  it('«Игра вдвоём», «Онлайн игра» и «Моя коллекция» — разные адреса', () => {
    expect(hashToRoute('#/duel')).toEqual({ name: 'MATCH_SETUP' });
    expect(hashToRoute('#/online')).toEqual({ name: 'ONLINE_SETUP' });
    expect(hashToRoute('#/collection')).toEqual({ name: 'COLLECTION' });
    for (const name of ['MATCH_SETUP', 'ONLINE_SETUP', 'COLLECTION'] as const) expect(hashToRoute(routeToHash({ name }))).toEqual({ name });
  });

  it('неизвестный адрес ведёт в меню', () => {
    expect(hashToRoute('#/collection/../x')).toEqual({ name: 'MENU' });
    expect(hashToRoute('#/<script>')).toEqual({ name: 'MENU' });
  });
});

describe('возврат со страницы входа Google', () => {
  it('код в адресе без # — вход удался', () => {
    expect(oauthReturn('?code=abc123', '')).toEqual({ error: false });
    expect(oauthReturn('?code=abc123', '#/')).toEqual({ error: false });
  });

  it('ошибка в адресе — вход не удался', () => {
    expect(oauthReturn('?error=access_denied&error_description=x', '')).toEqual({ error: true });
    expect(oauthReturn('?error_description=x&code=abc', '')).toEqual({ error: true });
  });

  it('обычное открытие сайта и ссылки на экраны не считаются возвратом', () => {
    expect(oauthReturn('', '')).toBeNull();
    expect(oauthReturn('?utm=1', '')).toBeNull();
    // параметр code рядом со ссылкой на комнату не уводит игрока на экран коллекции
    expect(oauthReturn('?code=abc', '#/room/ABCDEFGHJK')).toBeNull();
    expect(oauthReturn('?error=x', '#/levels')).toBeNull();
  });
});
