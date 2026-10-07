import { sound } from '../audio/sound';
import { KNOCKOUT_FADE_MS, PHYS, RELEASE_DELAY_MS, RESOLVE_PAUSE_MS, THROW_LINE_Y, THROW_ORIGIN } from '../config';
import { AimInput, type InputTarget } from '../input/AimInput';
import { zoneCenter } from '../levels/zone';
import { aimDirection, aimFromAnglePower, aimFromPoint, throwParams, type Aim, type ThrowParams } from '../physics/aim';
import { PhysicsWorld, type ContactEvent, type Piece } from '../physics/PhysicsWorld';
import type { AsykPalette } from '../render/asykShape';
import { Effects } from '../render/effects';
import { Renderer, type HandAnim, type SceneView } from '../render/Renderer';
import type { Rules, RulesHost } from '../rules/Rules';
import type { HudMessage, HudSnapshot, KonLayout, Phase, TutorialStep, Vec2 } from '../types';

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
  layout: KonLayout;
  /** Правила режима: одиночное испытание или матч. */
  rules: Rules;
  /** Первый запуск: пробный бросок с подсказками. */
  tutorial: boolean;
  reducedMotion: boolean;
}

export interface EngineCallbacks {
  onTutorialDone?(): void;
  onPauseRequest?(): void;
}

interface Task {
  at: number;
  fn: () => void;
}

const GRAB_RADIUS = 150;

/**
 * Игровой движок: цикл, физика, ввод, анимация руки, рендер и фазы броска.
 * Счёт, очередь ходов и конец игры решают правила (`Rules`).
 */
export class GameEngine implements SceneView, InputTarget, RulesHost {
  // ——— SceneView / RulesHost ———
  readonly layout: KonLayout;
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
  private readonly rules: Rules;
  private readonly renderer: Renderer;
  private readonly input: AimInput;
  private aimSource: 'pointer' | 'keyboard' | null = null;
  private lastAngle = 0;
  private lastPower = 0.6;
  /** Номер текущего броска (его выдают правила при запуске). */
  private currentThrow = 0;
  private launched = false;
  private settledFor = 0;
  /** Обучение ещё не пройдено (пробный бросок впереди). */
  private tutorialPending: boolean;
  private tutorialStep: TutorialStep | null;
  private paused = false;
  private tasks: Task[] = [];
  private release: { at: number; from: number } | null = null;
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
    private readonly cb: EngineCallbacks = {},
  ) {
    this.layout = opts.layout;
    this.rules = opts.rules;
    this.tutorialPending = opts.tutorial;
    this.tutorialStep = opts.tutorial ? 'grab' : null;
    this.effects = new Effects(opts.reducedMotion);
    this.renderer = new Renderer(canvas, this.layout);
    this.physics = this.buildWorld();
    this.rules.attach(this);
    this.input = new AimInput(canvas, (x, y) => this.renderer.screenToWorld(x, y), this);
    this.snapshot = this.buildSnapshot();
    // шрифты для надписей мелом на фоне
    document.fonts?.ready.then(() => this.renderer.invalidateBackground()).catch(() => undefined);
  }

  // ——— жизненный цикл ———

  start(): void {
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.rules.onStart();
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

  /** Перезапуск раунда/матча в любой момент (в том числе во время движения физики). */
  restart(): void {
    this.resetWorld();
    this.rules.onStart();
    this.emit();
  }

  private resetWorld(): void {
    this.tasks = []; // отменяем все отложенные действия старого раунда
    this.release = null;
    this.physics.destroy();
    this.physics = this.buildWorld();
    this.rules.reset();
    this.currentThrow = 0;
    this.launched = false;
    this.aim = null;
    this.aimSource = null;
    this.trail = [];
    this.message = null;
    this.effects.clear();
    this.hand = { offset: 0, angle: 0, open: 0, sakaInHand: true, reload: 0 };
    this.phase = 'READY';
    this.paused = false;
    this.tutorialStep = this.tutorialPending ? 'grab' : null;
    this.input.reset();
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

  get sakaPalette(): AsykPalette {
    return this.rules.sakaPalette();
  }

  get braceletColor(): string {
    return this.rules.braceletColor();
  }

  // ——— RulesHost ———

  asyksLeft(): number {
    return this.physics.asyksIn().length;
  }

  zoneCenter(): Vec2 {
    return zoneCenter(this.layout.zone);
  }

  schedule(ms: number, fn: () => void): void {
    this.tasks.push({ at: this.clock + ms, fn });
  }

  say(text: string, tone: HudMessage['tone'], ms = 1800): void {
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
    if (!this.rules.canThrow()) {
      this.say(this.rules.blockedHint(), 'info', 1600);
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
      const hover = this.phase === 'READY' && !this.paused && this.rules.canThrow() && this.inGrabArea(p);
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
      if (!this.rules.canThrow()) return;
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

    const out = this.physics.checkKnockouts(this.layout.zone, this.currentThrow);
    for (const p of out) this.rules.onKnockout(p, this.currentThrow);
    if (out.length) this.emit();

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
    this.currentThrow = this.rules.onLaunch();
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
    this.rules.onSettled(this.currentThrow);
    this.emit();
    this.schedule(RESOLVE_PAUSE_MS, () => this.afterResolve());
  }

  private afterResolve(): void {
    if (this.phase !== 'RESOLVING') return;
    const saka = this.physics.saka;
    if (saka) this.effects.dust(saka.body.position.x, saka.body.position.y, 3, 'rgba(230,220,200,1)');
    this.physics.removeSaka();

    const step = this.rules.next();
    switch (step.kind) {
      case 'reset':
        // пробный бросок обучения не считается: возвращаем кон в исходное состояние
        this.tutorialPending = false;
        this.resetWorld();
        this.say(step.message, 'good', 2600);
        this.cb.onTutorialDone?.();
        break;
      case 'finish':
        if (!this.setPhase('ROUND_COMPLETE')) return;
        this.rules.onFinish();
        break;
      case 'continue':
        this.setPhase('READY');
        this.hand.sakaInHand = true;
        this.hand.reload = 0;
        break;
    }
    this.emit();
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
    w.addAsyks(this.layout.asyks);
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

  private runTasks(): void {
    if (!this.tasks.length) return;
    const due = this.tasks.filter((t) => t.at <= this.clock);
    if (!due.length) return;
    this.tasks = this.tasks.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();
  }

  private buildSnapshot(): HudSnapshot {
    return {
      phase: this.phase,
      power: this.aim?.power ?? 0,
      aiming: this.phase === 'AIMING',
      paused: this.paused,
      tutorialStep: this.tutorialStep,
      message: this.message,
      mode: this.rules.hud(),
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }
}
