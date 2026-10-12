import { useEffect, useRef, useState } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine, type MatchSyncState } from '../../game/engine/GameEngine';
import { getMatchLayout } from '../../game/levels/matchLayouts';
import { MatchRules } from '../../game/rules/MatchRules';
import type { MatchConfig, MatchHud, MatchResult, Seat } from '../../game/types';
import type { Room, RoomSnapshot } from '../../net/room';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { PowerMeter, RotateHint, Toast } from '../game/GameOverlays';
import { PlayerCard, TurnBanner } from '../game/MatchParts';
import { useGameEngine } from '../game/useGameEngine';
import { MatchResultOverlay } from './MatchResultOverlay';

interface Props {
  room: Room;
  roomSnap: RoomSnapshot;
  config: MatchConfig;
  matchId: number;
  localSeat: Seat;
  /** Матч восстановлен после перезагрузки — запросить состояние у соперника. */
  restored: boolean;
  /** Состояние, пришедшее вместе с матчем (вход в уже идущий матч). */
  initialSync: MatchSyncState | null;
  muted: boolean;
  reducedMotion: boolean;
  onToggleMute: () => void;
  /** Хост запускает реванш (новый матч в той же комнате). */
  onRematchStart: () => void;
  onLeave: () => void;
}

const STALL_SYNC_MS = 5000;

/** Онлайн-матч: этот экран управляет одним игроком, броски соперника приходят по сети. */
export function OnlineMatchScreen(props: Props) {
  const { room, roomSnap, config, matchId, localSeat, muted } = props;
  const layout = getMatchLayout(config.layoutId);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncing, setSyncing] = useState(props.restored && !props.initialSync);
  const [rematch, setRematch] = useState<'idle' | 'sent' | 'received'>('idle');
  const [opponentLeft, setOpponentLeft] = useState(false);
  const pendingSync = useRef(false);
  const rematchRef = useRef(rematch);
  rematchRef.current = rematch;
  const propsRef = useRef(props);
  propsRef.current = props;
  const opponentSeat: Seat = localSeat === 0 ? 1 : 0;
  const opponentName = config.players[opponentSeat];
  const isHost = localSeat === 0;

  const view = useGameEngine(
    (canvas) =>
      new GameEngine(
        canvas,
        { layout, rules: new MatchRules(config, setResult, localSeat), tutorial: false, reducedMotion: props.reducedMotion },
        {
          onPauseRequest: () => setMenuOpen((m) => !m),
          net: {
            onAim: (a) => room.send({ t: 'aim', a }),
            onThrowStart: (s) => room.send({ t: 'throwStart', s }),
            onThrowChunk: (c) => room.send({ t: 'throwChunk', c }),
            onThrowEnd: (e) => room.send({ t: 'throwEnd', e }),
          },
        },
      ),
    matchId,
  );
  const { engine, snap: s, canvasRef } = view;
  const m: MatchHud | null = s?.mode.kind === 'match' ? s.mode : null;

  // вход в уже идущий матч / восстановление после перезагрузки
  useEffect(() => {
    if (!engine) return;
    if (props.initialSync) engine.importMatchState(props.initialSync, true);
    else if (props.restored) room.send({ t: 'syncRequest' });
  }, [engine]);

  // если синхронизация не пришла — играем с тем, что есть
  useEffect(() => {
    if (!syncing) return;
    const t = window.setTimeout(() => setSyncing(false), 4000);
    return () => window.clearTimeout(t);
  }, [syncing]);

  // сообщения соперника
  useEffect(() => {
    if (!engine) return;
    return room.onMessage((msg) => {
      switch (msg.t) {
        case 'aim':
          engine.setRemoteAim(msg.a);
          break;
        case 'throwStart':
          engine.remoteThrowStart(msg.s);
          break;
        case 'throwChunk':
          engine.remoteThrowChunk(msg.c);
          break;
        case 'throwEnd':
          engine.remoteThrowEnd(msg.e);
          break;
        case 'syncRequest':
          pendingSync.current = true;
          trySendSync();
          break;
        case 'sync':
          if (msg.matchId === matchId) {
            engine.importMatchState(msg.state, true);
            setSyncing(false);
          }
          break;
        case 'rematch':
          // предложили одновременно — считаем согласием
          if (rematchRef.current === 'sent') {
            if (isHost) propsRef.current.onRematchStart();
          } else {
            setRematch('received');
          }
          break;
        case 'rematchAccept':
          if (isHost) propsRef.current.onRematchStart();
          break;
        case 'leave':
          setOpponentLeft(true);
          break;
      }
    });
  }, [engine, room, matchId]);

  /** Отправить состояние, когда этот экран между бросками (свой бросок не прерываем). */
  function trySendSync() {
    if (!engine || !pendingSync.current) return;
    const phase = engine.getSnapshot().phase;
    if (phase !== 'READY' && phase !== 'ROUND_COMPLETE') return;
    pendingSync.current = false;
    room.send({ t: 'sync', config, matchId, state: engine.exportMatchState() });
  }

  useEffect(() => {
    trySendSync();
  });

  // соперник вернулся в комнату — отправим ему актуальное состояние
  const opponentOnline = roomSnap.peers.some((p) => p.seat === opponentSeat);
  const wasOnline = useRef(opponentOnline);
  useEffect(() => {
    if (opponentOnline && !wasOnline.current) {
      pendingSync.current = true;
      setOpponentLeft(false);
      trySendSync();
    }
    wasOnline.current = opponentOnline;
  }, [opponentOnline]);

  // запись броска долго не приходит — просим полное состояние
  useEffect(() => {
    if (!s?.netWaiting) return;
    const t = window.setTimeout(() => room.send({ t: 'syncRequest' }), STALL_SYNC_MS);
    return () => window.clearTimeout(t);
  }, [s?.netWaiting, room]);

  // в онлайне движок не ставится на паузу (соперник продолжает играть), кроме итогового окна
  useEffect(() => {
    engine?.setPaused(!!result);
  }, [engine, result]);

  const leave = () => {
    sound.uiClick();
    room.send({ t: 'leave' });
    props.onLeave();
  };

  const onRematchClick = () => {
    sound.uiClick();
    if (rematch === 'received') {
      room.send({ t: 'rematchAccept' });
      if (isHost) props.onRematchStart();
      setRematch('sent');
    } else if (rematch === 'idle') {
      room.send({ t: 'rematch' });
      setRematch('sent');
    }
  };

  const reconnecting = roomSnap.status === 'reconnecting' || roomSnap.status === 'connecting';
  const statusText = reconnecting
    ? 'Связь с сервером восстанавливается…'
    : opponentLeft
      ? `${opponentName} вышел из матча`
      : !opponentOnline
        ? `${opponentName} не в сети — ждём переподключения…`
        : s?.netWaiting
          ? 'Ждём данные броска соперника…'
          : s?.remoteAiming
            ? `${opponentName} целится…`
            : null;

  return (
    <div className="game" ref={view.containerRef}>
      <canvas
        ref={canvasRef}
        className="game__canvas"
        tabIndex={0}
        aria-label={`Онлайн-матч на коне «${layout.name}». Вы — ${config.players[localSeat]}. В свой ход зажмите сақа в руке внизу, тяните к асыкам и отпустите.`}
      />

      <header className="hud" ref={view.hudRef}>
        <div className="hud__bar">
          <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Меню матча">
            <Icon name="pause" />
          </button>
          <div className="hud__level">
            <span className="hud__level-name">Онлайн · {layout.name}</span>
            <span className="hud__goal">{m ? `В коне ${m.asyksLeft} из ${m.totalAsyks} · бросок ${m.totalThrows}/${m.maxThrows}` : ''}</span>
          </div>
          <div className="hud__stats hud__stats--match">
            {([0, 1] as Seat[]).map((seat) => (
              <PlayerCard key={seat} seat={seat} hud={m} offline={seat === opponentSeat && (!opponentOnline || opponentLeft)} />
            ))}
          </div>
          <div className="hud__actions">
            <button className="icon-btn" onClick={props.onToggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'} aria-pressed={muted}>
              <Icon name={muted ? 'mute' : 'sound'} />
            </button>
          </div>
        </div>
      </header>

      <Toast message={s?.message ?? null} top={view.size.top} />
      {statusText && !result && (
        <div className={`net-status${reconnecting || !opponentOnline || opponentLeft ? ' net-status--warn' : ''}`} style={{ top: view.size.top + 52 }} role="status">
          {statusText}
        </div>
      )}
      {m && !result && <TurnBanner hud={m} y={view.w2s(0, 720).y} />}
      <div className="sr-only" aria-live="polite">
        {m ? (m.current === localSeat ? 'Ваш ход.' : `Ход соперника: ${opponentName}.`) + ` Счёт ${m.players[0].knocked}:${m.players[1].knocked}.` : ''}
      </div>

      <PowerMeter view={view} power={s?.aiming ? s.power : 0} aiming={!!s?.aiming} />
      <RotateHint view={view} hidden={!!result} />

      {syncing && (
        <div className="overlay overlay--soft" role="status">
          <div className="sync-card">Восстанавливаем матч…</div>
        </div>
      )}

      {menuOpen && !result && (
        <Modal labelledBy="online-menu-title" onClose={() => setMenuOpen(false)} className="modal--pause">
          <h2 id="online-menu-title" className="modal__title">
            Матч онлайн
          </h2>
          <p className="modal__text">Пауза в онлайне не останавливает игру — соперник ждёт вашего хода.</p>
          <div className="stack">
            <button className="btn btn--primary btn--block" onClick={() => setMenuOpen(false)} data-autofocus>
              <Icon name="play" /> Вернуться к игре
            </button>
            <button className="btn btn--block btn--ghost" onClick={props.onToggleMute} aria-pressed={muted}>
              <Icon name={muted ? 'mute' : 'sound'} /> {muted ? 'Звук выключен' : 'Звук включён'}
            </button>
            <button className="btn btn--block btn--ghost btn--danger" onClick={leave}>
              <Icon name="home" /> Выйти из матча
            </button>
          </div>
        </Modal>
      )}

      {result && (
        <MatchResultOverlay
          result={result}
          layoutName={layout.name}
          online={{ rematch, opponent: opponentName, opponentLeft }}
          newMatchLabel="Выйти из комнаты"
          onRematch={onRematchClick}
          onNewMatch={leave}
          onHome={leave}
        />
      )}
    </div>
  );
}
