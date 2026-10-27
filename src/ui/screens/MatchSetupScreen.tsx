import { useState } from 'react';
import { MATCH_LAYOUTS } from '../../game/levels/matchLayouts';
import { PLAYER_STYLE, throwsPerPlayer } from '../../game/rules/MatchRules';
import type { MatchConfig, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { onlineAvailable } from '../../net/config';
import { formatRoomCode, parseRoomCodeInput, ROOM_CODE_LENGTH } from '../../net/protocol';
import { cleanName, NAME_MAX } from '../format';

interface Props {
  initialNames: [string, string];
  initialOnlineName: string;
  initialLayoutId: string;
  initialHandoff: boolean;
  onStart: (config: MatchConfig) => void;
  /** Онлайн: создать комнату и получить код и ссылку для друга. */
  onCreateRoom: (name: string, layoutId: string) => void;
  /** Онлайн: войти в чужую комнату по коду. */
  onJoinRoom: (name: string, code: string) => void;
  onBack: () => void;
}

type Mode = 'local' | 'online';
type OnlineAction = 'create' | 'join';

/** Подсказка под полем кода: сколько символов введено и что делать дальше. */
function codeHint(input: string, code: string | null): { text: string; tone: 'idle' | 'ok' | 'error' } {
  if (code) return { text: `Комната ${formatRoomCode(code)}`, tone: 'ok' };
  const typed = input.replace(/[^A-Za-z0-9]/g, '').length;
  if (typed === 0) return { text: `Код — ${ROOM_CODE_LENGTH} символов, его покажет друг в своей комнате`, tone: 'idle' };
  if (typed < ROOM_CODE_LENGTH) return { text: `Введено ${typed} из ${ROOM_CODE_LENGTH}`, tone: 'idle' };
  return { text: 'Не похоже на код комнаты: нужны буквы и цифры, без 0, O, 1, I, L', tone: 'error' };
}

/** Пока вводят сам код, показываем его в виде ABCDE-FGHJK; вставленную ссылку или фразу не трогаем. */
function formatTyped(raw: string): string {
  if (raw.length > 12 || /[/:]/.test(raw)) return raw;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length > ROOM_CODE_LENGTH) return raw;
  const half = ROOM_CODE_LENGTH / 2;
  return clean.length > half ? `${clean.slice(0, half)}-${clean.slice(half)}` : clean;
}

export function MatchSetupScreen({ initialNames, initialOnlineName, initialLayoutId, initialHandoff, onStart, onCreateRoom, onJoinRoom, onBack }: Props) {
  const [names, setNames] = useState<[string, string]>(initialNames);
  const [onlineName, setOnlineName] = useState(initialOnlineName || initialNames[0]);
  const [layoutId, setLayoutId] = useState(initialLayoutId);
  const [handoff, setHandoff] = useState(initialHandoff);
  const [mode, setMode] = useState<Mode>('local');
  const online = mode === 'online';
  const [action, setAction] = useState<OnlineAction>('create');
  const [codeInput, setCodeInput] = useState('');
  const joining = online && action === 'join';
  const roomCode = parseRoomCodeInput(codeInput);
  const hint = codeHint(codeInput, roomCode);

  const start = () => {
    const players: [string, string] = [cleanName(names[0], 'Игрок 1'), cleanName(names[1], 'Игрок 2')];
    if (players[0] === players[1]) players[1] = `${players[1]} 2`;
    // жеребьёвка: кто бросает первым
    const first: Seat = Math.random() < 0.5 ? 0 : 1;
    onStart({ layoutId, players, first, handoff });
  };

  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onBack}>
          <Icon name="back" /> Назад
        </button>
        <h1 className="doc__title">Игра вдвоём</h1>
        <p className="doc__lead">
          {online
            ? 'Каждый играет на своём телефоне или компьютере, за столом до четырёх игроков: создай комнату и отправь друзьям код или ссылку — или введи код друга.'
            : 'Два игрока на одном устройстве — передавайте телефон или мышь по очереди.'}
        </p>

        {onlineAvailable && (
          <div className="mode-switch" role="radiogroup" aria-label="Где играем">
            {(
              [
                ['local', 'На одном устройстве'],
                ['online', 'Онлайн по коду'],
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

        {online && (
          <div className="mode-switch mode-switch--sub" role="radiogroup" aria-label="Создать комнату или войти по коду">
            {(
              [
                ['create', 'Создать комнату'],
                ['join', 'Войти по коду'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={`mode-switch__option${action === value ? ' mode-switch__option--on' : ''}`}>
                <input type="radio" name="online-action" value={value} checked={action === value} onChange={() => setAction(value)} className="sr-only" />
                {label}
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
              <b>Кон пуст — матч окончен.</b> Побеждает тот, кто выбил больше асыков. Лимит — по {throwsPerPlayer(2)} бросков на каждого.
            </p>
          </div>
        </section>

        <form
          className="setup"
          onSubmit={(e) => {
            e.preventDefault();
            if (joining) {
              if (roomCode) onJoinRoom(cleanName(onlineName, 'Игрок 2'), roomCode);
            } else if (online) onCreateRoom(cleanName(onlineName, 'Игрок 1'), layoutId);
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
              <p className="setup__hint">
                {joining ? 'Это имя увидит хозяин комнаты.' : 'Ты создаёшь комнату и выбираешь кон. Друг войдёт по коду или по ссылке и введёт своё имя.'}
              </p>
            </fieldset>
          ) : (
          <fieldset className="setup__group">
            <legend>Игроки</legend>
            <div className="setup__players">
              {([0, 1] as const).map((seat) => (
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
            <label className="check-row">
              <input type="checkbox" checked={handoff} onChange={(e) => setHandoff(e.target.checked)} />
              <span>
                <b>Экран «Передайте устройство»</b>
                <small>Перед каждым ходом игра ждёт кнопку «Готов»: предыдущий игрок не бросит второй раз по ошибке.</small>
              </span>
            </label>
          </fieldset>
          )}

          {joining && (
            <fieldset className="setup__group">
              <legend>Код комнаты</legend>
              <label className="name-field code-field" style={{ '--player': '#8b5cf6' } as React.CSSProperties}>
                <Icon name="globe" size={24} />
                <span className="sr-only">Код комнаты</span>
                <input
                  type="text"
                  value={codeInput}
                  maxLength={300}
                  placeholder="ABCDE-FGHJK"
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="text"
                  enterKeyHint="go"
                  aria-invalid={hint.tone === 'error'}
                  aria-describedby="code-hint"
                  onChange={(e) => setCodeInput(formatTyped(e.target.value))}
                />
              </label>
              <p id="code-hint" className={`setup__hint code-hint code-hint--${hint.tone}`} role="status">
                {hint.text}
              </p>
              <p className="setup__hint">Можно вставить и всю ссылку на комнату — код найдётся сам.</p>
            </fieldset>
          )}

          {!joining && (
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
          )}

          <button type="submit" className="btn btn--primary btn--xl btn--block" disabled={joining && !roomCode}>
            {joining ? (
              <>
                <Icon name="globe" /> Войти в комнату
              </>
            ) : online ? (
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
