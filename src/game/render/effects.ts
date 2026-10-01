import type { Vec2 } from '../types';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

export interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
  max: number;
  color: string;
  size: number;
}

export interface Ring {
  x: number;
  y: number;
  life: number;
  max: number;
  r0: number;
  r1: number;
  color: string;
  width: number;
}

/**
 * Короткоживущие визуальные эффекты (пыль, всплывающие очки, кольца).
 * Координаты — в единицах мира. Эффекты не влияют на физику.
 */
export class Effects {
  particles: Particle[] = [];
  popups: Popup[] = [];
  rings: Ring[] = [];
  /** Интенсивность тряски камеры, 0…1. */
  shake = 0;

  constructor(private readonly reducedMotion: boolean) {}

  dust(x: number, y: number, intensity: number, color = 'rgba(214, 200, 176, 1)'): void {
    const n = Math.round((this.reducedMotion ? 3 : 6) + Math.min(10, intensity * 1.2));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.4 + Math.random() * 1.2) * (0.6 + Math.min(1.6, intensity / 6));
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: 320 + Math.random() * 360,
        size: 3 + Math.random() * 5,
        color,
      });
    }
  }

  chalkBurst(p: Vec2): void {
    this.dust(p.x, p.y, 8, 'rgba(250, 248, 240, 1)');
    this.ring(p.x, p.y, 10, 46, 'rgba(255,255,255,0.9)', 480, 4);
  }

  ring(x: number, y: number, r0: number, r1: number, color: string, ms: number, width = 3): void {
    this.rings.push({ x, y, r0, r1, color, life: 0, max: ms, width });
  }

  popup(x: number, y: number, text: string, color = '#ffd84d', size = 34, ms = 1100): void {
    this.popups.push({ x, y, text, color, size, life: 0, max: ms });
  }

  addShake(amount: number): void {
    if (this.reducedMotion) return;
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt: number): void {
    const k = dt / (1000 / 60);
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vx *= Math.pow(0.9, k);
      p.vy *= Math.pow(0.9, k);
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const p of this.popups) p.life += dt;
    this.popups = this.popups.filter((p) => p.life < p.max);
    for (const r of this.rings) r.life += dt;
    this.rings = this.rings.filter((r) => r.life < r.max);
    this.shake = Math.max(0, this.shake - dt / 260);
  }

  clear(): void {
    this.particles = [];
    this.popups = [];
    this.rings = [];
    this.shake = 0;
  }
}
