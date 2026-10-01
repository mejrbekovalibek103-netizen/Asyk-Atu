type IconName = 'pause' | 'play' | 'restart' | 'sound' | 'mute' | 'back' | 'lock' | 'trophy' | 'help' | 'home' | 'grid' | 'info' | 'close';

const PATHS: Record<IconName, string> = {
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  play: 'M8 5.5v13l10.5-6.5z',
  restart: 'M12 5a7 7 0 1 1-6.6 4.7M5 4.5v5h5',
  sound: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  back: 'M15 5l-7 7 7 7',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20h7M10 17h4',
  help: 'M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1.2-1.5 2.3M12 17.5v.5M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  home: 'M4 11l8-6.5 8 6.5M6.5 9.5V19h11V9.5',
  grid: 'M5 5h5.5v5.5H5zM13.5 5H19v5.5h-5.5zM5 13.5h5.5V19H5zM13.5 13.5H19V19h-5.5z',
  info: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 10.5V16.5M12 7.5v.5',
  close: 'M6 6l12 12M18 6L6 18',
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const filled = name === 'pause' || name === 'play';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path
        d={PATHS[name]}
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
