import { useState } from 'react';
import { MATCH_LAYOUTS } from '../../game/levels/matchLayouts';
import { MATCH_MAX_THROWS, PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchConfig, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { cleanName, NAME_MAX } from '../format';

interface Props {
  initialNames: [string, string];
  initialLayoutId: string;
  onStart: (config: MatchConfig) => void;
  onBack: () => void;
}

export function MatchSetupScreen({ initialNames, initialLayoutId, onStart, onBack }: Props) {
  const [names, setNames] = useState<[string, string]>(initialNames);
  const [layoutId, setLayoutId] = useState(initialLayoutId);

  const start = () => {
    const players: [string, string] = [cleanName(names[0], 'Игрок 1'), cleanName(names[1], 'Игрок 2')];
    if (players[0] === players[1]) players[1] = `${players[1]} 2`;
    // жеребьёвка: кто бросает первым
    const first: Seat = Math.random() < 0.5 ? 0 : 1;
    onStart({ layoutId, players, first });
  };

  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> Назад
        </button>
        <h1 className="doc__title">Игра вдвоём</h1>
        <p className="doc__lead">Два игрока на одном устройстве — передавайте телефон или мышь по очереди.</p>

        <section className="rules-card" aria-label="Правила матча">
          <div className="rules-card__item">
            <span className="rules-card__num">1</span>
            <p>
              <b>Выбил асык — бросаешь ещё.</b> Промахнулся — ход переходит сопернику.
            </p>
          </div>
          <div className="rules-card__item">
            <span className="rules-card__num">2</span>
            <p>
              <b>Кон общий.</b> Асыки, которые сдвинул соперник, остаются там, где остановились.
            </p>
          </div>
          <div className="rules-card__item">
            <span className="rules-card__num">3</span>
            <p>
              <b>Кон пуст — матч окончен.</b> Побеждает тот, кто выбил больше асыков. Лимит — {MATCH_MAX_THROWS} бросков на двоих.
            </p>
          </div>
        </section>

        <form
          className="setup"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <fieldset className="setup__group">
            <legend>Игроки</legend>
            <div className="setup__players">
              {([0, 1] as Seat[]).map((seat) => (
                <label key={seat} className="name-field" style={{ '--player': PLAYER_STYLE[seat].color } as React.CSSProperties}>
                  <AsykIcon palette={PLAYER_STYLE[seat].palette} size={30} />
                  <span className="sr-only">Имя игрока {seat + 1}</span>
                  <input
                    type="text"
                    value={names[seat]}
                    maxLength={NAME_MAX}
                    placeholder={`Игрок ${seat + 1}`}
                    autoComplete="off"
                    enterKeyHint="next"
                    onChange={(e) => {
                      const next = [...names] as [string, string];
                      next[seat] = e.target.value;
                      setNames(next);
                    }}
                  />
                </label>
              ))}
            </div>
            <p className="setup__hint">У каждого свой крашеный сақа: красный и фиолетовый.</p>
          </fieldset>

          <fieldset className="setup__group">
            <legend>Кон</legend>
            <div className="layout-picker" role="radiogroup" aria-label="Расстановка асыков">
              {MATCH_LAYOUTS.map((l) => (
                <label key={l.id} className={`layout-option${layoutId === l.id ? ' layout-option--on' : ''}`}>
                  <input type="radio" name="layout" value={l.id} checked={layoutId === l.id} onChange={() => setLayoutId(l.id)} className="sr-only" />
                  <span className="layout-option__preview">
                    <LevelPreview level={l} />
                  </span>
                  <span className="layout-option__body">
                    <b>
                      {l.name} <small>{l.kazName}</small>
                    </b>
                    <span>{l.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <button type="submit" className="btn btn--primary btn--xl btn--block">
            <Icon name="dice" /> Бросить жребий и начать
          </button>
        </form>
      </div>
    </main>
  );
}
