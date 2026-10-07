import { sound } from '../audio/sound';
import type { Piece } from '../physics/PhysicsWorld';
import type { AsykPalette } from '../render/asykShape';
import { computeStars, isGoalMet, ScoreKeeper } from '../scoring/scoring';
import type { LevelConfig, RoundResult, SoloHud, ThrowSummary } from '../types';
import { plural } from '../../ui/format';
import { zoneEdgePoint } from '../levels/zone';
import type { NextStep, Rules, RulesHost } from './Rules';

/**
 * Одиночное испытание: ограниченное число бросков, очки, комбо, серии, звёзды.
 * Первый бросок при обучении — пробный: не тратит попытку, после него кон восстанавливается.
 */
export class SoloRules implements Rules {
  private host!: RulesHost;
  private scorer = new ScoreKeeper();
  private throwsUsed = 0;
  private knockedThisThrow = 0;
  private lastThrow: ThrowSummary | null = null;
  private cleared = false;

  constructor(
    private readonly level: LevelConfig,
    private practice: boolean,
    private readonly onComplete: (r: RoundResult) => void,
  ) {}

  attach(host: RulesHost): void {
    this.host = host;
  }

  onStart(): void {}

  canThrow(): boolean {
    return true;
  }

  blockedHint(): string {
    return '';
  }

  onLaunch(): number {
    this.knockedThisThrow = 0;
    if (this.practice) return 0;
    this.throwsUsed += 1;
    return this.throwsUsed;
  }

  onKnockout(p: Piece, throwIndex: number): void {
    const pts = this.scorer.registerKnockout(p.id, p.kind === 'target', throwIndex);
    if (pts <= 0) return;
    this.knockedThisThrow += 1;
    const pos = p.body.position;
    this.host.effects.chalkBurst(zoneEdgePoint(this.level.zone, pos));
    this.host.effects.popup(pos.x, pos.y - 24, `+${pts}`, p.kind === 'target' ? '#7fd9ee' : '#ffd84d', p.kind === 'target' ? 40 : 34);
    sound.knockout(this.knockedThisThrow);
  }

  onSettled(throwIndex: number): void {
    const ts = this.scorer.resolveThrow(throwIndex);
    if (!ts) return;
    this.lastThrow = {
      index: ts.throwIndex,
      knocked: ts.knocked,
      points: ts.points,
      comboBonus: ts.comboBonus,
      streakBonus: ts.streakBonus,
      streak: ts.streak,
      targetKnocked: ts.targetKnocked,
      practice: this.practice,
    };
    const c = this.host.zoneCenter();
    const fx = this.host.effects;
    if (ts.knocked === 0) {
      this.host.say('Мимо! Целься точнее или бросай сильнее', 'warn');
      sound.miss();
    } else if (ts.comboBonus > 0) {
      fx.popup(c.x, c.y - 40, `КОМБО ×${ts.knocked}  +${ts.comboBonus}`, '#ffb13b', 40, 1500);
      this.host.say(`Комбо! ${ts.knocked} ${plural(ts.knocked, ['асык', 'асыка', 'асыков'])} одним броском`, 'good');
      sound.bonus();
    } else if (ts.targetKnocked) {
      this.host.say('Синий асык выбит!', 'good');
    } else {
      this.host.say(`Выбит ${ts.knocked} ${plural(ts.knocked, ['асык', 'асыка', 'асыков'])}`, 'good', 1400);
    }
    if (ts.streakBonus > 0) {
      fx.popup(c.x, c.y + 10, `СЕРИЯ ×${ts.streak}  +${ts.streakBonus}`, '#9be15d', 32, 1500);
      if (ts.comboBonus === 0) sound.bonus();
    }
  }

  next(): NextStep {
    if (this.practice) {
      // пробный бросок обучения не считается: кон восстанавливается
      this.practice = false;
      const n = this.level.throws;
      return { kind: 'reset', message: `Отлично! Теперь по-настоящему: ${n} ${plural(n, ['бросок', 'броска', 'бросков'])}` };
    }
    this.cleared = this.host.asyksLeft() === 0;
    if (this.cleared || this.level.throws - this.throwsUsed <= 0) return { kind: 'finish' };
    return { kind: 'continue' };
  }

  onFinish(): void {
    const remaining = this.level.throws - this.throwsUsed;
    const cleared = this.cleared;
    const clean = this.scorer.finishRound(remaining, cleared);
    if (clean > 0) {
      const c = this.host.zoneCenter();
      this.host.effects.popup(c.x, c.y, `ТАЗА КОН!  +${clean}`, '#ffd84d', 42, 1800);
      this.host.say(`Таза кон! Бонус за ${remaining} ${plural(remaining, ['бросок', 'броска', 'бросков'])}`, 'good');
      sound.bonus();
    }
    const s = this.scorer;
    const input = { knocked: s.knocked, totalAsyks: this.level.asyks.length, score: s.score, cleared, targetThrow: s.targetThrow };
    const result: RoundResult = {
      levelId: this.level.id,
      score: s.score,
      knocked: s.knocked,
      totalAsyks: this.level.asyks.length,
      throwsUsed: this.throwsUsed,
      throwsTotal: this.level.throws,
      cleared,
      cleanBonus: clean,
      targetOut: s.targetThrow !== null,
      targetThrow: s.targetThrow,
      bestCombo: s.bestCombo,
      hitThrows: s.hitThrows,
      passed: isGoalMet(this.level, input),
      stars: computeStars(this.level, input),
    };
    sound.roundEnd(result.passed);
    this.host.schedule(clean > 0 ? 1300 : 700, () => this.onComplete(result));
  }

  reset(): void {
    this.scorer = new ScoreKeeper();
    this.throwsUsed = 0;
    this.knockedThisThrow = 0;
    this.lastThrow = null;
    this.cleared = false;
  }

  /** Обучение ещё идёт (для движка: подсказки и сброс при рестарте). */
  isPractice(): boolean {
    return this.practice;
  }

  hud(): SoloHud {
    const s = this.scorer;
    return {
      kind: 'solo',
      throwsUsed: this.throwsUsed,
      throwsTotal: this.level.throws,
      score: s.score,
      knocked: s.knocked,
      totalAsyks: this.level.asyks.length,
      hasTarget: this.level.asyks.some((a) => a.kind === 'target'),
      targetOut: s.targetThrow !== null,
      streak: s.streak,
      practice: this.practice,
      lastThrow: this.lastThrow,
    };
  }

  sakaPalette(): AsykPalette {
    return 'saka';
  }

  braceletColor(): string {
    return '#c8372d';
  }
}
