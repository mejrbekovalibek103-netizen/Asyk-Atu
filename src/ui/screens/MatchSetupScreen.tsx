import { useState } from 'react';
import { MATCH_LAYOUTS } from '../../game/levels/matchLayouts';
import { MATCH_MAX_THROWS, PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchConfig, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { onlineAvailable } from '../../net/config';
import { cleanName, NAME_MAX } from '../format';

interface Props {
  initialNames: [string, string];
  initialOnlineName: string;
  initialLayoutId: string;
  onStart: (config: MatchConfig) => void;
  /** Онлайн: создать комнату и получить ссылку для друга. */
  onCreateRoom: (name: string, layoutId: string) => void;
  onBack: () => void;
}

type Mode = 'local' | 'online';

export function MatchSetupScreen({ initialNames, initialOnlineName, initialLayoutId, onStart, onCreateRoom, onBack }: Props) {
  const [names, setNames] = useState<[string, string]>(initialNames);
  const [onlineName, setOnlineName] = useState(initialOnlineName || initialNames[0]);
  const [layoutId, setLayoutId] = useState(initialLayoutId);
  const [mode, setMode] = useState<Mode>('local');
  const online = mode === 'online';

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
        <p className="doc__lead">
          {online ? 'Каждый играет на своём телефоне или компьютере — создай комнату и отправь ссылку другу.' : 'Два игрока на одном устройстве — передавайте телефон или мышь по очереди.'}
        </p>

        {onlineAvailable && (
          <div className="mode-switch" role="radiogroup" aria-label="Где играем">
            {(
              [
                ['local', 'На одном устройстве'],
                ['online', 'Онлайн по ссылке'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={`mode-switch__option${mode === value ? ' mode-switch__option--on' : ''}`}>
                <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => {
                    setMode(value);
                    // заранее подгружаем онлайн-часть игры, пока игрок вводит имя
                    if (value === 'online') void import('./RoomScreen');
                  }}
                  className="sr-only"
                />
                <Icon name={value === 'local' ? 'users' : 'globe'} /> {label}
              </label>
            ))}
          </div>
        )}

        <section className="rules-card" aria-label="Правила матча">
          <div className="rules-card__item">
            <span className="rules-card__num">1</span>
            <p>
              <b>Строго по очереди.</b> Один бросок — и ход переходит сопернику, даже если ты попал.
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
              <b>Кон пуст — матч окончен.</b> Побеждает тот, кто выбил больше асыков. Лимит — по {MATCH_MAX_THROWS / 2} бросков на каждого.
            </p>
          </div>
        </section>

        <form
          className="setup"
          onSubmit={(e) => {
            e.preventDefault();
            if (online) onCreateRoom(cleanName(onlineName, 'Игрок 1'), layoutId);
            else start();
          }}
        >
          {online ? (
            <fieldset className="setup__group">
              <legend>Твоё имя</legend>
              <label className="name-field" style={{ '--player': PLAYER_STYLE[0].color } as React.CSSProperties}>
                <AsykIcon palette={PLAYER_STYLE[0].palette} size={30} />
                <span className="sr-only">Твоё имя</span>
                <input
                  type="text"
                  value={onlineName}
                  maxLength={NAME_MAX}
                  placeholder="Твоё имя"
                  autoComplete="nickname"
                  onChange={(e) => setOnlineName(e.target.value)}
                />
              </label>
              <p className="setup__hint">Ты создаёшь комнату и выбираешь кон. Друг войдёт по ссылке и введёт своё имя.</p>
            </fieldset>
          ) : (
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
          )}

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
            {online ? (
              <>
                <Icon name="globe" /> Создать комнату
              </>
            ) : (
              <>
                <Icon name="dice" /> Бросить жребий и начать
              </>
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
