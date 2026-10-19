import { goalText, starRuleText } from '../../game/levels/levels';
import type { LevelConfig, RoundResult } from '../../game/types';
import type { RecordOutcome } from '../../storage/progress';
import { Modal } from '../components/Modal';
import { Ornament } from '../components/Ornament';
import { Stars } from '../components/Stars';
import { clock } from '../format';

interface Props {
  level: LevelConfig;
  result: RoundResult;
  outcome: RecordOutcome;
  nextId: string | null;
  onAgain: () => void;
  onNext: (id: string) => void;
  onLevels: () => void;
  onHome: () => void;
}

/** Подсказка «как улучшить результат» — к чему стремиться дальше. */
function improveTip(level: LevelConfig, r: RoundResult): string {
  if (!r.passed) return `${r.timeUp ? 'Не хватило времени. ' : ''}Цель: ${goalText(level).toLowerCase()}. ${level.hint}`;
  if (r.stars < 3) return `До ${r.stars + 1}★: ${starRuleText(level.stars[r.stars - 1], level).toLowerCase()}.`;
  return 'Три звезды! Попробуй побить свой рекорд очков — комбо и серии дают бонусы.';
}

export function ResultOverlay({ level, result: r, outcome, nextId, onAgain, onNext, onLevels, onHome }: Props) {
  const title = r.timeUp ? (r.passed ? 'Время вышло — испытание пройдено!' : 'Время вышло!') : r.passed ? 'Испытание пройдено!' : 'Раунд завершён!';
  return (
    <Modal labelledBy="result-title" className="modal--result">
      <Ornament className="modal__ornament" />
      <p className="modal__kicker">
        {level.order}. {level.name} · {level.kazName}
      </p>
      <h2 id="result-title" className="modal__title">
        {title}
      </h2>
      <Stars value={r.stars} size={40} animate />
      {outcome.isNewRecord && (
        <div className="record-badge" role="status">
          <span aria-hidden="true">🏆</span> Новый рекорд!
        </div>
      )}
      <dl className="result-grid">
        <div className="result-grid__main">
          <dt>Очки</dt>
          <dd>{r.score}</dd>
        </div>
        <div>
          <dt>Выбито асыков</dt>
          <dd>
            {r.knocked} <small>/ {r.totalAsyks}</small>
          </dd>
        </div>
        <div>
          <dt>Бросков</dt>
          <dd>
            {r.throwsUsed} <small>/ {r.throwsTotal}</small>
          </dd>
        </div>
        {r.timeLimit !== null && (
          <div>
            <dt>Время</dt>
            <dd>
              {clock(r.timeUsedMs)} <small>/ {clock(r.timeLimit * 1000)}</small>
            </dd>
          </div>
        )}
        {r.bestCombo >= 2 && (
          <div>
            <dt>Лучшее комбо</dt>
            <dd>×{r.bestCombo}</dd>
          </div>
        )}
        {r.cleanBonus > 0 && (
          <div>
            <dt>Таза кон</dt>
            <dd>+{r.cleanBonus}</dd>
          </div>
        )}
        {level.goal.type === 'target' && (
          <div>
            <dt>Синий асык</dt>
            <dd>{r.targetThrow ? `бросок ${r.targetThrow}` : 'устоял'}</dd>
          </div>
        )}
      </dl>
      <p className="result-best">
        Лучший результат: <b>{outcome.levelBest}</b>
      </p>
      <p className="result-tip">{improveTip(level, r)}</p>
      <div className="result-actions">
        <button className="btn btn--primary" onClick={onAgain} data-autofocus>
          Играть снова
        </button>
        {nextId && r.passed && (
          <button className="btn btn--sun" onClick={() => onNext(nextId)}>
            Следующее испытание →
          </button>
        )}
        <button className="btn" onClick={onLevels}>
          Испытания
        </button>
        <button className="btn btn--ghost" onClick={onHome}>
          На главную
        </button>
      </div>
    </Modal>
  );
}
