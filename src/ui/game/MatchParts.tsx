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
 * Одно устройство: карточка «Передайте устройство». Пока она на экране, бросок заблокирован,
 * а кон виден — следующий игрок успевает рассмотреть расстановку, предыдущий не бросит по ошибке.
 */
export function HandoffCard({ hud, y, onReady }: { hud: MatchHud; y: number; onReady: () => void }) {
  const p = hud.players[hud.current];
  const first = hud.totalThrows === 0;
  return (
    <div
      key={hud.turnId}
      className="handoff"
      style={{ top: y, '--player': PLAYER_STYLE[hud.current].color } as React.CSSProperties}
      role="group"
      aria-label={`Передайте устройство игроку ${p.name}`}
    >
      <span className="handoff__label">{first ? 'Первым бросает' : 'Передайте устройство'}</span>
      <span className="handoff__name">{p.name}</span>
      <button className="btn btn--primary btn--block" onClick={onReady} data-autofocus autoFocus>
        Готов — бросаю
      </button>
    </div>
  );
}

/**
 * Крупная надпись при каждой смене хода. На одном устройстве — «Ход: имя» (сигнал передать телефон),
 * в онлайне — «Ваш ход» или «Ходит: имя» (соперников может быть до трёх).
 */
export function TurnBanner({ hud, y }: { hud: MatchHud; y: number }) {
  const p = hud.players[hud.current];
  const online = hud.localSeat !== null;
  const mine = hud.localSeat === hud.current;
  return (
    <div key={hud.turnId} className="turn-banner" style={{ top: y, '--player': PLAYER_STYLE[hud.current].color } as React.CSSProperties} aria-hidden="true">
      <span className="turn-banner__label">{online ? (mine ? 'Ваш ход' : 'Ходит') : 'Ход'}</span>
      <span className="turn-banner__name">{p.name}</span>
    </div>
  );
}
