import { useState } from 'react';
import { LEVELS } from '../../game/levels/levels';
import type { SaveData } from '../../storage/progress';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Stars } from '../components/Stars';
import type { Route } from '../routes';

interface Props {
  save: SaveData;
  onReset: () => void;
  onNavigate: (r: Route) => void;
  onBack: () => void;
}

export function RecordsScreen({ save, onReset, onNavigate, onBack }: Props) {
  const [confirm, setConfirm] = useState(false);
  const st = save.stats;
  const accuracy = st.throws > 0 ? Math.round((st.hitThrows / st.throws) * 100) : 0;
  const empty = st.roundsPlayed === 0;

  const tiles = [
    { label: 'Лучший результат', value: st.bestScore, hint: 'очков за раунд' },
    { label: 'Максимум выбито', value: st.bestKnocked, hint: 'асыков за раунд' },
    { label: 'Лучшее комбо', value: st.bestCombo >= 2 ? `×${st.bestCombo}` : '—', hint: 'асыков одним броском' },
    { label: 'Точность', value: st.throws ? `${accuracy}%` : '—', hint: 'бросков с попаданием' },
    { label: 'Сыграно раундов', value: st.roundsPlayed, hint: `бросков: ${st.throws}` },
    { label: 'Всего выбито', value: st.asyksKnocked, hint: 'асыков' },
  ];

  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> Назад
        </button>
        <h1 className="doc__title">Рекорды</h1>
        <p className="doc__lead">Личная статистика. Хранится только в этом браузере на этом устройстве — это не глобальный рейтинг.</p>

        {empty ? (
          <div className="empty">
            <p>Здесь появятся твои результаты после первого раунда.</p>
            <button className="btn btn--primary" onClick={() => onNavigate({ name: 'LEVEL_SELECT' })}>
              <Icon name="play" /> Сыграть первый раунд
            </button>
          </div>
        ) : (
          <>
            <div className="tiles">
              {tiles.map((t) => (
                <div key={t.label} className="tile">
                  <span className="tile__label">{t.label}</span>
                  <span className="tile__value">{t.value}</span>
                  <span className="tile__hint">{t.hint}</span>
                </div>
              ))}
            </div>

            <section className="doc__section">
              <h2>По испытаниям</h2>
              <table className="records-table">
                <thead>
                  <tr>
                    <th scope="col">Испытание</th>
                    <th scope="col">Рекорд</th>
                    <th scope="col">Выбито</th>
                    <th scope="col">Звёзды</th>
                  </tr>
                </thead>
                <tbody>
                  {LEVELS.map((l) => {
                    const p = save.levels[l.id];
                    return (
                      <tr key={l.id}>
                        <th scope="row">
                          {l.order}. {l.name}
                        </th>
                        <td>{p ? p.bestScore : '—'}</td>
                        <td>{p ? `${p.bestKnocked}/${l.asyks.length}` : '—'}</td>
                        <td>
                          <Stars value={p?.stars ?? 0} size={16} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <div className="doc__actions doc__actions--split">
              <button className="btn btn--primary" onClick={() => onNavigate({ name: 'LEVEL_SELECT' })}>
                <Icon name="play" /> Улучшить результат
              </button>
              <button className="btn btn--ghost btn--danger" onClick={() => setConfirm(true)}>
                Сбросить прогресс
              </button>
            </div>
          </>
        )}
      </div>

      {confirm && (
        <Modal labelledBy="reset-title" onClose={() => setConfirm(false)}>
          <h2 id="reset-title" className="modal__title">
            Сбросить прогресс?
          </h2>
          <p className="modal__text">Рекорды, звёзды и открытые испытания будут удалены с этого устройства.</p>
          <div className="stack">
            <button className="btn btn--block" onClick={() => setConfirm(false)} data-autofocus>
              Отмена
            </button>
            <button
              className="btn btn--block btn--danger-solid"
              onClick={() => {
                onReset();
                setConfirm(false);
              }}
            >
              Да, сбросить
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
