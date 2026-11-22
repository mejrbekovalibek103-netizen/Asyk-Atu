import type { Route } from '../routes';
import { AsykIcon } from './AsykIcon';
import { Icon } from './Icon';

/** Экраны с нижней панелью (решение владельца: только эти три — в игре, лобби и настройках матча панели нет). */
export const NAV_ROUTES = ['MENU', 'COLLECTION', 'RATING'] as const;
export type NavRoute = (typeof NAV_ROUTES)[number];

export function hasBottomNav(name: Route['name']): name is NavRoute {
  return (NAV_ROUTES as readonly string[]).includes(name);
}

interface Props {
  current: NavRoute;
  onNavigate: (r: Route) => void;
}

/** Нижняя навигация: Главная · Коллекция · Рейтинг. */
export function BottomNav({ current, onNavigate }: Props) {
  const item = (name: NavRoute, label: string, icon: React.ReactNode) => (
    <li>
      <button
        className={`bottom-nav__item${current === name ? ' bottom-nav__item--on' : ''}`}
        aria-current={current === name ? 'page' : undefined}
        onClick={() => current !== name && onNavigate({ name })}
      >
        <span className="bottom-nav__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="bottom-nav__label">{label}</span>
      </button>
    </li>
  );
  return (
    <nav className="bottom-nav" aria-label="Разделы">
      <ul>
        {item('MENU', 'Главная', <Icon name="home" />)}
        {item('COLLECTION', 'Коллекция', <AsykIcon size={24} />)}
        {item('RATING', 'Рейтинг', <Icon name="trophy" />)}
      </ul>
    </nav>
  );
}
