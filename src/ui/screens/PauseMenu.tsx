import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';

interface Props {
  muted: boolean;
  onResume: () => void;
  onRestart: () => void;
  onToggleMute: () => void;
  onLevels: () => void;
  onHowTo: () => void;
  onHome: () => void;
}

export function PauseMenu(p: Props) {
  return (
    <Modal labelledBy="pause-title" onClose={p.onResume} className="modal--pause">
      <h2 id="pause-title" className="modal__title">
        Пауза
      </h2>
      <p className="modal__text">Физика остановлена. Асыки подождут.</p>
      <div className="stack">
        <button className="btn btn--primary btn--block" onClick={p.onResume} data-autofocus>
          <Icon name="play" /> Продолжить
        </button>
        <button className="btn btn--block" onClick={p.onRestart}>
          <Icon name="restart" /> Начать заново
        </button>
        <button className="btn btn--block" onClick={p.onLevels}>
          <Icon name="grid" /> Испытания
        </button>
        <button className="btn btn--block" onClick={p.onHowTo}>
          <Icon name="help" /> Как играть
        </button>
        <button className="btn btn--block btn--ghost" onClick={p.onHome}>
          <Icon name="home" /> Главное меню
        </button>
        <button className="btn btn--block btn--ghost" onClick={p.onToggleMute} aria-pressed={p.muted}>
          <Icon name={p.muted ? 'mute' : 'sound'} /> {p.muted ? 'Звук выключен' : 'Звук включён'}
        </button>
      </div>
    </Modal>
  );
}
