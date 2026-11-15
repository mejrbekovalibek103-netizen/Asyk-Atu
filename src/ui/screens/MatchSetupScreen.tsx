import { lazy, Suspense, useEffect, useState } from 'react';
import { PLAYER_STYLE, throwsPerPlayer } from '../../game/rules/MatchRules';
import type { MatchConfig, Seat } from '../../game/types';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { LayoutPicker } from '../components/LayoutPicker';
import { onlineAvailable } from '../../net/config';
import { formatRoomCode, parseRoomCodeInput, ROOM_CODE_LENGTH } from '../../net/protocol';
import { STAKE_SIZE } from '../../net/collection';
import { cleanName, NAME_MAX } from '../format';
import type { CompEntry } from './CompetitiveLobbyScreen';

// узнать, вошёл ли игрок через Google и сколько у него свободных асыков: модуль режима грузится отдельно,
// вместе с Supabase, — основной файл игры от этого не растёт
const CompAccountProbe = lazy(() => import('./CompetitiveLobbyScreen').then((m) => ({ default: m.CompAccountProbe })));

interface Props {
  /** Какой это экран: «Игра вдвоём» (одно устройство) или «Онлайн игра». */
  mode: Mode;
  initialNames: [string, string];
  initialOnlineName: string;
  initialLayoutId: string;
  initialHandoff: boolean;
  onStart: (config: MatchConfig) => void;
  /** Онлайн: создать комнату и получить код и ссылку для друга. */
  onCreateRoom: (name: string, layoutId: string) => void;
  /** Онлайн: войти в чужую комнату по коду. */
  onJoinRoom: (name: string, code: string) => void;
  /** Онлайн: открыть «Мою коллекцию» (вход через Google и асыки игрока). */
  onCollection: () => void;
  /** Онлайн: соревновательный режим «на асыки» (#/comp). */
  onCompetitive: () => void;
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

// онлайн-часть игры подгружается заранее, пока игрок вводит имя
const preloadRoom = () => void import('./RoomScreen');

export function MatchSetupScreen({ mode, initialNames, initialOnlineName, initialLayoutId, initialHandoff, onStart, onCreateRoom, onJoinRoom, onCollection, onCompetitive, onBack }: Props) {
  const [names, setNames] = useState<[string, string]>(initialNames);
  const [onlineName, setOnlineName] = useState(initialOnlineName || initialNames[0]);
  const [layoutId, setLayoutId] = useState(initialLayoutId);
  const [handoff, setHandoff] = useState(initialHandoff);
  const online = mode === 'online' && onlineAvailable;
  const [action, setAction] = useState<OnlineAction>('create');
  const [comp, setComp] = useState<CompEntry>({ kind: 'loading' });
  const [compBusy, setCompBusy] = useState(false);
  useEffect(() => {
    if (online) preloadRoom();
  }, [online]);
  const [codeInput, setCodeInput] = useState('');
  const joining = online && action === 'join';
  const roomCode = parseRoomCodeInput(codeInput);
  const hint = codeHint(codeInput, roomCode);

  // «Соревновательная»: без входа — на вход через Google (вернёмся на #/comp), мало асыков — кнопка серая
  const compLow = comp.kind === 'ready' && comp.free < STAKE_SIZE && !comp.inMatch;
  const compNote =
    comp.kind === 'signedOut'
      ? compBusy
        ? 'открываем Google…'
        : 'вход через Google'
      : comp.kind === 'ready'
        ? comp.inMatch
          ? 'ты в матче'
          : compLow
            ? `У тебя ${comp.free}, нужно ${STAKE_SIZE}`
            : 'на асыки'
        : 'на асыки';
  const openComp = () => {
    if (compLow || compBusy) return;
    if (comp.kind !== 'signedOut') {
      onCompetitive();
      return;
    }
    setCompBusy(true);
    void import('./CompetitiveLobbyScreen')
      .then((m) => m.compSignIn())
      .then((ok) => {
        if (!ok) setCompBusy(false);
      })
      .catch(() => setCompBusy(false));
  };

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
        <h1 className="doc__title">{online ? 'Онлайн игра' : 'Игра вдвоём'}</h1>
        <p className="doc__lead">
          {online
            ? 'Каждый играет на своём телефоне или компьютере, за столом от двух до четырёх игроков: создай комнату и отправь друзьям код или ссылку — или введи код друга.'
            : 'Два игрока на одном устройстве — передавайте телефон или мышь по очереди.'}
        </p>

        {online && (
          <div className="mode-switch" role="group" aria-label="Режим онлайн-игры">
            <span className="mode-switch__option mode-switch__option--on" aria-current="true">
              <Icon name="globe" /> Обычная игра
            </span>
            {/* соревновательный режим: игроки ставят в кон по 5 своих асыков и забирают выбитые */}
            <button
              type="button"
              className={`mode-switch__option mode-switch__option--comp${compLow ? ' mode-switch__option--soon' : ''}`}
              onClick={openComp}
              aria-disabled={compLow || compBusy}
              title="Ставите в кон по 5 своих асыков, выбитые забирает тот, кто выбил"
            >
              <span>
                Соревновательная <small>{compNote}</small>
              </span>
            </button>
            <Suspense fallback={null}>
              <CompAccountProbe onChange={setComp} />
            </Suspense>
          </div>
        )}

        {online && (
          <button type="button" className="btn btn--block collection-link" onClick={onCollection}>
            <AsykIcon size={26} /> Моя коллекция асыков
          </button>
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
              <b>Кон пуст — матч окончен.</b> Побеждает тот, кто выбил больше асыков. Лимит — по {throwsPerPlayer(2)} бросков на каждого
              {online ? ` (у троих и четверых — по ${throwsPerPlayer(3)})` : ''}.
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
            {/* на одном устройстве играют двое; онлайн число игроков ещё неизвестно — показываем, как кон растёт */}
            <LayoutPicker value={layoutId} onChange={setLayoutId} players={online ? undefined : 2} growth={online} />
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
