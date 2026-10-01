import { sound } from '../audio/sound';
import { KNOCKOUT_FADE_MS, PHYS, RELEASE_DELAY_MS, RESOLVE_PAUSE_MS, THROW_LINE_Y, THROW_ORIGIN } from '../config';
import { AimInput, type InputTarget } from '../input/AimInput';
import { zoneCenter, zoneEdgePoint } from '../levels/zone';
import { aimDirection, aimFromAnglePower, aimFromPoint, throwParams, type Aim, type ThrowParams } from '../physics/aim';
import { PhysicsWorld, type ContactEvent, type Piece } from '../physics/PhysicsWorld';
import { Effects } from '../render/effects';
import { Renderer, type HandAnim, type SceneView } from '../render/Renderer';
import { computeStars, isGoalMet, ScoreKeeper } from '../scoring/scoring';
import type { HudMessage, HudSnapshot, LevelConfig, Phase, RoundResult, ThrowSummary, TutorialStep, Vec2 } from '../types';
import { plural } from '../../ui/format';

/**
 * Разрешённые переходы между фазами. Любой другой переход игнорируется —
 * это защищает от двойного броска, повторного подсчёта и «гонок» таймеров.
 */
const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  READY: ['AIMING'],
  AIMING: ['READY', 'THROWING'],
  THROWING: ['RESOLVING'],
  RESOLVING: ['READY', 'ROUND_COMPLETE'],
  ROUND_COMPLETE: [],
};

export interface EngineOptions {
  level: LevelConfig;
  /** Первый запуск: пробный бросок с подсказками. */
  tutorial: boolean;
  reducedMotion: boolean;
}

export interface EngineCallbacks {
  onRoundComplete(result: RoundResult): void;
  onTutorialDone?(): void;
  onPauseRequest?(): void;
}

interface Task {
  at: number;
  fn: () => void;
}

const GRAB_RADIUS = 150;

export class GameEngine implements SceneView, InputTarget {
  // ——— SceneView ———
  readonly level: LevelConfig;
  phase: Phase = 'READY';
  aim: Aim | null = null;
  hoverGrab = false;
  hand: HandAnim = { offset: 0, angle: 0, open: 0, sakaInHand: true, reload: 1 };
  readonly effects: Effects;
  clock = 0;
  sakaLaunchedAt = 0;
  trail: Vec2[] = [];
  showGrabHint = false;

  // ——— внутреннее состояние ———
  private physics: PhysicsWorld;
  private scorer = new ScoreKeeper();
  private readonly renderer: Renderer;
  private readonly input: AimInput;
  private aimSource: 'pointer' | 'keyboard' | null = null;
  private lastAngle = 0;
  private lastPower = 0.6;
  private throwsUsed = 0;
  /** Номер текущего броска (1…); 0 — пробный бросок обучения. */
  private currentThrow = 0;
  private launched = false;
  private knockedThisThrow = 0;
  private settledFor = 0;
  private practice: boolean;
  private tutorialStep: TutorialStep | null;
  private paused = false;
  private tasks: Task[] = [];
  private release: { at: number; from: number } | null = null;
  private lastThrow: ThrowSummary | null = null;
  private message: HudMessage | null = null;
  private msgId = 0;
  private waitHintShown = false;

  private raf = 0;
  private lastNow = 0;
  private accumulator = 0;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: HudSnapshot;

  constructor(
    canvas: HTMLCanvasElement,
    opts: EngineOptions,
    private readonly cb: EngineCallbacks,
  ) {
    this.level = opts.level;
    this.practice = opts.tutorial;
    this.tutorialStep = opts.tutorial ? 'grab' : null;
    this.effects = new Effects(opts.reducedMotion);
    this.renderer = new Renderer(canvas, this.level);
    this.physics = this.buildWorld();
    this.input = new AimInput(canvas, (x, y) => this.renderer.screenToWorld(x, y), this);
    this.snapshot = this.buildSnapshot();
    // шрифты для надписей мелом на фоне
    document.fonts?.ready.then(() => this.renderer.invalidateBackground()).catch(() => undefined);
  }

  // ——— жизненный цикл ———

  start(): void {
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.input.destroy();
    this.physics.destroy();
    this.tasks = [];
    this.listeners.clear();
  }

  resize(cssW: number, cssH: number, topInset: number): void {
    this.renderer.resize(cssW, cssH, topInset);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused && this.phase === 'AIMING') this.cancelAim(false);
    if (paused) this.input.reset();
    this.lastNow = performance.now();
    this.emit();
  }

  /** Перезапуск раунда в любой момент (в том числе во время движения физики). */
  restart(): void {
    this.tasks = []; // отменяем все отложенные действия старого раунда
    this.release = null;
    this.physics.destroy();
    this.physics = this.buildWorld();
    this.scorer = new ScoreKeeper();
    this.throwsUsed = 0;
    this.currentThrow = 0;
    this.launched = false;
    this.lastThrow = null;
    this.aim = null;
    this.aimSource = null;
    this.trail = [];
    this.effects.clear();
    this.hand = { offset: 0, angle: 0, open: 0, sakaInHand: true, reload: 0 };
    this.phase = 'READY';
    this.paused = false;
    if (this.practice) this.tutorialStep = 'grab';
    this.input.reset();
    this.emit();
  }

  // ——— подписка для React (useSyncExternalStore) ———

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): HudSnapshot => this.snapshot;

  // ——— SceneView ———

  get pieces(): readonly Piece[] {
    return this.physics.pieces;
  }

  get physicsTime(): number {
    return this.physics.time;
  }

  // ——— InputTarget ———

  pointerDown(p: Vec2): boolean {
    sound.unlock();
    if (this.paused) return false;
    if (this.phase !== 'READY') {
      if ((this.phase === 'THROWING' || this.phase === 'RESOLVING') && !this.waitHintShown) {
        this.waitHintShown = true;
        this.say('Дождись, пока всё остановится', 'info', 1200);
      }
      return false;
    }
    if (!this.inGrabArea(p)) {
      this.say('Зажми сақа в руке внизу и тяни к асыкам', 'info', 2200);
      this.showGrabHint = true;
      this.schedule(1600, () => (this.showGrabHint = false));
      return false;
    }
    if (!this.setPhase('AIMING')) return false;
    this.aimSource = 'pointer';
    this.aim = aimFromPoint(THROW_ORIGIN, p, this.lastAngle);
    if (this.tutorialStep === 'grab') this.tutorialStep = 'drag';
    this.emit();
    return true;
  }

  pointerMove(p: Vec2, pressed: boolean): void {
    if (!pressed) {
      const hover = this.phase === 'READY' && !this.paused && this.inGrabArea(p);
      if (hover !== this.hoverGrab) this.hoverGrab = hover;
      return;
    }
    if (this.phase !== 'AIMING' || this.aimSource !== 'pointer') return;
    this.aim = aimFromPoint(THROW_ORIGIN, p, this.aim?.angle ?? this.lastAngle);
    this.advanceTutorialOnAim();
    this.emit();
  }

  pointerUp(p: Vec2): void {
    if (this.phase !== 'AIMING' || this.aimSource !== 'pointer') return;
    this.aim = aimFromPoint(THROW_ORIGIN, p, this.aim?.angle ?? this.lastAngle);
    this.releaseThrow();
  }

  pointerCancel(): void {
    if (this.phase === 'AIMING' && this.aimSource === 'pointer') this.cancelAim(false);
  }

  keyAim(dAngle: number, dPower: number): void {
    if (this.paused) return;
    if (this.phase === 'READY') {
      if (!this.setPhase('AIMING')) return;
      this.aimSource = 'keyboard';
      this.aim = aimFromAnglePower(this.lastAngle, this.lastPower);
      if (this.tutorialStep === 'grab') this.tutorialStep = 'drag';
    }
    if (this.phase !== 'AIMING' || this.aimSource !== 'keyboard' || !this.aim) return;
    this.aim = aimFromAnglePower(this.aim.angle + dAngle, this.aim.power + dPower);
    this.advanceTutorialOnAim();
    this.emit();
  }

  keyThrow(): void {
    if (this.paused) return;
    if (this.phase === 'READY') {
      this.keyAim(0, 0); // первое нажатие показывает прицел
      return;
    }
    if (this.phase === 'AIMING' && this.aimSource === 'keyboard') this.releaseThrow();
  }

  keyEscape(): void {
    if (this.phase === 'AIMING') this.cancelAim(false);
    else this.cb.onPauseRequest?.();
  }

  cursor(): string {
    if (this.phase === 'AIMING') return 'grabbing';
    if (this.phase === 'READY' && this.hoverGrab) return 'grab';
    return 'default';
  }

  // ——— основной цикл ———

  private frame = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(PHYS.maxFrameMs, Math.max(0, now - this.lastNow));
    this.lastNow = now;

    if (!this.paused) {
      this.clock += dt;
      // фиксированный шаг физики независимо от частоты кадров экрана (60/120/144 Гц)
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= PHYS.stepMs && steps < 24) {
        this.fixedStep();
        this.accumulator -= PHYS.stepMs;
        steps++;
      }
      if (steps >= 24) this.accumulator = 0;
      this.runTasks();
      this.effects.update(dt);
      this.animateHand(dt);
      this.updateTrail();
    }
    this.renderer.render(this);
  };

  private fixedStep(): void {
    this.physics.step();
    for (const c of this.physics.drainContacts()) this.onContact(c);

    // выбитые асыки растворяются и удаляются из мира
    for (const p of [...this.physics.pieces]) {
      if (p.status === 'out' && p.outAt !== null && this.physics.time - p.outAt > KNOCKOUT_FADE_MS) {
        this.physics.removePiece(p);
      }
    }

    if (this.phase !== 'THROWING' || !this.launched) return;

    for (const p of this.physics.checkKnockouts(this.level.zone, this.currentThrow)) this.onKnockout(p);

    if (this.physics.isSettled()) {
      this.settledFor += PHYS.stepMs;
      if (this.settledFor >= PHYS.settleMs) this.resolveThrow();
    } else {
      this.settledFor = 0;
    }
    if (this.phase === 'THROWING' && this.physics.time - this.sakaLaunchedAt > PHYS.maxThrowMs) {
      this.physics.stopAll();
      this.resolveThrow();
    }
  }

  // ——— бросок ———

  private releaseThrow(): void {
    const aim = this.aim;
    if (this.phase !== 'AIMING' || !aim) return;
    if (!aim.valid) {
      this.cancelAim(true);
      return;
    }
    if (!this.setPhase('THROWING')) return;
    this.lastAngle = aim.angle;
    this.lastPower = aim.power;
    this.aimSource = null;
    this.launched = false;
    this.waitHintShown = false;
    this.release = { at: this.clock, from: this.hand.offset };
    if (this.tutorialStep) this.tutorialStep = 'watch';
    sound.throw(aim.power);
    const params = throwParams(aim);
    // рука делает выброс, и только в конце движения сақа «срывается» с пальцев
    this.schedule(RELEASE_DELAY_MS, () => this.launch(params));
    this.emit();
  }

  private launch(params: ThrowParams): void {
    if (this.phase !== 'THROWING' || this.launched) return;
    if (!this.practice) this.throwsUsed += 1;
    this.currentThrow = this.practice ? 0 : this.throwsUsed;
    this.knockedThisThrow = 0;
    this.settledFor = 0;
    this.physics.launchSaka(THROW_ORIGIN, params.angle, params.speed, params.spin);
    this.sakaLaunchedAt = this.physics.time;
    this.launched = true;
    this.hand.sakaInHand = false;
    this.aim = null;
    const d = aimDirection(params.angle);
    this.effects.dust(THROW_ORIGIN.x + d.x * 30, THROW_ORIGIN.y + d.y * 30, 2, 'rgba(230, 220, 200, 1)');
    this.emit();
  }

  private cancelAim(tooWeak: boolean): void {
    if (this.phase !== 'AIMING') return;
    const hadPower = (this.aim?.power ?? 0) > 0.01;
    this.aim = null;
    this.aimSource = null;
    this.setPhase('READY');
    if (tooWeak) {
      this.say(hadPower ? 'Слишком слабо — потяни дальше от руки' : 'Потяни от руки вверх, к асыкам', 'warn', 2000);
      if (this.tutorialStep === 'release') this.tutorialStep = 'drag';
    }
    this.emit();
  }

  private resolveThrow(): void {
    if (this.phase !== 'THROWING') return;
    if (!this.setPhase('RESOLVING')) return;
    this.trail = [];
    const ts = this.scorer.resolveThrow(this.currentThrow);
    if (ts) {
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
      const c = zoneCenter(this.level.zone);
      if (ts.knocked === 0) {
        this.say('Мимо! Целься точнее или бросай сильнее', 'warn');
        sound.miss();
      } else if (ts.comboBonus > 0) {
        this.effects.popup(c.x, c.y - 40, `КОМБО ×${ts.knocked}  +${ts.comboBonus}`, '#ffb13b', 40, 1500);
        this.say(`Комбо! ${ts.knocked} ${plural(ts.knocked, ['асык', 'асыка', 'асыков'])} одним броском`, 'good');
        sound.bonus();
      } else if (ts.targetKnocked) {
        this.say('Синий асык выбит!', 'good');
      } else {
        this.say(`Выбит ${ts.knocked} ${plural(ts.knocked, ['асык', 'асыка', 'асыков'])}`, 'good', 1400);
      }
      if (ts.streakBonus > 0) {
        this.effects.popup(c.x, c.y + 10, `СЕРИЯ ×${ts.streak}  +${ts.streakBonus}`, '#9be15d', 32, 1500);
        if (ts.comboBonus === 0) sound.bonus();
      }
    }
    this.emit();
    this.schedule(RESOLVE_PAUSE_MS, () => this.afterResolve());
  }

  private afterResolve(): void {
    if (this.phase !== 'RESOLVING') return;
    const saka = this.physics.saka;
    if (saka) this.effects.dust(saka.body.position.x, saka.body.position.y, 3, 'rgba(230,220,200,1)');
    this.physics.removeSaka();

    if (this.practice) {
      // пробный бросок обучения не считается: возвращаем кон в исходное состояние
      this.practice = false;
      this.tutorialStep = null;
      this.restart();
      this.say(`Отлично! Теперь по-настоящему: ${this.level.throws} ${plural(this.level.throws, ['бросок', 'броска', 'бросков'])}`, 'good', 2600);
      this.cb.onTutorialDone?.();
      return;
    }

    const cleared = this.physics.asyksIn().length === 0;
    const remaining = this.level.throws - this.throwsUsed;
    if (cleared || remaining <= 0) {
      this.finishRound(cleared, remaining);
      return;
    }
    this.setPhase('READY');
    this.hand.sakaInHand = true;
    this.hand.reload = 0;
    this.emit();
  }

  private finishRound(cleared: boolean, remaining: number): void {
    if (!this.setPhase('ROUND_COMPLETE')) return;
    const clean = this.scorer.finishRound(remaining, cleared);
    if (clean > 0) {
      const c = zoneCenter(this.level.zone);
      this.effects.popup(c.x, c.y, `ТАЗА КОН!  +${clean}`, '#ffd84d', 42, 1800);
      this.say(`Таза кон! Бонус за ${remaining} ${plural(remaining, ['бросок', 'броска', 'бросков'])}`, 'good');
      sound.bonus();
    }
    const s = this.scorer;
    const input = {
      knocked: s.knocked,
      totalAsyks: this.level.asyks.length,
      score: s.score,
      cleared,
      targetThrow: s.targetThrow,
    };
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
    this.emit();
    this.schedule(clean > 0 ? 1300 : 700, () => this.cb.onRoundComplete(result));
  }

  // ——— события физики ———

  private onContact(c: ContactEvent): void {
    if (c.type === 'wall') {
      sound.thud(c.impact);
      if (c.impact > 2) this.effects.dust(c.x, c.y, c.impact * 0.5, 'rgba(205, 200, 190, 1)');
      return;
    }
    const heavy = c.type === 'saka-asyk';
    sound.clack(c.impact, heavy);
    if (c.impact > 1.2) this.effects.dust(c.x, c.y, c.impact * (heavy ? 1 : 0.6));
    if (heavy && c.impact > 7) this.effects.addShake(0.35);
  }

  private onKnockout(p: Piece): void {
    const pts = this.scorer.registerKnockout(p.id, p.kind === 'target', this.currentThrow);
    if (pts <= 0) return;
    this.knockedThisThrow += 1;
    const pos = p.body.position;
    this.effects.chalkBurst(zoneEdgePoint(this.level.zone, pos));
    this.effects.popup(pos.x, pos.y - 24, `+${pts}`, p.kind === 'target' ? '#7fd9ee' : '#ffd84d', p.kind === 'target' ? 40 : 34);
    sound.knockout(this.knockedThisThrow);
    this.emit();
  }

  // ——— анимация руки ———

  private animateHand(dt: number): void {
    const h = this.hand;
    const k = 1 - Math.pow(0.001, dt / 1000); // сглаживание, не зависящее от FPS
    if (this.release) {
      const t = this.clock - this.release.at;
      if (t < RELEASE_DELAY_MS) {
        // резкий выброс вперёд до точки выпуска
        const u = t / RELEASE_DELAY_MS;
        h.offset = this.release.from * (1 - u * u);
        h.open = 0;
      } else if (t < RELEASE_DELAY_MS + 140) {
        const u = (t - RELEASE_DELAY_MS) / 140;
        h.offset = 26 * (1 - (1 - u) * (1 - u));
        h.open = u;
      } else if (t < RELEASE_DELAY_MS + 560) {
        const u = (t - RELEASE_DELAY_MS - 140) / 420;
        h.offset = 26 * (1 - u);
        h.open = 1 - u * 0.7;
      } else {
        this.release = null;
      }
    } else if (this.phase === 'AIMING' && this.aim) {
      // замах: рука поворачивается к цели и оттягивается назад пропорционально силе
      h.angle += (this.aim.angle - h.angle) * Math.min(1, k * 3);
      h.offset += (-this.aim.power * 30 - h.offset) * Math.min(1, k * 3);
      h.open += (0 - h.open) * k;
    } else {
      h.offset += (0 - h.offset) * k;
      h.open += (0 - h.open) * k;
      if (this.phase === 'READY') h.angle += (0 - h.angle) * k * 0.6;
    }
    if (h.sakaInHand && h.reload < 1) h.reload = Math.min(1, h.reload + dt / 320);
  }

  private updateTrail(): void {
    const saka = this.physics.saka;
    if (!saka || this.phase !== 'THROWING') {
      if (this.trail.length) this.trail = [];
      return;
    }
    const v = saka.body.velocity;
    if (Math.hypot(v.x, v.y) > 1.2) {
      this.trail.push({ x: saka.body.position.x, y: saka.body.position.y });
      if (this.trail.length > 10) this.trail.shift();
    } else if (this.trail.length) {
      this.trail.shift();
    }
  }

  // ——— вспомогательное ———

  private buildWorld(): PhysicsWorld {
    const w = new PhysicsWorld();
    w.addAsyks(this.level.asyks);
    return w;
  }

  private inGrabArea(p: Vec2): boolean {
    const dx = p.x - THROW_ORIGIN.x;
    const dy = p.y - THROW_ORIGIN.y;
    return dx * dx + dy * dy < GRAB_RADIUS * GRAB_RADIUS || p.y > THROW_LINE_Y + 10;
  }

  private advanceTutorialOnAim(): void {
    if (this.tutorialStep === 'drag' && this.aim && this.aim.valid && this.aim.power >= 0.3) {
      this.tutorialStep = 'release';
    }
  }

  private setPhase(next: Phase): boolean {
    if (!TRANSITIONS[this.phase].includes(next)) return false;
    this.phase = next;
    if (next !== 'READY') this.hoverGrab = false;
    return true;
  }

  private schedule(ms: number, fn: () => void): void {
    this.tasks.push({ at: this.clock + ms, fn });
  }

  private runTasks(): void {
    if (!this.tasks.length) return;
    const due = this.tasks.filter((t) => t.at <= this.clock);
    if (!due.length) return;
    this.tasks = this.tasks.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();
  }

  private say(text: string, tone: HudMessage['tone'], ms = 1800): void {
    const id = ++this.msgId;
    this.message = { id, text, tone };
    this.schedule(ms, () => {
      if (this.message?.id === id) {
        this.message = null;
        this.emit();
      }
    });
    this.emit();
  }

  private buildSnapshot(): HudSnapshot {
    const s = this.scorer;
    const hasTarget = this.level.asyks.some((a) => a.kind === 'target');
    return {
      phase: this.phase,
      levelId: this.level.id,
      throwsUsed: this.throwsUsed,
      throwsTotal: this.level.throws,
      score: s.score,
      knocked: s.knocked,
      totalAsyks: this.level.asyks.length,
      hasTarget,
      targetOut: s.targetThrow !== null,
      power: this.aim?.power ?? 0,
      aiming: this.phase === 'AIMING',
      streak: s.streak,
      practice: this.practice,
      tutorialStep: this.tutorialStep,
      paused: this.paused,
      lastThrow: this.lastThrow,
      message: this.message,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }
}
