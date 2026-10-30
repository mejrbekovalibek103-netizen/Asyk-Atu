import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchResult, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Modal } from '../components/Modal';
import { Ornament } from '../components/Ornament';
import { listNames as names, plural } from '../format';

/**
 * Онлайн: готовность к реваншу. Хозяин начинает реванш, когда готовы все игроки, которые ещё в комнате.
 * Если кто-то уже ушёл в комнату ожидания, реванша не будет — следующий матч (и кон) выбирают там.
 */
export interface OnlineRematch {
  /** Я уже нажал «Реванш». */
  ready: boolean;
  /** Кто из остальных уже готов. */
  readyNames: string[];
  /** Кого ещё ждём (в комнате, но не нажали). */
  waitingNames: string[];
  /** Кто вышел из матча или не в сети. */
  goneNames: string[];
  /** Кто уже вернулся в комнату ожидания. */
  lobbyNames: string[];
  /** Реванш вообще возможен: в комнате остался хотя бы один соперник и никто не ушёл в комнату ожидания. */
  possible: boolean;
}

interface Props {
  result: MatchResult;
  layoutName: string;
  onRematch: () => void;
  onNewMatch: () => void;
  onHome: () => void;
  online?: OnlineRematch;
  newMatchLabel?: string;
  homeLabel?: string;
}

export function MatchResultOverlay({
  result: r,
  layoutName,
  onRematch,
  onNewMatch,
  onHome,
  online,
  newMatchLabel = 'Новый матч',
  homeLabel = 'На главную',
}: Props) {
  const n = r.players.length;
  const winnerNames = r.winners.map((s) => r.players[s].name);
  const title =
    r.winners.length === 1 ? `Победа: ${winnerNames[0]}!` : r.winners.length === n ? 'Ничья!' : `Ничья: ${names(winnerNames)}`;
  const reason =
    r.reason === 'cleared'
      ? 'Кон пуст — все асыки выбиты.'
      : `${n === 2 ? 'У обоих' : 'У всех'} закончились броски (по ${r.throwsPerPlayer}).`;
  // при трёх-четырёх игроках — места по числу выбитых асыков (при равенстве — по месту за столом)
  const order = r.players.map((_, i) => i as Seat).sort((a, b) => r.players[b].knocked - r.players[a].knocked || a - b);
  const placeOf = (seat: Seat) => 1 + r.players.filter((p) => p.knocked > r.players[seat].knocked).length;

  const othersReady = (online?.readyNames.length ?? 0) > 0;
  const toLobby = (online?.lobbyNames.length ?? 0) > 0;
  const rematchLabel = !online
    ? 'Реванш'
    : online.ready
      ? online.waitingNames.length
        ? 'Ждём остальных…'
        : 'Начинаем…'
      : othersReady
        ? 'Принять реванш'
        : 'Предложить реванш';

  return (
    <Modal labelledBy="match-result-title" className="modal--result">
      <Ornament className="modal__ornament" />
      <p className="modal__kicker">Матч · {layoutName}</p>
      <h2 id="match-result-title" className="modal__title">
        {title}
      </h2>
      <p className="modal__text">{reason}</p>
      <div className={`match-score match-score--${n}`}>
        {(n > 2 ? order : r.players.map((_, i) => i as Seat)).map((seat) => {
          const p = r.players[seat];
          const won = r.winners.includes(seat);
          return (
            <div
              key={seat}
              className={`match-score__player${won ? ' match-score__player--won' : ''}`}
              style={{ '--player': PLAYER_STYLE[seat].color } as React.CSSProperties}
            >
              <span className="match-score__crown" aria-hidden="true">
                {won ? '🏆' : ''}
              </span>
              {n > 2 && <span className="match-score__place">{placeOf(seat)} место</span>}
              <AsykIcon palette={PLAYER_STYLE[seat].palette} size={28} />
              <span className="match-score__name">{p.name}</span>
              <span className="match-score__knocked">{p.knocked}</span>
              <span className="match-score__label">{plural(p.knocked, ['асык', 'асыка', 'асыков'])}</span>
              <span className="match-score__meta">
                {p.throws} {plural(p.throws, ['бросок', 'броска', 'бросков'])}
                {p.bestCombo >= 2 ? ` · комбо ×${p.bestCombo}` : ''}
              </span>
            </div>
          );
        })}
      </div>
      {online && othersReady && !online.ready && (
        <p className="result-tip" role="status">
          {names(online.readyNames)} {online.readyNames.length === 1 ? 'предлагает' : 'предлагают'} реванш
        </p>
      )}
      {online && online.ready && online.waitingNames.length > 0 && (
        <p className="result-tip" role="status">
          Ждём: {names(online.waitingNames)}
        </p>
      )}
      {online && toLobby && (
        <p className="result-tip" role="status">
          {names(online.lobbyNames)} уже в комнате ожидания — продолжим там
        </p>
      )}
      {online && online.goneNames.length > 0 && (
        <p className="result-tip" role="status">
          {names(online.goneNames)} {online.goneNames.length === 1 ? 'вышел' : 'вышли'} из матча
        </p>
      )}
      <div className="result-actions">
        <button
          className={`btn${toLobby ? '' : ' btn--primary'}`}
          onClick={onRematch}
          data-autofocus={toLobby ? undefined : true}
          disabled={online && (online.ready || !online.possible)}
        >
          {rematchLabel}
        </button>
        <button className={`btn${toLobby ? ' btn--primary' : ''}`} onClick={onNewMatch} data-autofocus={toLobby ? true : undefined}>
          {newMatchLabel}
        </button>
        <button className="btn btn--ghost" onClick={onHome}>
          {homeLabel}
        </button>
      </div>
    </Modal>
  );
}
