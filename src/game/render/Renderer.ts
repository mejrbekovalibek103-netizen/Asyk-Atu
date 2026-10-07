import { ASYK_H, ASYK_W, CURB, KNOCKOUT_FADE_MS, SAKA_H, SAKA_W, THROW_ORIGIN, WORLD_H, WORLD_W } from '../config';
import { aimDirection, type Aim } from '../physics/aim';
import type { Piece } from '../physics/PhysicsWorld';
import type { KonLayout, Phase, Vec2 } from '../types';
import type { AsykPalette } from './asykShape';
import { drawCourtyard, type VisibleRect } from './background';
import type { Effects } from './effects';
import { drawHandBack, drawHandFingers, drawHandShadow } from './hand';
import { drawAsyk, drawAsykShadow } from './sprites';

export interface HandAnim {
  /** Смещение руки вдоль направления броска (− назад, + вперёд), единицы мира. */
  offset: number;
  /** Текущий поворот руки, радианы. */
  angle: number;
  /** Раскрытие пальцев 0…1. */
  open: number;
  /** Сақа в руке? */
  sakaInHand: boolean;
  /** Анимация появления нового сақа 0…1. */
  reload: number;
}

/** То, что рендерер читает у движка каждый кадр. */
export interface SceneView {
  readonly layout: KonLayout;
  /** Цвет сақа текущего игрока. */
  readonly sakaPalette: AsykPalette;
  /** Цвет браслета на руке текущего игрока. */
  readonly braceletColor: string;
  readonly pieces: readonly Piece[];
  readonly phase: Phase;
  readonly aim: Aim | null;
  readonly hoverGrab: boolean;
  readonly hand: HandAnim;
  readonly effects: Effects;
  /** Игровые часы, мс (стоят на паузе). */
  readonly clock: number;
  readonly physicsTime: number;
  readonly sakaLaunchedAt: number;
  readonly trail: readonly Vec2[];
  readonly showGrabHint: boolean;
}

export interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Камера: мир целиком помещается под HUD и масштабируется равномерно.
 * Экспортируется, чтобы интерфейс мог позиционировать подсказки относительно мира.
 */
export function computeCamera(cssW: number, cssH: number, topInset: number): Camera {
  const availH = Math.max(100, cssH - topInset);
  const scale = Math.min(cssW / WORLD_W, availH / WORLD_H);
  // если экран вытянутый (телефон), поднимаем поле: рука не у самого края
  // (там системный жест «домой»), а лишнее место делим 70/30 сверху/снизу
  const extra = availH - WORLD_H * scale;
  return { scale, offsetX: (cssW - WORLD_W * scale) / 2, offsetY: topInset + extra * 0.7 };
}

/**
 * Рендер сцены на Canvas 2D.
 *
 * Камера: мир 800×1200 масштабируется равномерно, чтобы целиком поместиться
 * на экране; рука «выходит» из-под нижнего края мира, асфальт продолжается вниз,
 * лишнее пространство по бокам и сверху заполняется двором.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private bgDirty = true;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private layout: KonLayout,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D не поддерживается');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, topInset: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    const cam = computeCamera(this.cssW, this.cssH, topInset);
    this.scale = cam.scale;
    this.offsetX = cam.offsetX;
    this.offsetY = cam.offsetY;
    this.bgDirty = true;
  }

  setLayout(layout: KonLayout): void {
    this.layout = layout;
    this.bgDirty = true;
  }

  invalidateBackground(): void {
    this.bgDirty = true;
  }

  /** Экранные CSS-пиксели → координаты мира. */
  screenToWorld(x: number, y: number): Vec2 {
    return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale };
  }

  worldToScreen(p: Vec2): Vec2 {
    return { x: this.offsetX + p.x * this.scale, y: this.offsetY + p.y * this.scale };
  }

  private visibleRect(): VisibleRect {
    return {
      x0: -this.offsetX / this.scale - 4,
      y0: -this.offsetY / this.scale - 4,
      x1: (this.cssW - this.offsetX) / this.scale + 4,
      y1: (this.cssH - this.offsetY) / this.scale + 4,
    };
  }

  private worldTransform(ctx: CanvasRenderingContext2D, sx = 0, sy = 0): void {
    const k = this.dpr * this.scale;
    ctx.setTransform(k, 0, 0, k, this.dpr * (this.offsetX + sx), this.dpr * (this.offsetY + sy));
  }

  private buildBackground(): void {
    const c = this.bg ?? document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    this.worldTransform(ctx);
    drawCourtyard(ctx, this.layout.zone, this.visibleRect());
    this.bg = c;
    this.bgDirty = false;
  }

  render(v: SceneView): void {
    const ctx = this.ctx;
    if (this.bgDirty || !this.bg) this.buildBackground();

    const shake = v.effects.shake;
    const sx = shake > 0 ? (Math.random() - 0.5) * 6 * shake : 0;
    const sy = shake > 0 ? (Math.random() - 0.5) * 6 * shake : 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg!, sx * this.dpr, sy * this.dpr);
    this.worldTransform(ctx, sx, sy);

    this.drawPieces(ctx, v);
    this.drawSakaInFlight(ctx, v);
    if (v.aim && v.phase === 'AIMING') this.drawAim(ctx, v.aim, v.clock);
    this.drawHand(ctx, v);
    this.drawEffects(ctx, v);
  }

  private drawPieces(ctx: CanvasRenderingContext2D, v: SceneView): void {
    const t = v.clock;
    for (const p of v.pieces) {
      if (p.kind === 'saka') continue;
      let alpha = 1;
      if (p.status === 'out' && p.outAt !== null) {
        alpha = Math.max(0, 1 - (v.physicsTime - p.outAt) / KNOCKOUT_FADE_MS);
        if (alpha <= 0) continue;
      }
      const { x, y } = p.body.position;
      const wob = p.wobble;
      const angle = p.body.angle + (wob > 0 ? Math.sin(t * 0.09 + p.id * 1.7) * wob * 0.1 : 0);
      drawAsykShadow(ctx, x, y, p.body.angle, ASYK_W, ASYK_H, alpha);
      drawAsyk(ctx, x, y, angle, ASYK_W, ASYK_H, p.kind === 'target' ? 'target' : 'bone', p.face, alpha, 1 + wob * 0.05);

      if (p.kind === 'target' && p.status === 'in') {
        const pulse = (Math.sin(t * 0.005) + 1) / 2;
        ctx.save();
        ctx.strokeStyle = `rgba(39, 166, 200, ${0.45 + pulse * 0.4})`;
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 7]);
        ctx.lineDashOffset = -t * 0.02;
        ctx.beginPath();
        ctx.arc(x, y, 44 + pulse * 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawSakaInFlight(ctx: CanvasRenderingContext2D, v: SceneView): void {
    const saka = v.pieces.find((p) => p.kind === 'saka');
    if (!saka) return;
    // след движения
    const n = v.trail.length;
    for (let i = 0; i < n; i++) {
      const p = v.trail[i];
      const a = (i / n) * 0.35;
      ctx.fillStyle = `rgba(255, 240, 220, ${a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + (i / n) * 8, 0, Math.PI * 2);
      ctx.fill();
    }
    // короткий «полёт» после выброса: сақа чуть больше и с более далёкой тенью
    const lift = Math.max(0, 1 - (v.physicsTime - v.sakaLaunchedAt) / 200);
    const { x, y } = saka.body.position;
    drawAsykShadow(ctx, x, y, saka.body.angle, SAKA_W, SAKA_H, 1, lift);
    drawAsyk(ctx, x, y, saka.body.angle, SAKA_W, SAKA_H, v.sakaPalette, 'buk', 1, 1 + lift * 0.18);
  }

  private drawAim(ctx: CanvasRenderingContext2D, aim: Aim, t: number): void {
    const dir = aimDirection(aim.angle);
    const o = THROW_ORIGIN;
    // пунктир обрезается у бордюра: дальше сақа отскочит (прогноз отскока не рисуем — он зависит от удара)
    const wall = distanceToCurb(o, dir);
    const hitsWall = aim.slide > wall;
    const len = Math.min(aim.slide, wall);
    const p = aim.power;
    // цвет: от мела (слабо) к янтарному и оранжевому (сильно)
    const col = p < 0.5 ? mix([255, 255, 255], [255, 216, 77], p / 0.5) : mix([255, 216, 77], [255, 110, 64], (p - 0.5) / 0.5);
    const rgb = `${col[0]}, ${col[1]}, ${col[2]}`;

    ctx.save();
    for (let d = 48; d < len - 18; d += 22) {
      const k = d / Math.max(1, len);
      const x = o.x + dir.x * d;
      const y = o.y + dir.y * d;
      ctx.beginPath();
      ctx.arc(x, y, 5.2 - k * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = aim.valid ? `rgba(${rgb}, ${0.95 - k * 0.45})` : 'rgba(255, 120, 100, 0.8)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(40, 30, 20, 0.35)';
      ctx.stroke();
    }
    const end = { x: o.x + dir.x * len, y: o.y + dir.y * len };
    if (aim.valid && hitsWall) {
      // метка «удар о бордюр»
      ctx.save();
      ctx.translate(end.x, end.y);
      ctx.rotate(aim.angle);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(40,30,20,0.45)';
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(-20, 0);
      ctx.lineTo(20, 0);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${rgb}, 1)`;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.restore();
    } else if (aim.valid) {
      // метка «здесь сақа остановится без столкновений»
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -t * 0.03;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(40,30,20,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(${rgb}, 1)`;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawHand(ctx: CanvasRenderingContext2D, v: SceneView): void {
    const h = v.hand;
    const dir = aimDirection(h.angle);
    const hx = THROW_ORIGIN.x + dir.x * h.offset;
    const hy = THROW_ORIGIN.y + dir.y * h.offset;

    // приглашение «возьми сақа»
    if (v.phase === 'READY' && h.sakaInHand) {
      const t = (v.clock % 1600) / 1600;
      const strong = v.hoverGrab || v.showGrabHint;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 216, 77, ${(1 - t) * (strong ? 0.95 : 0.55)})`;
      ctx.lineWidth = strong ? 5 : 3.5;
      ctx.beginPath();
      ctx.arc(hx, hy, 46 + t * 42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // рука мальчика крупнее «реального» масштаба сақа — ближе к камере, ощущение «это моя рука»
    const HS = 1.3;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(h.angle);
    // тень руки не должна вращаться вместе с рукой — компенсируем поворот
    ctx.save();
    ctx.rotate(-h.angle);
    ctx.translate(18, 26);
    ctx.rotate(h.angle);
    ctx.scale(HS, HS);
    drawHandShadow(ctx, { open: h.open });
    ctx.restore();

    ctx.save();
    ctx.scale(HS, HS);
    drawHandBack(ctx, v.braceletColor);
    ctx.restore();
    if (h.sakaInHand) {
      const s = easeOutBack(h.reload);
      // сақа в руке — длинная ось вдоль направления броска (как при запуске)
      drawAsyk(ctx, 0, 0, -Math.PI / 2, SAKA_W, SAKA_H, v.sakaPalette, 'buk', Math.min(1, h.reload * 1.5), s);
    }
    ctx.scale(HS, HS);
    drawHandFingers(ctx, { open: h.open });
    ctx.restore();
  }

  private drawEffects(ctx: CanvasRenderingContext2D, v: SceneView): void {
    const fx = v.effects;
    for (const r of fx.rings) {
      const k = r.life / r.max;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * easeOutCubic(k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    for (const p of fx.particles) {
      const k = p.life / p.max;
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.6 + k * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const p of fx.popups) {
      const k = p.life / p.max;
      const y = p.y - easeOutCubic(Math.min(1, k * 1.4)) * 60;
      const s = k < 0.15 ? easeOutBack(k / 0.15) : 1;
      ctx.save();
      ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      ctx.translate(p.x, y);
      ctx.scale(s, s);
      ctx.font = `800 ${p.size}px Unbounded Variable, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = p.size * 0.22;
      ctx.strokeStyle = 'rgba(35, 25, 15, 0.85)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }
}

/** Расстояние от точки броска до бордюра по направлению dir (с учётом половины ширины сақа). */
function distanceToCurb(o: Vec2, dir: Vec2): number {
  const pad = CURB + SAKA_H / 2;
  let t = Infinity;
  if (dir.x > 1e-6) t = Math.min(t, (WORLD_W - pad - o.x) / dir.x);
  if (dir.x < -1e-6) t = Math.min(t, (pad - o.x) / dir.x);
  if (dir.y < -1e-6) t = Math.min(t, (pad - o.y) / dir.y);
  return Math.max(0, t);
}

function mix(a: number[], b: number[], t: number): number[] {
  const k = Math.min(1, Math.max(0, t));
  return a.map((v, i) => Math.round(v + (b[i] - v) * k));
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const k = Math.min(1, Math.max(0, t));
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}
