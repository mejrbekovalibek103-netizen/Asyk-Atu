import { asykPathD } from '../../game/render/asykShape';

const PATH = asykPathD(54, 38);

/**
 * Иллюстрация на главном экране: асфальт двора, меловой кон, ряд асыков
 * и летящий красный сақа. Сразу считывается: «это игра про асық ату».
 */
export function HeroScene() {
  const asyks = [0, 1, 2, 3, 4, 5, 6];
  return (
    <svg className="hero-scene" viewBox="0 0 520 380" role="img" aria-label="Ряд асыков на меловой линии и летящий к ним сақа">
      <defs>
        <linearGradient id="hs-ground" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a39c92" />
          <stop offset="1" stopColor="#857f77" />
        </linearGradient>
        <linearGradient id="hs-bone" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbf1dc" />
          <stop offset="0.5" stopColor="#ecd6ae" />
          <stop offset="1" stopColor="#c9a472" />
        </linearGradient>
        <linearGradient id="hs-saka" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f47a58" />
          <stop offset="0.5" stopColor="#d4442b" />
          <stop offset="1" stopColor="#8f2417" />
        </linearGradient>
        <radialGradient id="hs-sun" cx="0.2" cy="0.1" r="0.9">
          <stop offset="0" stopColor="#fff1c2" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff1c2" stopOpacity="0" />
        </radialGradient>
        <clipPath id="hs-clip">
          <rect x="0" y="0" width="520" height="380" rx="28" />
        </clipPath>
        <pattern id="hs-grain" width="7" height="7" patternUnits="userSpaceOnUse">
          <rect width="7" height="7" fill="none" />
          <circle cx="1.5" cy="2" r="0.9" fill="#fff" opacity="0.12" />
          <circle cx="5" cy="5.5" r="0.9" fill="#000" opacity="0.1" />
        </pattern>
      </defs>
      <g clipPath="url(#hs-clip)">
        <rect width="520" height="380" fill="url(#hs-ground)" />
        <rect width="520" height="380" fill="url(#hs-grain)" />
        {/* тень листвы */}
        <g fill="#1c2630" opacity="0.14">
          <ellipse cx="470" cy="40" rx="60" ry="30" />
          <ellipse cx="420" cy="20" rx="40" ry="22" />
          <ellipse cx="500" cy="100" rx="36" ry="24" />
          <ellipse cx="30" cy="330" rx="50" ry="28" />
        </g>
        {/* меловой кон */}
        <rect x="44" y="92" width="432" height="110" rx="6" fill="rgba(255,248,225,0.07)" stroke="#fbf8ef" strokeWidth="4" strokeDasharray="30 3 12 2" opacity="0.9" />
        <text x="54" y="84" fill="#fbf8ef" opacity="0.6" fontFamily="Unbounded Variable, sans-serif" fontWeight="700" fontSize="16">
          КОН
        </text>
        {/* ряд асыков */}
        {asyks.map((i) => {
          const x = 104 + i * 52;
          const knocked = i === 3;
          return (
            <g key={i} transform={`translate(${x} 148)`}>
              <g className={knocked ? 'hero-scene__hit' : undefined}>
                <path d={PATH} transform="translate(4 6) scale(1.08)" fill="#1c1408" opacity="0.22" />
                <path d={PATH} fill="url(#hs-bone)" stroke="rgba(110,76,38,0.55)" strokeWidth="1.5" transform={`rotate(${(i % 3) * 3 - 3})`} />
                <ellipse cx="-8" cy="-7" rx="10" ry="4" fill="#fff" opacity="0.3" />
              </g>
            </g>
          );
        })}
        {/* траектория */}
        <g fill="#ffd84d">
          {[0, 1, 2, 3, 4].map((i) => (
            <circle key={i} cx={260} cy={344 - i * 17} r={3 + i * 0.6} opacity={0.35 + i * 0.14} />
          ))}
        </g>
        {/* сақа */}
        <g transform="translate(260 240)">
          <g className="hero-scene__saka">
            <g transform="rotate(-90)">
              <path d={PATH} transform="translate(8 -6) scale(1.1)" fill="#1c1408" opacity="0.25" />
              <path d={PATH} fill="url(#hs-saka)" stroke="rgba(80,18,10,0.6)" strokeWidth="1.5" transform="scale(1.12)" />
              <ellipse cx="7" cy="1" rx="3.6" ry="4" fill="#9aa3ad" />
            </g>
          </g>
        </g>
        {/* линия броска */}
        <path d="M150 352 H370" stroke="#fbf8ef" strokeWidth="4" strokeLinecap="round" opacity="0.75" />
        <rect width="520" height="380" fill="url(#hs-sun)" />
      </g>
    </svg>
  );
}
