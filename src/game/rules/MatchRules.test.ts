import { describe, expect, it } from 'vitest';
import { PHYS, THROW_ORIGIN } from '../config';
import { getMatchLayout, MATCH_LAYOUTS } from '../levels/matchLayouts';
import { zoneCenter, zoneContains } from '../levels/zone';
import { aimFromAnglePower, throwParams } from '../physics/aim';
import { PhysicsWorld, type Piece } from '../physics/PhysicsWorld';
import { Effects } from '../render/effects';
import type { MatchConfig, MatchResult } from '../types';
import { MATCH_MAX_THROWS, MatchRules } from './MatchRules';
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
    expect(r.winner).toBe(1);
  });

  it('ничья при равном счёте', () => {
    const { play, left, result } = setup(0);
    left.n = 2;
    play(1);
    play(2);
    expect(result()!.winner).toBeNull();
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
