import type { HudMessage } from '../../game/types';
import type { EngineView } from './useGameEngine';

/** Шкала силы рядом с рукой (позиция пересчитывается из координат мира). */
export function PowerMeter({ view, power, aiming }: { view: EngineView; power: number; aiming: boolean }) {
  const pct = Math.round(power * 100);
  const top = view.w2s(0, 870).y;
  const bottom = view.w2s(0, 1140).y;
  const left = Math.min(view.size.w - 58, view.w2s(628, 0).x);
  return (
    <div
      className={`power${aiming ? ' power--active' : ''}`}
      style={{ left, top, height: Math.max(90, bottom - top) }}
      role="meter"
      aria-label="Сила броска"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span className="power__label">Сила</span>
      <div className="power__track">
        <div className="power__fill" style={{ height: `${pct}%` }} />
        <span className="power__tick" style={{ bottom: '33%' }} />
        <span className="power__tick" style={{ bottom: '66%' }} />
      </div>
      <span className="power__value">{pct}%</span>
    </div>
  );
}

export function Toast({ message, top }: { message: HudMessage | null; top: number }) {
  if (!message) return null;
  return (
    <div key={message.id} className={`toast toast--${message.tone}`} style={{ top: top + 6 }} role="status">
      {message.text}
    </div>
  );
}

export function RotateHint({ view, hidden }: { view: EngineView; hidden: boolean }) {
  const { w, h } = view.size;
  if (hidden || !(h > 0 && h < 500 && w > h)) return null;
  return <div className="rotate-hint">Поверни телефон вертикально — поле будет крупнее</div>;
}
