import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchHud, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';

/** Карточка игрока в HUD матча: имя, счёт, «бросает», в онлайне — отметка «вы». */
export function PlayerCard({ seat, hud, offline = false }: { seat: Seat; hud: MatchHud | null; offline?: boolean }) {
  const p = hud?.players[seat];
  const active = hud?.current === seat;
  const me = hud?.localSeat === seat;
  return (
    <div
      className={`player-card${active ? ' player-card--active' : ''}${offline ? ' player-card--offline' : ''}`}
      style={{ '--player': PLAYER_STYLE[seat].color } as React.CSSProperties}
      aria-label={`${p?.name ?? ''}${me ? ' (вы)' : ''}: выбито ${p?.knocked ?? 0}${active ? ', сейчас бросает' : ''}${offline ? ', не в сети' : ''}`}
    >
      <AsykIcon palette={PLAYER_STYLE[seat].palette} size={20} />
      <span className="player-card__name">
        {p?.name}
        {me && <small className="player-card__me"> · вы</small>}
      </span>
      <b className="player-card__score bump" key={p?.knocked}>
        {p?.knocked ?? 0}
      </b>
      {active && <span className="player-card__turn">{offline ? 'не в сети' : 'бросает'}</span>}
    </div>
  );
}

/**
 * Крупная надпись при каждой смене хода. На одном устройстве — «Ход: имя» (сигнал передать телефон),
 * в онлайне — «Ваш ход» или «Ход соперника».
 */
export function TurnBanner({ hud, y }: { hud: MatchHud; y: number }) {
  const p = hud.players[hud.current];
  const online = hud.localSeat !== null;
  const mine = hud.localSeat === hud.current;
  return (
    <div key={hud.turnId} className="turn-banner" style={{ top: y, '--player': PLAYER_STYLE[hud.current].color } as React.CSSProperties} aria-hidden="true">
      <span className="turn-banner__label">{online ? (mine ? 'Ваш ход' : 'Ход соперника') : 'Ход'}</span>
      <span className="turn-banner__name">{p.name}</span>
    </div>
  );
}
