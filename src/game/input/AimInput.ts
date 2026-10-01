import type { Vec2 } from '../types';

/** То, чем управляет ввод (реализуется движком). */
export interface InputTarget {
  /** Нажатие. true — нажатие «взяло» сақа, начинаем прицеливание. */
  pointerDown(p: Vec2): boolean;
  /** Движение указателя; pressed=false — просто наведение мышью. */
  pointerMove(p: Vec2, pressed: boolean): void;
  pointerUp(p: Vec2): void;
  pointerCancel(): void;
  keyAim(dAngle: number, dPower: number): void;
  keyThrow(): void;
  keyEscape(): void;
  cursor(): string;
}

const DEG = Math.PI / 180;

/**
 * Ввод через Pointer Events (мышь, палец, стилус — один код) + клавиатура.
 * Управление не зависит от hover: на телефоне достаточно коснуться руки и потянуть.
 */
export class AimInput {
  private activePointer: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly toWorld: (x: number, y: number) => Vec2,
    private readonly target: InputTarget,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('lostpointercapture', this.onLost);
    canvas.addEventListener('contextmenu', this.prevent);
    window.addEventListener('keydown', this.onKey);
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLost);
    this.canvas.removeEventListener('contextmenu', this.prevent);
    window.removeEventListener('keydown', this.onKey);
  }

  /** Сбросить активный жест (например, при паузе). */
  reset(): void {
    if (this.activePointer !== null && this.canvas.hasPointerCapture?.(this.activePointer)) {
      this.canvas.releasePointerCapture(this.activePointer);
    }
    this.activePointer = null;
  }

  private point(e: PointerEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return this.toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  private prevent = (e: Event) => e.preventDefault();

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.activePointer !== null) return; // второй палец игнорируем
    if (this.target.pointerDown(this.point(e))) {
      this.activePointer = e.pointerId;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* старые браузеры */
      }
      e.preventDefault();
    }
    this.canvas.style.cursor = this.target.cursor();
  };

  private onMove = (e: PointerEvent) => {
    if (this.activePointer === e.pointerId) {
      this.target.pointerMove(this.point(e), true);
    } else if (this.activePointer === null && e.pointerType === 'mouse') {
      this.target.pointerMove(this.point(e), false);
    }
    this.canvas.style.cursor = this.target.cursor();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.target.pointerUp(this.point(e));
    this.canvas.style.cursor = this.target.cursor();
  };

  private onCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.target.pointerCancel();
  };

  private onLost = (e: PointerEvent) => {
    // захват потерян не через pointerup (например, системный жест) — отменяем прицел
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.target.pointerCancel();
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    const inControl = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A' || el?.isContentEditable;
    const fine = e.shiftKey ? 5 : 1;
    let handled = true;
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.target.keyAim(-fine * DEG, 0);
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.target.keyAim(fine * DEG, 0);
        break;
      case 'ArrowUp':
      case 'KeyW':
        this.target.keyAim(0, e.shiftKey ? 0.1 : 0.02);
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.target.keyAim(0, e.shiftKey ? -0.1 : -0.02);
        break;
      case 'Space':
      case 'Enter':
        // пробел/Enter на кнопке — это нажатие кнопки, а не бросок
        if (inControl) return;
        this.target.keyThrow();
        break;
      case 'Escape':
        this.target.keyEscape();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
}
