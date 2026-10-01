interface Props {
  value: number;
  max?: number;
  size?: number;
  animate?: boolean;
}

export function Stars({ value, max = 3, size = 22, animate = false }: Props) {
  return (
    <span className={`stars${animate ? ' stars--animate' : ''}`} role="img" aria-label={`${value} из ${max} звёзд`}>
      {Array.from({ length: max }, (_, i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          className={i < value ? 'star star--on' : 'star'}
          style={animate ? { animationDelay: `${0.25 + i * 0.22}s` } : undefined}
          aria-hidden="true"
        >
          <path d="M12 2.6l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.2 20.1l1.4-6.4L2.7 9.3l6.5-.7z" />
        </svg>
      ))}
    </span>
  );
}
