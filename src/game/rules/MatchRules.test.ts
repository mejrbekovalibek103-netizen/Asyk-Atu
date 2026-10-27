import { describe, expect, it } from 'vitest';
import { PHYS, THROW_ORIGIN } from '../config';
import { getMatchLayout, MATCH_LAYOUTS } from '../levels/matchLayouts';
import { zoneCenter, zoneContains } from '../levels/zone';
import { aimFromAnglePower, throwParams } from '../physics/aim';
import { PhysicsWorld, type Piece } from '../physics/PhysicsWorld';
import { Effects } from '../render/effects';
import type { MatchConfig, MatchResult } from '../types';
import { matchThrowLimit, MatchRules } from './MatchRules';
import { parseMatchState } from './matchState';

const MATCH_MAX_THROWS = matchThrowLimit(2);
import type { RulesHost } from './Rules';

const layout = getMatchLayout('ulken-kon');
const config: MatchConfig = { layoutId: layout.id, players: ['Айдос', 'Дана'], first: 0 };

/** Хост без DOM: отложенные действия выполняются сразу, асыки в коне задаются тестом. */
function fakeHost(left: { n: number }): RulesHost {
  return {
    layout,
    effects: new Effects(true),
    say: () => undefined,
    schedule: (_ms, fn) => fn(),
    asyksLeft: () => left.n,
    zoneCenter: () => zoneCenter(layout.zone),
  };
}

const piece = (id: number) => ({ id, kind: 'asyk', body: { position: { x: 400, y: 300 } } }) as unknown as Piece;

function setup(first: 0 | 1 = 0, localSeat: 0 | 1 | null = null, handoff = false) {
  const left = { n: layout.asyks.length };
  let result: MatchResult | null = null;
  const rules = new MatchRules({ ...config, first, handoff }, (r) => (result = r), localSeat);
  rules.attach(fakeHost(left));
  /** Один бросок: выбивает указанные id. */
  const play = (...ids: number[]) => {
    rules.onLaunch();
    for (const id of ids) {
      rules.onKnockout(piece(id));
      left.n -= 1;
    }
    rules.onSettled();
    const step = rules.next();
    if (step.kind === 'finish') rules.onFinish();
    return step;
  };
  return { rules, left, play, result: () => result };
}

describe('MatchRules: очередь ходов', () => {
  it('строго по очереди: ход переходит и после попадания, и после промаха', () => {
    const { rules, play } = setup(0);
    expect(rules.hud().current).toBe(0);
    const turn = rules.hud().turnId;
    play(1); // попал
    expect(rules.hud().current).toBe(1);
    expect(rules.hud().turnId).toBe(turn + 1);
    play(); // промах
    expect(rules.hud().current).toBe(0);
    play(2, 3); // комбо — всё равно ход переходит
    expect(rules.hud().current).toBe(1);
    const h = rules.hud();
    expect(h.players[0]).toMatchObject({ knocked: 3, throws: 2 });
    expect(h.players[1]).toMatchObject({ knocked: 0, throws: 1 });
  });

  it('первым бросает игрок из жеребьёвки', () => {
    expect(setup(1).rules.hud().current).toBe(1);
  });

  it('один асык не засчитывается дважды', () => {
    const { rules } = setup(0);
    rules.onLaunch();
    rules.onKnockout(piece(5));
    rules.onKnockout(piece(5));
    expect(rules.hud().players[0].knocked).toBe(1);
  });

  it('в онлайне бросать можно только в свой ход', () => {
    const { rules, play } = setup(0, 1);
    expect(rules.canThrow()).toBe(false);
    play(); // игрок 0 промахнулся
    expect(rules.canThrow()).toBe(true);
    expect(setup(0, null).rules.canThrow()).toBe(true);
  });
});

describe('MatchRules: передача устройства (одно устройство)', () => {
  it('до нажатия «Готов» бросок заблокирован — и в начале матча, и после каждого броска', () => {
    const { rules, play } = setup(0, null, true);
    expect(rules.hud().handoff).toBe(true);
    expect(rules.canThrow()).toBe(false);
    expect(rules.blockedHint()).toContain('Айдос');
    rules.confirmHandoff();
    expect(rules.canThrow()).toBe(true);
    expect(rules.hud().handoff).toBe(false);

    play(1); // попал — ход всё равно переходит
    expect(rules.hud().current).toBe(1);
    expect(rules.canThrow()).toBe(false);
    expect(rules.blockedHint()).toContain('Дана');
    rules.confirmHandoff();
    expect(rules.canThrow()).toBe(true);

    play(); // промах
    expect(rules.hud().current).toBe(0);
    expect(rules.canThrow()).toBe(false);
  });

  it('повторное «Готов» безвредно, а блокировка возвращается на следующем ходу', () => {
    const { rules, play } = setup(1, null, true);
    rules.confirmHandoff();
    rules.confirmHandoff();
    expect(rules.canThrow()).toBe(true);
    play();
    expect(rules.canThrow()).toBe(false);
  });

  it('выключенная передача не мешает (по умолчанию)', () => {
    const { rules, play } = setup(0, null, false);
    expect(rules.canThrow()).toBe(true);
    play();
    expect(rules.canThrow()).toBe(true);
    expect(rules.hud().handoff).toBe(false);
  });

  it('в онлайне передача не используется, даже если флаг включён', () => {
    const { rules } = setup(0, 0, true);
    expect(rules.hud().handoff).toBe(false);
    expect(rules.canThrow()).toBe(true);
  });

  it('рестарт матча снова требует «Готов», а в конце матча экран передачи не показывается', () => {
    const { rules, play, left } = setup(0, null, true);
    rules.confirmHandoff();
    play();
    rules.confirmHandoff();
    rules.reset();
    expect(rules.canThrow()).toBe(false);
    expect(rules.hud().handoff).toBe(true);
    rules.confirmHandoff();
    left.n = 1;
    play(1); // кон опустел — матч закончен
    expect(rules.hud().finished).toBe(true);
    expect(rules.hud().handoff).toBe(false);
  });
});

describe('MatchRules: жеребьёвка', () => {
  const said = (cfg: MatchConfig) => {
    const msgs: string[] = [];
    const rules = new MatchRules(cfg, () => undefined);
    rules.attach({ ...fakeHost({ n: 12 }), say: (t) => msgs.push(t) });
    rules.onStart();
    rules.reset();
    rules.onStart(); // рестарт матча
    return msgs;
  };

  it('жеребьёвка объявляется только в первом матче', () => {
    expect(said(config)).toEqual(['Жеребьёвка асыком: первым бросает Айдос', 'Первым бросает Айдос']);
  });

  it('в реванше жеребьёвки нет', () => {
    expect(said({ ...config, first: 1, rematch: true })[0]).toBe('Первым бросает Дана');
  });
});

describe('MatchRules: конец матча', () => {
  it('кон пуст — победил тот, кто выбил больше', () => {
    const { play, left, result } = setup(0);
    const n = left.n;
    play(); // игрок 0 промахнулся
    play(1, 2, 3); // игрок 1: комбо ×3
    let id = 10;
    let step = play(id++);
    while (step.kind !== 'finish') step = play(id++);
    const r = result()!;
    expect(r.reason).toBe('cleared');
    expect(r.players[0].knocked + r.players[1].knocked).toBe(n);
    expect(r.players[1].knocked).toBeGreaterThan(r.players[0].knocked);
    expect(r.winners).toEqual([1]);
  });

  it('ничья при равном счёте', () => {
    const { play, left, result } = setup(0);
    left.n = 2;
    play(1);
    play(2);
    expect(result()!.winners).toEqual([0, 1]); // ничья: победителей двое
  });

  it('лимит бросков завершает матч', () => {
    const { play, result } = setup(0);
    let step = play();
    let count = 1;
    while (step.kind !== 'finish') {
      step = play();
      count++;
    }
    expect(count).toBe(MATCH_MAX_THROWS);
    expect(result()!.reason).toBe('limit');
    // поровну каждому
    expect(result()!.players[0].throws).toBe(MATCH_MAX_THROWS / 2);
    expect(result()!.players[1].throws).toBe(MATCH_MAX_THROWS / 2);
  });

  it('после конца матча новые выбитые не засчитываются, рестарт обнуляет счёт', () => {
    const { rules, play, left, result } = setup(0);
    left.n = 1;
    play(1);
    expect(result()!.players[0].knocked).toBe(1);
    rules.onKnockout(piece(2));
    expect(rules.hud().players[0].knocked).toBe(1);
    rules.reset();
    expect(rules.hud().players[0].knocked).toBe(0);
    expect(rules.canThrow()).toBe(true);
  });
});

describe('расстановки для матча', () => {
  for (const l of MATCH_LAYOUTS) {
    it(`${l.name}: асыки внутри кона, кон внутри двора`, () => {
      for (const a of l.asyks) expect(zoneContains(l.zone, a)).toBe(true);
      if (l.zone.kind === 'rect') {
        expect(l.zone.x).toBeGreaterThan(16);
        expect(l.zone.x + l.zone.w).toBeLessThan(800 - 16);
      }
    });
  }
});

describe('матч целиком на настоящей физике', () => {
  it('матч заканчивается, а счёт совпадает с выбитыми асыками', () => {
    // детерминированный «игрок»: целится в случайный оставшийся асык с силой 0.75–1
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const world = new PhysicsWorld();
    world.addAsyks(layout.asyks);
    let result: MatchResult | null = null;
    const rules = new MatchRules(config, (r) => (result = r));
    rules.attach({ ...fakeHost({ n: 0 }), asyksLeft: () => world.asyksIn().length });

    for (let guard = 0; guard < MATCH_MAX_THROWS + 1 && !result; guard++) {
      const targets = world.asyksIn();
      const t = targets[Math.floor(rnd() * targets.length)].body.position;
      const angle = Math.atan2(t.x - THROW_ORIGIN.x, THROW_ORIGIN.y - t.y);
      const p = throwParams(aimFromAnglePower(angle, 0.75 + rnd() * 0.25), rnd, true);
      const throwIndex = rules.onLaunch();
      world.launchSaka(THROW_ORIGIN, p.angle, p.speed, p.spin);
      let settled = 0;
      for (let ms = 0; ms < PHYS.maxThrowMs; ms += PHYS.stepMs) {
        world.step();
        for (const k of world.checkKnockouts(layout.zone, throwIndex)) rules.onKnockout(k);
        settled = world.isSettled() ? settled + PHYS.stepMs : 0;
        if (settled >= PHYS.settleMs) break;
      }
      world.removeSaka();
      rules.onSettled();
      const step = rules.next();
      if (step.kind === 'finish') rules.onFinish();
    }

    expect(result).not.toBeNull();
    const r = result!;
    const knocked = layout.asyks.length - world.asyksIn().length;
    expect(r.players[0].knocked + r.players[1].knocked).toBe(knocked);
    if (r.reason === 'cleared') expect(knocked).toBe(layout.asyks.length);
    expect(r.totalThrows).toBeLessThanOrEqual(MATCH_MAX_THROWS);
  });
});


describe('MatchRules: трое и четверо (онлайн)', () => {
  const big = getMatchLayout('korgan'); // 16 асыков
  function setupN(names: string[], first: 0 | 1 | 2 | 3 = 0) {
    const left = { n: big.asyks.length };
    let result: MatchResult | null = null;
    const said: string[] = [];
    const host: RulesHost = { ...fakeHost(left), layout: big, say: (t) => void said.push(t) };
    const rules = new MatchRules({ layoutId: big.id, players: names, first }, (r) => (result = r), null);
    rules.attach(host);
    const play = (...ids: number[]) => {
      rules.onLaunch();
      for (const id of ids) {
        rules.onKnockout(piece(id));
        left.n -= 1;
      }
      rules.onSettled();
      const step = rules.next();
      if (step.kind === 'finish') rules.onFinish();
      return step;
    };
    return { rules, left, play, said, result: () => result };
  }

  it('ход идёт по кругу: 2 → 3 → 0 → 1 …', () => {
    const { rules, play } = setupN(['А', 'Б', 'В', 'Г'], 2);
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      order.push(rules.hud().current);
      play();
    }
    expect(order).toEqual([2, 3, 0, 1, 2, 3]);
  });

  it('по 10 бросков на каждого: у троих 30, у четверых 40', () => {
    for (const names of [['А', 'Б', 'В'], ['А', 'Б', 'В', 'Г']]) {
      const { rules, play, result } = setupN(names);
      expect(rules.hud()).toMatchObject({ maxThrows: names.length * 10, throwsPerPlayer: 10 });
      let count = 0;
      let step = play();
      count++;
      while (step.kind !== 'finish') {
        step = play();
        count++;
      }
      expect(count).toBe(names.length * 10);
      expect(result()!.players.every((p) => p.throws === 10)).toBe(true);
      expect(result()!.reason).toBe('limit');
    }
  });

  it('победители: один или несколько при равенстве', () => {
    const a = setupN(['А', 'Б', 'В']);
    a.play(1, 2); // А: 2
    a.play(3); // Б: 1
    a.play(4, 5); // В: 2
    a.left.n = 0;
    a.play();
    expect(a.result()!.winners).toEqual([0, 2]);
    const b = setupN(['А', 'Б', 'В', 'Г']);
    b.play();
    b.play(1, 2, 3);
    b.left.n = 0;
    b.play();
    expect(b.result()!.winners).toEqual([1]);
  });

  it('пропуск хода отсутствующего: засчитывается как бросок мимо, только для текущего хода', () => {
    const { rules, said } = setupN(['А', 'Б', 'В']);
    const { current } = rules.hud();
    const throwNo = rules.hud().totalThrows + 1; // номер броска — одинаков у всех игроков
    expect(rules.skipTurn((current + 1) as 1, throwNo)).toBe(false); // не его ход
    expect(rules.skipTurn(current, throwNo + 1)).toBe(false); // чужой номер броска
    expect(rules.skipTurn(current, throwNo)).toBe(true);
    expect(rules.hud().players[current].throws).toBe(1);
    expect(rules.hud().totalThrows).toBe(1);
    expect(said.at(-1)).toContain('ход пропущен');
    expect(rules.next().kind).toBe('continue');
    expect(rules.hud().current).toBe(1);
    expect(rules.skipTurn(0, throwNo)).toBe(false); // повторный пропуск того же хода ничего не меняет
  });

  it('у двоих пропусков не бывает (ждём возвращения соперника)', () => {
    const { rules } = setup(0, 1);
    expect(rules.skipTurn(0, rules.hud().totalThrows + 1)).toBe(false);
  });

  it('состояние на четверых экспортируется и принимается целиком', () => {
    const a = setupN(['А', 'Б', 'В', 'Г'], 1);
    a.play(1);
    a.play();
    a.play(2, 3);
    const st = a.rules.exportState();
    expect(st.throws).toEqual([0, 1, 1, 1]);
    const b = setupN(['А', 'Б', 'В', 'Г'], 1);
    b.rules.importState(JSON.parse(JSON.stringify(st)));
    expect(b.rules.hud()).toMatchObject({ current: 0, totalThrows: 3 });
    expect(b.rules.hud().players.map((p) => p.knocked)).toEqual([0, 1, 0, 2]);
  });
});

describe('parseMatchState: состояние на 2–4 игрока', () => {
  const ok4 = { current: 2, turnId: 5, knocked: [1, 0, 2, 0], throws: [1, 1, 1, 1], bestCombo: [1, 0, 2, 0], total: 4, finished: false };

  it('честное состояние читается для своего числа игроков, лишние поля отбрасываются', () => {
    expect(parseMatchState({ ...ok4, evil: 1 }, 16, 4)).toEqual(ok4);
    expect(parseMatchState(ok4, 16, 3)).toBeNull(); // массивы на четверых, а игроков трое
    expect(parseMatchState(ok4, 16, 5)).toBeNull();
    expect(parseMatchState(ok4, 16, 1)).toBeNull();
  });

  it('противоречия: броски не по кругу, сумма не сходится, место вне стола, лимит превышен', () => {
    expect(parseMatchState({ ...ok4, throws: [2, 0, 1, 1] }, 16, 4)).toBeNull(); // разница больше одного броска
    expect(parseMatchState({ ...ok4, total: 5 }, 16, 4)).toBeNull();
    expect(parseMatchState({ ...ok4, current: 4 }, 16, 4)).toBeNull();
    expect(parseMatchState({ ...ok4, throws: [11, 11, 11, 11], total: 44 }, 16, 4)).toBeNull(); // больше 10 на каждого
    expect(parseMatchState({ ...ok4, knocked: [9, 0, 9, 0], bestCombo: [1, 0, 2, 0] }, 16, 4)).toBeNull(); // выбито больше асыков, чем есть
  });
});
