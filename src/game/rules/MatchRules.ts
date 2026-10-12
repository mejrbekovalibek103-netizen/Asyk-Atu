import { sound } from '../audio/sound';
import { zoneEdgePoint } from '../levels/zone';
import type { Piece } from '../physics/PhysicsWorld';
import type { AsykPalette } from '../render/asykShape';
import type { MatchConfig, MatchHud, MatchResult, Seat } from '../types';
import { plural } from '../../ui/format';
import type { NextStep, Rules, RulesHost } from './Rules';

/** Страховка от бесконечного матча: максимум бросков на двоих (чётное — поровну каждому). */
export const MATCH_MAX_THROWS = 30;

/** Оформление игроков: у каждого свой крашеный сақа и браслет. */
export const PLAYER_STYLE: readonly [PlayerStyle, PlayerStyle] = [
  { palette: 'saka', bracelet: '#c8372d', color: '#e0553a' },
  { palette: 'saka2', bracelet: '#6b3fc4', color: '#8b5cf6' },
];

interface PlayerStyle {
  palette: AsykPalette;
  bracelet: string;
  /** Цвет игрока в интерфейсе и во всплывающих очках. */
  color: string;
}

const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

/** Счёт матча для синхронизации устройств. */
export interface MatchState {
  current: Seat;
  turnId: number;
  knocked: [number, number];
  throws: [number, number];
  bestCombo: [number, number];
  total: number;
  finished: boolean;
}

/**
 * Матч вдвоём:
 * - кон общий, игроки бросают строго по очереди — один бросок, и ход переходит;
 * - матч идёт, пока кон не опустеет (или пока не кончится лимит бросков — поровну на каждого);
 * - побеждает тот, кто выбил больше асыков.
 *
 * `localSeat` — для онлайн-режима: какой игрок управляет этим экраном (null — оба, одно устройство).
 */
export class MatchRules implements Rules {
  private host!: RulesHost;
  private current: Seat;
  private turnId = 1;
  private knocked: [number, number] = [0, 0];
  private throws: [number, number] = [0, 0];
  private bestCombo: [number, number] = [0, 0];
  private total = 0;
  private thisThrow = 0;
  private readonly knockedIds = new Set<number>();
  private reason: MatchResult['reason'] = 'cleared';
  private finished = false;
  private started = false;

  constructor(
    private readonly config: MatchConfig,
    private readonly onComplete: (r: MatchResult) => void,
    private readonly localSeat: Seat | null = null,
  ) {
    this.current = config.first;
  }

  attach(host: RulesHost): void {
    this.host = host;
  }

  private name(s: Seat): string {
    return this.config.players[s];
  }

  onStart(): void {
    // жеребьёвка — только в самом первом матче; в реванше и при рестарте очерёдность уже известна
    const toss = !this.config.rematch && !this.started;
    this.started = true;
    const who = this.name(this.current);
    this.host.say(toss ? `Жеребьёвка асыком: первым бросает ${who}` : `Первым бросает ${who}`, 'info', 2600);
  }

  canThrow(): boolean {
    return !this.finished && (this.localSeat === null || this.localSeat === this.current);
  }

  blockedHint(): string {
    return `Сейчас бросает ${this.name(this.current)}`;
  }

  onLaunch(): number {
    this.total += 1;
    this.throws[this.current] += 1;
    this.thisThrow = 0;
    return this.total;
  }

  onKnockout(p: Piece): void {
    if (this.knockedIds.has(p.id) || this.finished) return;
    this.knockedIds.add(p.id);
    this.knocked[this.current] += 1;
    this.thisThrow += 1;
    const pos = p.body.position;
    this.host.effects.chalkBurst(zoneEdgePoint(this.host.layout.zone, pos));
    this.host.effects.popup(pos.x, pos.y - 24, '+1', PLAYER_STYLE[this.current].color, 36);
    sound.knockout(this.thisThrow);
  }

  onSettled(): void {
    const me = this.current;
    const n = this.thisThrow;
    this.bestCombo[me] = Math.max(this.bestCombo[me], n);
    const left = this.host.asyksLeft();
    if (n >= 2) {
      const c = this.host.zoneCenter();
      this.host.effects.popup(c.x, c.y - 40, `КОМБО ×${n}`, '#ffb13b', 40, 1500);
      sound.bonus();
    }
    if (left === 0) {
      this.host.say(`${this.name(me)}: +${n} — кон пуст!`, 'good');
    } else if (this.total >= MATCH_MAX_THROWS) {
      this.host.say('Броски закончились', 'info');
    } else if (n > 0) {
      this.host.say(`${this.name(me)}: +${n} ${plural(n, ['асык', 'асыка', 'асыков'])}! Ход: ${this.name(other(me))}`, 'good', 1600);
    } else {
      this.host.say(`Мимо! Ход: ${this.name(other(me))}`, 'warn', 1600);
      sound.miss();
    }
  }

  next(): NextStep {
    if (this.host.asyksLeft() === 0) {
      this.reason = 'cleared';
      return { kind: 'finish' };
    }
    if (this.total >= MATCH_MAX_THROWS) {
      this.reason = 'limit';
      return { kind: 'finish' };
    }
    // строго по очереди: после каждого броска ход переходит
    this.current = other(this.current);
    this.turnId += 1;
    return { kind: 'continue' };
  }

  onFinish(): void {
    if (this.finished) return;
    this.finished = true;
    const [a, b] = this.knocked;
    const winner: Seat | null = a === b ? null : a > b ? 0 : 1;
    const result: MatchResult = {
      layoutId: this.host.layout.id,
      players: [0, 1].map((i) => ({
        name: this.config.players[i],
        knocked: this.knocked[i],
        throws: this.throws[i],
        bestCombo: this.bestCombo[i],
      })) as MatchResult['players'],
      winner,
      totalThrows: this.total,
      reason: this.reason,
    };
    sound.roundEnd(true);
    this.host.schedule(900, () => this.onComplete(result));
  }

  reset(): void {
    this.current = this.config.first;
    this.turnId += 1;
    this.knocked = [0, 0];
    this.throws = [0, 0];
    this.bestCombo = [0, 0];
    this.total = 0;
    this.thisThrow = 0;
    this.knockedIds.clear();
    this.reason = 'cleared';
    this.finished = false;
  }

  hud(): MatchHud {
    return {
      kind: 'match',
      players: [
        { name: this.config.players[0], knocked: this.knocked[0], throws: this.throws[0] },
        { name: this.config.players[1], knocked: this.knocked[1], throws: this.throws[1] },
      ],
      current: this.current,
      turnId: this.turnId,
      totalThrows: this.total,
      maxThrows: MATCH_MAX_THROWS,
      asyksLeft: this.host.asyksLeft(),
      totalAsyks: this.host.layout.asyks.length,
      localSeat: this.localSeat,
      finished: this.finished,
    };
  }

  exportState(): MatchState {
    return {
      current: this.current,
      turnId: this.turnId,
      knocked: [...this.knocked],
      throws: [...this.throws],
      bestCombo: [...this.bestCombo],
      total: this.total,
      finished: this.finished,
    };
  }

  importState(raw: unknown): void {
    const st = raw as MatchState;
    if (!st || (st.current !== 0 && st.current !== 1)) return;
    this.current = st.current;
    this.turnId = Math.max(this.turnId, st.turnId) + 1;
    this.knocked = [...st.knocked];
    this.throws = [...st.throws];
    this.bestCombo = [...st.bestCombo];
    this.total = st.total;
    this.started = true;
  }

  sakaPalette(): AsykPalette {
    return PLAYER_STYLE[this.current].palette;
  }

  braceletColor(): string {
    return PLAYER_STYLE[this.current].bracelet;
  }
}
