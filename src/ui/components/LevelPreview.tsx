import { THROW_ORIGIN } from '../../game/config';
import { asykPathD } from '../../game/render/asykShape';
import type { LevelConfig } from '../../game/types';

const PATH = asykPathD(54, 38);

/** Мини-схема расстановки — строится из той же конфигурации, что и игра. */
export function LevelPreview({ level }: { level: LevelConfig }) {
  const z = level.zone;
  // кадрируем область кона и руки
  const vb = { x: 100, y: 200, w: 600, h: 920 };
  return (
    <svg className="level-preview" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} aria-hidden="true">
      <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill="#8f8980" />
      {z.kind === 'rect' ? (
        <rect x={z.x} y={z.y} width={z.w} height={z.h} fill="rgba(255,248,225,0.08)" stroke="#fbf8ef" strokeWidth="7" strokeDasharray="2 0" rx="4" />
      ) : (
        <circle cx={z.cx} cy={z.cy} r={z.r} fill="rgba(255,248,225,0.08)" stroke="#fbf8ef" strokeWidth="7" />
      )}
      {level.asyks.map((a, i) => (
        <path
          key={i}
          d={PATH}
          transform={`translate(${a.x} ${a.y}) rotate(${((a.angle ?? 0) * 180) / Math.PI})`}
          fill={a.kind === 'target' ? '#27a6c8' : '#efdcb6'}
          stroke="rgba(80,55,25,0.6)"
          strokeWidth="2"
        />
      ))}
      <line x1="250" y1="988" x2="550" y2="988" stroke="#fbf8ef" strokeWidth="6" strokeLinecap="round" opacity="0.8" />
      <path d={PATH} transform={`translate(${THROW_ORIGIN.x} ${THROW_ORIGIN.y}) rotate(-90) scale(1.1)`} fill="#d4442b" />
      <path
        d={`M ${THROW_ORIGIN.x} ${THROW_ORIGIN.y - 60} L ${THROW_ORIGIN.x} ${THROW_ORIGIN.y - 300}`}
        stroke="#ffd84d"
        strokeWidth="9"
        strokeDasharray="4 22"
        strokeLinecap="round"
      />
    </svg>
  );
}
