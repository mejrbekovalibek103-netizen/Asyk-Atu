import { MATCH_MAX_THROWS, PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchResult, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Modal } from '../components/Modal';
import { Ornament } from '../components/Ornament';
import { plural } from '../format';

interface Props {
  result: MatchResult;
  layoutName: string;
  onRematch: () => void;
  onNewMatch: () => void;
  onHome: () => void;
  /** Онлайн: реванш требует согласия обоих. */
  online?: { rematch: 'idle' | 'sent' | 'received'; opponent: string; opponentLeft: boolean };
  newMatchLabel?: string;
}

export function MatchResultOverlay({ result: r, layoutName, onRematch, onNewMatch, onHome, online, newMatchLabel = 'Новый матч' }: Props) {
  const title = r.winner === null ? 'Ничья!' : `Победа: ${r.players[r.winner].name}!`;
  const reason = r.reason === 'cleared' ? 'Кон пуст — все асыки выбиты.' : `У обоих закончились броски (по ${MATCH_MAX_THROWS / 2}).`;
  return (
    <Modal labelledBy="match-result-title" className="modal--result">
      <Ornament className="modal__ornament" />
      <p className="modal__kicker">Матч · {layoutName}</p>
      <h2 id="match-result-title" className="modal__title">
        {title}
      </h2>
      <p className="modal__text">{reason}</p>
      <div className="match-score">
        {([0, 1] as Seat[]).map((seat) => {
          const p = r.players[seat];
          const won = r.winner === seat;
          return (
            <div
              key={seat}
              className={`match-score__player${won ? ' match-score__player--won' : ''}`}
              style={{ '--player': PLAYER_STYLE[seat].color } as React.CSSProperties}
            >
              <span className="match-score__crown" aria-hidden="true">
                {won ? '🏆' : ''}
              </span>
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
      {online?.rematch === 'received' && !online.opponentLeft && (
        <p className="result-tip" role="status">
          {online.opponent} предлагает реванш
        </p>
      )}
      {online?.opponentLeft && (
        <p className="result-tip" role="status">
          {online.opponent} вышел из матча
        </p>
      )}
      <div className="result-actions">
        <button
          className="btn btn--primary"
          onClick={onRematch}
          data-autofocus
          disabled={online && (online.rematch === 'sent' || online.opponentLeft)}
        >
          {!online ? 'Реванш' : online.rematch === 'received' ? 'Принять реванш' : online.rematch === 'sent' ? 'Ждём ответ соперника…' : 'Предложить реванш'}
        </button>
        <button className="btn" onClick={onNewMatch}>
          {newMatchLabel}
        </button>
        <button className="btn btn--ghost" onClick={onHome}>
          На главную
        </button>
      </div>
    </Modal>
  );
}
