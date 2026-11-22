import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMP_CODE_RE, hashToRoute, normalizeCompCode, oauthReturn, PENDING_ROUTE_TTL_MS, routeToHash, savePendingRoute, takePendingRoute } from './routes';

describe('маршруты: онлайн и коллекция', () => {
  it('«Игра вдвоём», «Онлайн игра» и «Моя коллекция» — разные адреса', () => {
    expect(hashToRoute('#/duel')).toEqual({ name: 'MATCH_SETUP' });
    expect(hashToRoute('#/online')).toEqual({ name: 'ONLINE_SETUP' });
    expect(hashToRoute('#/collection')).toEqual({ name: 'COLLECTION' });
    expect(hashToRoute('#/rating')).toEqual({ name: 'RATING' });
    for (const name of ['MATCH_SETUP', 'ONLINE_SETUP', 'COLLECTION', 'RATING'] as const) expect(hashToRoute(routeToHash({ name }))).toEqual({ name });
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

describe('маршруты соревновательного режима', () => {
  it('#/comp — создание или вход, #/comp/<код> — матч', () => {
    expect(hashToRoute('#/comp')).toEqual({ name: 'COMP_SETUP' });
    expect(hashToRoute('#/comp/ABCDEFGHJK')).toEqual({ name: 'COMP', code: 'ABCDEFGHJK' });
    expect(routeToHash({ name: 'COMP_SETUP' })).toBe('#/comp');
    expect(routeToHash({ name: 'COMP', code: 'ABCDEFGHJK' })).toBe('#/comp/ABCDEFGHJK');
    for (const r of [{ name: 'COMP_SETUP' as const }, { name: 'COMP' as const, code: 'Z2345MNPQR' }]) expect(hashToRoute(routeToHash(r))).toEqual(r);
  });

  it('код из ссылки: строчные буквы и дефис допустимы', () => {
    expect(hashToRoute('#/comp/abcde-fghjk')).toEqual({ name: 'COMP', code: 'ABCDEFGHJK' });
    expect(hashToRoute('#comp/ABCDEFGHJK')).toEqual({ name: 'COMP', code: 'ABCDEFGHJK' });
  });

  it('неверный код в ссылке ведёт на экран входа в режим, мусор — в меню', () => {
    for (const bad of ['#/comp/ABCDEFGHJ', '#/comp/ABCDEFGHJKM', '#/comp/ABCDEFGHI1', '#/comp/OOOOOOOOOO', '#/comp/LLLLLLLLLL'])
      expect(hashToRoute(bad)).toEqual({ name: 'COMP_SETUP' });
    expect(hashToRoute('#/comp/<script>')).toEqual({ name: 'MENU' });
    expect(hashToRoute('#/comp/ABCDEFGHJK/x')).toEqual({ name: 'MENU' });
    expect(hashToRoute('#/compABCDEFGHJK')).toEqual({ name: 'MENU' });
  });

  it('код как join_code в базе: ^[A-HJKMNP-Z2-9]{10}$', () => {
    expect(COMP_CODE_RE.source).toBe('^[A-HJKMNP-Z2-9]{10}$');
    expect(normalizeCompCode('abcde fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeCompCode('ABCDE-FGHJK')).toBe('ABCDEFGHJK');
    for (const bad of [null, 5, '', 'ABCDEFGHJ0', 'ABCDEFGHJ1', 'ABCDEFGHJI', 'ABCDEFGHJL', 'ABCDEFGHJO', 'ABCDEFGHJK'.repeat(5), 'ABCDE_FGHJK'])
      expect(normalizeCompCode(bad)).toBeNull();
  });

  it('у обычной комнаты и матча на асыки разные адреса', () => {
    expect(hashToRoute('#/room/ABCDEFGHJK').name).toBe('ROOM');
    expect(hashToRoute('#/comp/ABCDEFGHJK').name).toBe('COMP');
  });
});

describe('экран после входа через Google', () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
  }
  let store: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    store = fakeStorage();
    vi.stubGlobal('sessionStorage', store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('сохранённый матч забирается один раз', () => {
    savePendingRoute({ name: 'COMP', code: 'ABCDEFGHJK' }, 1000);
    expect(takePendingRoute(2000)).toEqual({ name: 'COMP', code: 'ABCDEFGHJK' });
    expect(takePendingRoute(2000)).toBeNull();
  });

  it('устаревшая запись, запись «из будущего» и меню не уводят игрока', () => {
    savePendingRoute({ name: 'COMP_SETUP' }, 0);
    expect(takePendingRoute(PENDING_ROUTE_TTL_MS + 1)).toBeNull();
    savePendingRoute({ name: 'COMP_SETUP' }, 10 * 60_000);
    expect(takePendingRoute(0)).toBeNull();
    savePendingRoute({ name: 'MENU' }, 0);
    expect(takePendingRoute(1)).toBeNull();
  });

  it('подделанная запись проходит обычный разбор адреса', () => {
    for (const raw of ['x', '{}', '{"h":5,"at":1}', '{"h":"#/comp/<b>","at":1}', 'null', JSON.stringify({ h: 'x'.repeat(300), at: 1 })]) {
      store.raw.set('asyk-atu:after-login', raw);
      expect(takePendingRoute(2)).toBeNull();
      expect(store.raw.has('asyk-atu:after-login')).toBe(false);
    }
    store.raw.set('asyk-atu:after-login', JSON.stringify({ h: '#/comp/abcde-fghjk', at: 1 }));
    expect(takePendingRoute(2)).toEqual({ name: 'COMP', code: 'ABCDEFGHJK' });
  });

  it('без sessionStorage ничего не ломается', () => {
    vi.stubGlobal('sessionStorage', undefined);
    savePendingRoute({ name: 'COMP_SETUP' });
    expect(takePendingRoute()).toBeNull();
  });
});
