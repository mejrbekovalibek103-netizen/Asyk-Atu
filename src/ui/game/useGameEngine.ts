import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { GameEngine } from '../../game/engine/GameEngine';
import { computeCamera, type Camera } from '../../game/render/Renderer';
import type { HudSnapshot } from '../../game/types';

const noopSubscribe = () => () => undefined;

export interface EngineView {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  hudRef: React.RefObject<HTMLElement | null>;
  engine: GameEngine | null;
  snap: HudSnapshot | null;
  camera: Camera;
  size: { w: number; h: number; top: number };
  /** Координаты мира → экранные CSS-пиксели (для позиционирования подсказок). */
  w2s: (x: number, y: number) => { x: number; y: number };
}

/**
 * Создаёт движок на canvas, следит за размером экрана и высотой HUD,
 * отдаёт снимок состояния для интерфейса. Движок пересоздаётся при смене `key`.
 */
export function useGameEngine(create: (canvas: HTMLCanvasElement) => GameEngine, key: unknown): EngineView {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLElement>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [camera, setCamera] = useState<Camera>({ scale: 0.5, offsetX: 0, offsetY: 0 });
  const [size, setSize] = useState({ w: 0, h: 0, top: 0 });
  const createRef = useRef(create);
  createRef.current = create;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const eng = createRef.current(canvas);
    const measure = () => {
      const r = container.getBoundingClientRect();
      const top = (hudRef.current?.getBoundingClientRect().height ?? 0) + 8;
      eng.resize(r.width, r.height, top);
      setCamera(computeCamera(r.width, r.height, top));
      setSize({ w: r.width, h: r.height, top });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    if (hudRef.current) ro.observe(hudRef.current);
    eng.start();
    setEngine(eng);
    return () => {
      ro.disconnect();
      eng.destroy();
      setEngine(null);
    };
  }, [key]);

  const snap = useSyncExternalStore<HudSnapshot | null>(engine ? engine.subscribe : noopSubscribe, engine ? engine.getSnapshot : () => null);

  useLayoutEffect(() => {
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  const w2s = (x: number, y: number) => ({ x: camera.offsetX + x * camera.scale, y: camera.offsetY + y * camera.scale });

  return { containerRef, canvasRef, hudRef, engine, snap, camera, size, w2s };
}

/** Пауза при сворачивании вкладки (сравнение с колбэком, чтобы не пересоздавать подписку). */
export function usePauseOnHide(onHide: () => void, enabled: boolean): void {
  const ref = useRef(onHide);
  ref.current = onHide;
  useEffect(() => {
    if (!enabled) return;
    const h = () => {
      if (document.hidden) ref.current();
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [enabled]);
}
