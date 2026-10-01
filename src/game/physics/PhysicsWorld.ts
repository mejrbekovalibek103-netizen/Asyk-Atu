import Matter from 'matter-js';
import { ASYK_H, ASYK_W, CURB, PHYS, SAKA_H, SAKA_W, WORLD_H, WORLD_W } from '../config';
import { zoneContains } from '../levels/zone';
import type { AsykFace, AsykSpawn, PieceKind, Vec2, Zone } from '../types';
import { angularFrictionStep, frictionStep } from './friction';

const { Engine, Bodies, Body, Composite, Events } = Matter;

/** Категории столкновений (битовые маски Matter.js). */
export const CAT = {
  WALL: 0x0001,
  SAKA: 0x0002,
  ASYK: 0x0004,
  /** Уже выбитый асык: сталкивается только с бордюром, не мешает игре. */
  OUT: 0x0008,
} as const;

const FACES: AsykFace[] = ['alshy', 'taiky', 'buk', 'shik'];

export interface Piece {
  id: number;
  kind: PieceKind;
  body: Matter.Body;
  status: 'in' | 'out';
  face: AsykFace;
  /** Время (мс симуляции), когда асык был выбит. */
  outAt: number | null;
  /** Номер броска, которым выбит. */
  outThrow: number | null;
  /** Визуальная «вибрация» после удара, 0…1. */
  wobble: number;
}

export type ContactType = 'saka-asyk' | 'asyk-asyk' | 'wall';

export interface ContactEvent {
  x: number;
  y: number;
  /** Относительная скорость вдоль нормали в момент удара. */
  impact: number;
  type: ContactType;
  pieces: Piece[];
}

/**
 * Физический мир игры поверх Matter.js (вид сверху, гравитации нет).
 *
 * Не зависит от DOM — поэтому его можно гонять в unit-тестах (headless-симуляция бросков).
 */
export class PhysicsWorld {
  readonly engine: Matter.Engine;
  readonly pieces: Piece[] = [];
  saka: Piece | null = null;
  /** Время симуляции, мс. */
  time = 0;

  private nextId = 1;
  private contacts: ContactEvent[] = [];
  private readonly byBodyId = new Map<number, Piece>();

  constructor() {
    this.engine = Engine.create({
      gravity: { x: 0, y: 0, scale: 0 },
      positionIterations: 8,
      velocityIterations: 6,
      enableSleeping: false,
    });
    this.addWalls();
    Events.on(this.engine, 'beforeUpdate', this.applyGroundFriction);
    Events.on(this.engine, 'collisionStart', this.onCollisionStart);
  }

  /** Бордюр двора: толстые статические стены за пределами игровой площадки. */
  private addWalls(): void {
    const T = 240;
    const opts: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      restitution: PHYS.restitution.wall,
      friction: 0.2,
      label: 'wall',
      collisionFilter: { category: CAT.WALL, mask: CAT.SAKA | CAT.ASYK | CAT.OUT },
    };
    Composite.add(this.engine.world, [
      Bodies.rectangle(CURB - T / 2, WORLD_H / 2, T, WORLD_H + 2 * T, opts),
      Bodies.rectangle(WORLD_W - CURB + T / 2, WORLD_H / 2, T, WORLD_H + 2 * T, opts),
      Bodies.rectangle(WORLD_W / 2, CURB - T / 2, WORLD_W + 2 * T, T, opts),
      Bodies.rectangle(WORLD_W / 2, WORLD_H + T / 2, WORLD_W + 2 * T, T, opts),
    ]);
  }

  addAsyks(spawns: AsykSpawn[]): void {
    spawns.forEach((s, i) => {
      const kind: PieceKind = s.kind === 'target' ? 'target' : 'asyk';
      const body = Bodies.rectangle(s.x, s.y, ASYK_W, ASYK_H, {
        chamfer: { radius: 11 },
        angle: s.angle ?? 0,
        density: PHYS.density.asyk,
        restitution: PHYS.restitution.asyk,
        friction: PHYS.friction,
        frictionStatic: 0.2,
        frictionAir: 0, // трение о землю считаем сами (см. applyGroundFriction)
        label: kind,
        collisionFilter: { category: CAT.ASYK, mask: CAT.WALL | CAT.SAKA | CAT.ASYK },
      });
      this.register({
        id: this.nextId++,
        kind,
        body,
        status: 'in',
        face: FACES[(i * 7 + 1) % FACES.length],
        outAt: null,
        outThrow: null,
        wobble: 0,
      });
    });
  }

  /**
   * Запускает сақа из точки origin.
   * @param aimAngle угол от направления «вперёд» (вверх по экрану), + вправо, радианы
   * @param speed начальная скорость (единиц мира за 1/60 с)
   * @param spin начальная угловая скорость
   */
  launchSaka(origin: Vec2, aimAngle: number, speed: number, spin: number): Piece {
    this.removeSaka();
    const dir = { x: Math.sin(aimAngle), y: -Math.cos(aimAngle) };
    const body = Bodies.rectangle(origin.x, origin.y, SAKA_W, SAKA_H, {
      chamfer: { radius: 12 },
      // длинная ось сақа — вдоль направления полёта
      angle: Math.atan2(dir.y, dir.x),
      density: PHYS.density.saka,
      restitution: PHYS.restitution.saka,
      friction: PHYS.friction,
      frictionStatic: 0.2,
      frictionAir: 0,
      label: 'saka',
      collisionFilter: { category: CAT.SAKA, mask: CAT.WALL | CAT.ASYK },
    });
    const piece: Piece = {
      id: this.nextId++,
      kind: 'saka',
      body,
      status: 'in',
      face: 'alshy',
      outAt: null,
      outThrow: null,
      wobble: 0,
    };
    this.register(piece);
    Body.setVelocity(body, { x: dir.x * speed, y: dir.y * speed });
    Body.setAngularVelocity(body, spin);
    this.saka = piece;
    return piece;
  }

  removeSaka(): void {
    if (this.saka) this.removePiece(this.saka);
    this.saka = null;
  }

  removePiece(piece: Piece): void {
    const i = this.pieces.indexOf(piece);
    if (i >= 0) this.pieces.splice(i, 1);
    this.byBodyId.delete(piece.body.id);
    Composite.remove(this.engine.world, piece.body);
    if (this.saka === piece) this.saka = null;
  }

  /** Один фиксированный шаг симуляции. */
  step(): void {
    Engine.update(this.engine, PHYS.stepMs);
    this.time += PHYS.stepMs;
    for (const p of this.pieces) {
      if (p.wobble > 0) p.wobble = Math.max(0, p.wobble - PHYS.stepMs / 380);
    }
  }

  /** Забирает накопленные события столкновений (для звука и эффектов). */
  drainContacts(): ContactEvent[] {
    const c = this.contacts;
    this.contacts = [];
    return c;
  }

  /**
   * Проверяет, какие асыки покинули кон. Статус меняется строго один раз: 'in' → 'out',
   * поэтому один асык не может быть засчитан дважды.
   */
  checkKnockouts(zone: Zone, throwIndex: number): Piece[] {
    const out: Piece[] = [];
    for (const p of this.pieces) {
      if (p.kind === 'saka' || p.status !== 'in') continue;
      if (!zoneContains(zone, p.body.position)) {
        p.status = 'out';
        p.outAt = this.time;
        p.outThrow = throwIndex;
        // выбитый асык продолжает скользить и отражаться от бордюра, но больше ни с чем не сталкивается
        p.body.collisionFilter = { category: CAT.OUT, mask: CAT.WALL, group: 0 };
        out.push(p);
      }
    }
    return out;
  }

  /** Все значимые объекты (сақа и асыки в игре) остановились. */
  isSettled(): boolean {
    for (const p of this.pieces) {
      if (p.status !== 'in') continue;
      if (Body.getSpeed(p.body) > 0.05 || Math.abs(Body.getAngularVelocity(p.body)) > 0.004) return false;
    }
    return true;
  }

  /** Принудительно останавливает всё (страховка от «вечного» броска). */
  stopAll(): void {
    for (const p of this.pieces) {
      Body.setVelocity(p.body, { x: 0, y: 0 });
      Body.setAngularVelocity(p.body, 0);
    }
  }

  asyksIn(): Piece[] {
    return this.pieces.filter((p) => p.kind !== 'saka' && p.status === 'in');
  }

  destroy(): void {
    Events.off(this.engine, 'beforeUpdate', this.applyGroundFriction);
    Events.off(this.engine, 'collisionStart', this.onCollisionStart);
    Composite.clear(this.engine.world, false);
    Engine.clear(this.engine);
    this.pieces.length = 0;
    this.byBodyId.clear();
    this.saka = null;
  }

  private register(piece: Piece): void {
    this.pieces.push(piece);
    this.byBodyId.set(piece.body.id, piece);
    Composite.add(this.engine.world, piece.body);
  }

  /**
   * Трение о землю (вызывается Matter.js перед каждым шагом интегрирования).
   * Вид сверху: гравитации нет, поэтому трение скольжения моделируем вручную —
   * уменьшаем модуль скорости на постоянную величину, сохраняя направление.
   */
  private applyGroundFriction = (): void => {
    for (const p of this.pieces) {
      const b = p.body;
      const decel = p.kind === 'saka' ? PHYS.decel.saka : PHYS.decel.asyk;
      const v = Body.getVelocity(b);
      const s = Math.hypot(v.x, v.y);
      if (s > 0) {
        const ns = frictionStep(s, decel);
        Body.setVelocity(b, ns === 0 ? { x: 0, y: 0 } : { x: (v.x / s) * ns, y: (v.y / s) * ns });
      }
      const av = Body.getAngularVelocity(b);
      if (av !== 0) Body.setAngularVelocity(b, angularFrictionStep(av));
    }
  };

  private onCollisionStart = (e: Matter.IEventCollision<Matter.Engine>): void => {
    for (const pair of e.pairs) {
      const a = pair.bodyA.parent;
      const b = pair.bodyB.parent;
      const pa = this.byBodyId.get(a.id);
      const pb = this.byBodyId.get(b.id);
      const va = Body.getVelocity(a);
      const vb = Body.getVelocity(b);
      const n = pair.collision.normal;
      const impact = Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y);

      let type: ContactType;
      if (a.isStatic || b.isStatic) {
        type = 'wall';
        // бордюр «глушит» удар сильнее, чем кость о кость
        pair.restitution = PHYS.restitution.wall;
      } else if (pa?.kind === 'saka' || pb?.kind === 'saka') {
        type = 'saka-asyk';
      } else {
        type = 'asyk-asyk';
      }

      const support = pair.collision.supports?.[0];
      const x = support ? support.x : (a.position.x + b.position.x) / 2;
      const y = support ? support.y : (a.position.y + b.position.y) / 2;
      const pieces = [pa, pb].filter((p): p is Piece => !!p);
      for (const p of pieces) {
        if (p.kind !== 'saka') p.wobble = Math.max(p.wobble, Math.min(1, impact / 10));
      }
      if (impact > 0.4) this.contacts.push({ x, y, impact, type, pieces });
    }
  };
}
