/**
 * «Қошқар мүйіз» (бараний рог) — классический казахский орнамент.
 * Используется умеренно: как разделитель и акцент.
 */
export function Ornament({ className, width = 120 }: { className?: string; width?: number }) {
  return (
    <svg className={className} width={width} height={(width * 28) / 120} viewBox="0 0 120 28" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 14 H38" />
        <path d="M82 14 H118" />
        {/* левый рог */}
        <path d="M60 22 C60 12 54 6 47 6 C40 6 37 12 40 16 C43 20 49 18 48 13" />
        {/* правый рог */}
        <path d="M60 22 C60 12 66 6 73 6 C80 6 83 12 80 16 C77 20 71 18 72 13" />
        <path d="M60 22 V26" />
      </g>
    </svg>
  );
}
