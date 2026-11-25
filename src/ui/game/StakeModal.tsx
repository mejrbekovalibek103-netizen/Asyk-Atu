import { STAKE_SIZE } from '../../net/collection';
import { AsykIcon } from '../components/AsykIcon';
import { Modal } from '../components/Modal';

interface Props {
  /** Сколько свободных асыков у игрока (null — коллекция ещё грузится). */
  free: number | null;
  /** Ставка отправлена, ждём базу. */
  busy: boolean;
  /** Текст отказа базы (не хватает асыков, матч уже начался…). */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Правила ставки — их игрок видит до того, как отдаст асыки в кон (docs/competitive-mode.md, раздел 2). */
const RULES: [string, string][] = [
  ['Что выбьешь — твоё, даже чужое.', 'Каждый выбитый асык после матча переходит тому, кто его выбил.'],
  ['Невыбитые вернутся хозяину.', 'Асыки, что остались в коне, вернутся в коллекцию.'],
  ['Выйдешь — твои асыки останутся в коне.', 'Сдача или закрытая вкладка ставку не спасают: их могут выбить.'],
  ['До старта ставку можно забрать.', 'Пока хозяин не бросил жребий, нажми «Забрать ставку».'],
];

/** Окно ставки: правила и кнопка «Поставить 5». */
export function StakeModal({ free, busy, error, onConfirm, onClose }: Props) {
  const enough = free === null || free >= STAKE_SIZE;
  return (
    <Modal labelledBy="stake-title" onClose={busy ? undefined : onClose} className="modal--stake">
      <p className="modal__kicker">Матч на асыки</p>
      <h2 id="stake-title" className="modal__title">
        Ставка в кон
      </h2>
      <p className="modal__text">Каждый ставит {STAKE_SIZE} своих асыков. Кон — общий.</p>
      <div className="stake-row" aria-hidden="true">
        {Array.from({ length: STAKE_SIZE }, (_, i) => (
          <AsykIcon key={i} size={36} rotate={((i * 37) % 11) - 5} />
        ))}
      </div>
      <ul className="stake-rules">
        {RULES.map(([title, text]) => (
          <li key={title}>
            <b>{title}</b> <span>{text}</span>
          </li>
        ))}
      </ul>
      <p className={`stake-free${enough ? '' : ' stake-free--low'}`} role="status">
        {free === null ? 'Считаем твои асыки…' : enough ? `Свободных у тебя: ${free}` : `У тебя ${free}, нужно ${STAKE_SIZE}`}
      </p>
      {error && (
        <p className="setup__hint code-hint code-hint--error" role="alert">
          {error}
        </p>
      )}
      <div className="result-actions">
        <button className="btn btn--primary" onClick={onConfirm} disabled={busy || !enough} data-autofocus>
          {busy ? 'Ставим…' : `Поставить ${STAKE_SIZE}`}
        </button>
        <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}
