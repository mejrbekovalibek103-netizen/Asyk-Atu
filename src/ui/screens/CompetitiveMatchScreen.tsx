import { useEffect, useRef, useState } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine } from '../../game/engine/GameEngine';
import { compLayout, CompetitiveRules, parseCompState as parseCompView, type CompView } from '../../game/rules/CompetitiveRules';
import { PLAYER_STYLE } from '../../game/rules/MatchRules';
import type { MatchHud, Seat } from '../../game/types';
import { CompError, compErrorText, isCompOver, skipPlan, turnSecondsLeft, type CompMatchView, type CompState } from '../../net/competitive';
import { AsykIcon } from '../components/AsykIcon';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { compStateToJson } from '../game/compAdapter';
import { PowerMeter, RotateHint, Toast } from '../game/GameOverlays';
import { TurnBanner } from '../game/MatchParts';
import { useGameEngine } from '../game/useGameEngine';
import { CompResultOverlay } from './CompResultOverlay';
import { markRematchIntent } from '../game/rematchIntent';

interface Props {
  /** Последнее состояние матча из базы (useCompMatch). */
  state: CompState;
  /** Действия и связь (useCompMatch): бросок, сдача, запись бросков, прицел. */
  match: CompMatchView;
  muted: boolean;
  reducedMotion: boolean;
  onToggleMute: () => void;
  onCollection: () => void;
  onMenu: () => void;
  /** Перейти в лобби другого матча (реванш) по коду. */
  onOpenMatch: (code: string) => void;
}

/** Текст отказа сервера для игрока; «режим не настроен» — понятнее для игрока. */
export function compText(e: unknown): string {
  if (e instanceof CompError && e.code === 'setup') return 'Соревновательный режим временно недоступен.';
  return compErrorText(e);
}

/**
 * Матч на асыки: бросок считает сервер. Экран только показывает запись броска (свою и чужую), кон и счёт
 * из базы и отправляет прицел. Состояние в движок приходит каждые 5 с и по сигналу из базы.
 */
export function CompetitiveMatchScreen(props: Props) {
  // состояние на момент открытия экрана: по нему движок сразу ставит кон и счёт (в том числе после перезагрузки)
  const [boot] = useState(() => {
    const raw = compStateToJson(props.state);
    return { raw, view: parseCompView(raw) };
  });
  if (!boot.view) {
    return (
      <main className="page page--doc">
        <div className="doc">
          <h1 className="doc__title">Матч не открыть</h1>
          <p className="doc__lead">Сервер прислал непонятное состояние матча. Обнови страницу.</p>
          <div className="doc__actions">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              <Icon name="restart" /> Обновить
            </button>
            <button className="btn btn--ghost" onClick={props.onMenu}>
              <Icon name="home" /> В меню
            </button>
          </div>
        </div>
      </main>
    );
  }
  return <CompGame {...props} bootRaw={boot.raw} bootView={boot.view} />;
}

/** Секунды до момента (местное время), не меньше 0. */
const secondsTo = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000));

function CompGame(props: Props & { bootRaw: unknown; bootView: CompView }) {
  const { state, match, muted, bootView } = props;
  const layout = compLayout(bootView);
  const n = bootView.players;
  const [done, setDone] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(match.actions);
  actionsRef.current = match.actions;

  const view = useGameEngine(
    (canvas) =>
      new GameEngine(
        canvas,
        {
          layout,
          rules: new CompetitiveRules(bootView, () => setDone(true)),
          tutorial: false,
          reducedMotion: props.reducedMotion,
          authority: 'server',
          // запись своего броска приходит в onThrow (из ответа функции и из канала, без повторов)
          requestThrow: async (req) => {
            const st = stateRef.current;
            if (st.match.throwNo + 1 !== req.throwNo) throw new CompError('stale_throw');
            await actionsRef.current.throwAsyk(req.angle, req.power);
            return null;
          },
          serverState: props.bootRaw,
          ownerMarks: true,
        },
        {
          onPauseRequest: () => setMenuOpen((m) => !m),
          net: {
            onAim: (a) => actionsRef.current.sendAim(a),
            onThrowStart: () => undefined,
            onThrowChunk: () => undefined,
            onThrowEnd: () => undefined,
          },
          onServerThrowError: (e) => {
            // «не твой ход», «время вышло» и т. п. — движок уже вернул сақа в руку; поясняем причину
            if (e instanceof CompError) setNotice(compText(e));
            void actionsRef.current.refresh();
          },
        },
      ),
    bootView.matchId,
  );
  const { engine, snap: s, canvasRef } = view;
  const m: MatchHud | null = s?.mode.kind === 'match' ? s.mode : null;

  // запись броска от сервера → движок (порядок частей и повторы движок разбирает сам)
  useEffect(() => {
    if (!engine) return;
    return match.actions.onThrow((ev) => {
      if (ev.k === 'start') engine.pushServerThrow(ev.throwNo, { start: ev.start });
      else if (ev.k === 'chunk') engine.pushServerThrow(ev.throwNo, { chunks: [ev.chunk] });
      else engine.pushServerThrow(ev.throwNo, { end: ev.end });
    });
  }, [engine, match.actions]);

  // прицел соперника — только картинка, и только для текущего броска
  useEffect(() => {
    if (!engine) return;
    return match.actions.onAim((aim, throwNo) => {
      if (throwNo !== null && throwNo !== stateRef.current.match.throwNo + 1) return;
      engine.setRemoteAim(aim);
    });
  }, [engine, match.actions]);

  // каждое новое состояние базы — в движок: кон, счёт, чей ход, конец матча
  useEffect(() => {
    if (engine) engine.applyCanonical(compStateToJson(state));
  }, [engine, state]);

  // итоги: движок сообщает о конце матча; если он почему-то промолчал — показываем итоги сами
  const over = isCompOver(state.match.status);
  useEffect(() => {
    if (!over || done) return;
    const t = window.setTimeout(() => setDone(true), 4000);
    return () => window.clearTimeout(t);
  }, [over, done]);

  // онлайн не ставится на паузу, кроме окна итогов
  useEffect(() => {
    engine?.setPaused(done);
  }, [engine, done]);

  // таймер хода и обратный отсчёт до пропуска
  useEffect(() => {
    if (over) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 500);
    return () => window.clearInterval(t);
  }, [over]);

  // пояснение к отказу — несколько секунд
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const forfeit = async () => {
    sound.uiClick();
    setForfeiting(true);
    try {
      await match.actions.forfeit();
      setConfirmForfeit(false);
      setMenuOpen(false);
    } catch (e) {
      setNotice(compText(e));
    } finally {
      setForfeiting(false);
    }
  };

  const now = Date.now();
  const bySeat = (seat: number) => state.players.find((p) => p.seat === seat);
  const mySeat = state.me.seat;
  const current = state.match.currentSeat;
  const curPlayer = current === null ? undefined : bySeat(current);
  const left = turnSecondsLeft(state, now);
  const name = (seat: number | null) => (seat === null ? '' : (bySeat(seat)?.name ?? 'Соперник'));
  const offline = (seat: number) => seat !== mySeat && bySeat(seat)?.online === false;
  const plan = skipPlan(state);
  const pending = !!s?.throwPending || match.throwing;

  let statusText: string | null = null;
  let warn = false;
  if (!over) {
    if (match.outdated) {
      statusText = 'Игра обновилась — обнови страницу';
      warn = true;
    } else if (pending) {
      statusText = 'Бросок…';
    } else if (notice) {
      statusText = notice;
      warn = true;
    } else if (match.connection === 'reconnecting' || match.connection === 'closed') {
      statusText = 'Связь восстанавливается…';
      warn = true;
    } else if (match.warning) {
      statusText = 'Нет связи с сервером — пробуем снова…';
      warn = true;
    } else if (state.me.forfeited) {
      statusText = 'Ты сдался — твои асыки остались в коне';
    } else if (curPlayer && !curPlayer.isMe && curPlayer.forfeited) {
      statusText = `${curPlayer.name} сдался — ход пропустим`;
      warn = true;
    } else if (current !== null && offline(current)) {
      const wait = plan ? secondsTo(plan.at, now) : null;
      statusText = `${name(current)} не в сети — ход пропустим${wait ? ` через ${wait} с` : ''}`;
      warn = true;
    } else if (s?.netWaiting) {
      statusText = 'Ждём запись броска…';
    } else if (s?.remoteAiming && current !== null) {
      statusText = `${name(current)} целится…`;
    } else if (current !== null && current === mySeat && left !== null && left <= 10) {
      statusText = `Осталось ${left} с — бросай!`;
      warn = true;
    }
  }

  const seats = Array.from({ length: n }, (_, i) => i as Seat);

  return (
    <div className="game" ref={view.containerRef}>
      <canvas
        ref={canvasRef}
        className="game__canvas"
        tabIndex={0}
        aria-label={`Матч на асыки, кон «${layout.name}». В свой ход зажми сақа в руке внизу, тяни к асыкам и отпусти. Бросок считает сервер.`}
      />

      <header className="hud" ref={view.hudRef}>
        <div className="hud__bar">
          <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Меню матча">
            <Icon name="pause" />
          </button>
          <div className="hud__level">
            <span className="hud__level-name">На асыки · {layout.name}</span>
            <span className="hud__goal">{m ? `В коне ${m.asyksLeft} из ${m.totalAsyks} · бросок ${Math.min(m.totalThrows + 1, m.maxThrows)}/${m.maxThrows}` : ''}</span>
          </div>
          <div className={`hud__stats hud__stats--match hud__stats--p${n}`}>
            {seats.map((seat) => {
              const p = bySeat(seat);
              const hp = m?.players[seat];
              const active = !over && current === seat;
              const me = seat === mySeat;
              const off = offline(seat);
              const badge = p?.forfeited ? 'сдался' : off ? 'не в сети' : 'бросает';
              return (
                <div
                  key={seat}
                  className={`player-card comp-card${active ? ' player-card--active' : ''}${off || p?.forfeited ? ' player-card--offline' : ''}`}
                  style={{ '--player': PLAYER_STYLE[seat].color } as React.CSSProperties}
                  aria-label={`${hp?.name ?? ''}${me ? ' (ты)' : ''}: выбито ${hp?.knocked ?? 0}, бросков ${hp?.throws ?? 0} из ${state.match.throwsPerPlayer}${active ? `, сейчас ход${left !== null ? `, осталось ${left} с` : ''}` : ''}${off ? ', не в сети' : ''}${p?.forfeited ? ', сдался' : ''}`}
                >
                  <AsykIcon palette={PLAYER_STYLE[seat].palette} size={20} />
                  <span className="comp-card__info">
                    <span className="player-card__name">
                      {hp?.name}
                      {me && <small className="player-card__me"> · ты</small>}
                    </span>
                    <small className="comp-card__throws">
                      броски {Math.min(hp?.throws ?? 0, state.match.throwsPerPlayer)}/{state.match.throwsPerPlayer}
                    </small>
                  </span>
                  <b className="player-card__score bump" key={hp?.knocked}>
                    {hp?.knocked ?? 0}
                  </b>
                  {(active || p?.forfeited || off) && (
                    <span className="player-card__turn">
                      {badge}
                      {active && left !== null && !p?.forfeited ? ` · ${left} с` : ''}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="hud__actions">
            <button className="icon-btn" onClick={props.onToggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'} aria-pressed={muted}>
              <Icon name={muted ? 'mute' : 'sound'} />
            </button>
          </div>
        </div>
      </header>

      <Toast message={s?.message ?? null} top={view.size.top} />
      {statusText && !done && (
        <div className={`net-status${warn ? ' net-status--warn' : ''}${pending ? ' net-status--busy' : ''}`} style={{ top: view.size.top + 52 }} role="status">
          {statusText}
        </div>
      )}
      {m && !done && !over && <TurnBanner hud={m} y={view.w2s(0, 720).y} />}
      <div className="sr-only" aria-live="polite">
        {m && !over ? (m.current === mySeat ? 'Твой ход.' : `Ходит ${name(m.current)}.`) + ` Счёт: ${m.players.map((p) => `${p.name} ${p.knocked}`).join(', ')}.` : ''}
      </div>

      <PowerMeter view={view} power={s?.aiming ? s.power : 0} aiming={!!s?.aiming} />
      <RotateHint view={view} hidden={done} />

      {menuOpen && !done && !confirmForfeit && (
        <Modal labelledBy="comp-menu-title" onClose={() => setMenuOpen(false)} className="modal--pause">
          <h2 id="comp-menu-title" className="modal__title">
            Матч на асыки
          </h2>
          <p className="modal__text">Пауза матч не останавливает: на ход даётся {state.match.turnSeconds} с, потом ход пропускается.</p>
          <div className="stack">
            <button className="btn btn--primary btn--block" onClick={() => setMenuOpen(false)} data-autofocus>
              <Icon name="play" /> Вернуться к игре
            </button>
            <button className="btn btn--block btn--ghost" onClick={props.onToggleMute} aria-pressed={muted}>
              <Icon name={muted ? 'mute' : 'sound'} /> {muted ? 'Звук выключен' : 'Звук включён'}
            </button>
            {!state.me.forfeited && !over && (
              <button className="btn btn--block btn--ghost btn--danger" onClick={() => setConfirmForfeit(true)}>
                Сдаться
              </button>
            )}
            <button className="btn btn--block btn--ghost" onClick={props.onMenu}>
              <Icon name="home" /> В меню{!state.me.forfeited && !over ? ' (матч продолжится)' : ''}
            </button>
          </div>
        </Modal>
      )}

      {confirmForfeit && !done && (
        <Modal labelledBy="comp-forfeit-title" onClose={forfeiting ? undefined : () => setConfirmForfeit(false)} className="modal--pause">
          <h2 id="comp-forfeit-title" className="modal__title">
            Сдаться?
          </h2>
          <p className="modal__text">
            Бросать ты больше не сможешь. Твои асыки останутся в коне — соперник может их выбить. Невыбитые вернутся к тебе после матча.
          </p>
          <div className="stack">
            <button className="btn btn--primary btn--block" onClick={() => setConfirmForfeit(false)} disabled={forfeiting} data-autofocus>
              Играть дальше
            </button>
            <button className="btn btn--block btn--danger-solid" onClick={forfeit} disabled={forfeiting}>
              {forfeiting ? 'Сдаёмся…' : 'Да, сдаться'}
            </button>
          </div>
        </Modal>
      )}

      {done && (
        <CompResultOverlay
          state={state}
          errorText={compText}
          onRematch={async (kind) => {
            const r = await match.actions.rematch();
            if (kind === 'rematch') markRematchIntent(r.joinCode);
            props.onOpenMatch(r.joinCode);
          }}
          onCollection={props.onCollection}
          onMenu={props.onMenu}
        />
      )}
    </div>
  );
}
