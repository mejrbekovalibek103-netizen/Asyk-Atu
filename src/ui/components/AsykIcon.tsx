import { useId } from 'react';
import { asykPathD, PALETTES, type AsykPalette } from '../../game/render/asykShape';

const PATH = asykPathD(54, 38);

interface Props {
  palette?: AsykPalette;
  size?: number;
  /** Пустой контур (ещё не выбитый асык в «трее»). */
  ghost?: boolean;
  rotate?: number;
  className?: string;
  title?: string;
}

/** SVG-асык — та же форма, что и в игре. */
export function AsykIcon({ palette = 'bone', size = 28, ghost = false, rotate = 0, className, title }: Props) {
  const id = useId();
  const pal = PALETTES[palette];
  const h = Math.round((size * 38) / 54);
  return (
    <svg
      className={className}
      width={size}
      height={h}
      viewBox="-30 -22 60 44"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={pal.light} />
          <stop offset="0.5" stopColor={pal.mid} />
          <stop offset="1" stopColor={pal.dark} />
        </linearGradient>
      </defs>
      {ghost ? (
        <path d={PATH} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="4 3" opacity="0.55" />
      ) : (
        <>
          <path d={PATH} fill={`url(#${id})`} stroke={pal.stroke} strokeWidth="1.6" />
          <ellipse cx="-8" cy="-7" rx="10" ry="4.5" fill="#fff" opacity="0.3" />
          {palette === 'saka' && <ellipse cx="6" cy="1" rx="3.5" ry="3.8" fill="#9aa3ad" />}
        </>
      )}
    </svg>
  );
}
