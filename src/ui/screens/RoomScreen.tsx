import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MatchSyncState } from '../../game/engine/GameEngine';
import { getMatchLayout } from '../../game/levels/matchLayouts';
import type { MatchConfig, Seat } from '../../game/types';
import { makeClientId } from '../../net/protocol';
import { onlineAvailable } from '../../net/config';
import { getRoom, type Room } from '../../net/room';
import { loadRoomSession, saveRoomSession, type RoomSession } from '../../net/session';
import { totalOf } from '../../net/sync';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { cleanName, NAME_MAX } from '../format';
import { OnlineMatchScreen } from './OnlineMatchScreen';

interface Props {
  code: string;
  defaultName: string;
  muted: boolean;
  reducedMotion: boolean;
  onToggleMute: () => void;
  onRememberName: (name: string) => void;
  onExit: () => void;
}

/** Комната онлайн-матча: вход по ссылке → ожидание соперника → матч(и). */
export function RoomScreen(props: Props) {
  const [session, setSession] = useState<RoomSession | null>(() => loadRoomSession(props.code));

  if (!onlineAvailable) {
    return (
      <Notice title="Онлайн-режим недоступен" text="В этой сборке игры не настроено подключение к серверу комнат." onExit={props.onExit} />
    );
  }
  if (!session) {
    return (
      <JoinRoom
        code={props.code}
        defaultName={props.defaultName}
        onJoin={(name) => {
          const s: RoomSession = { clientId: makeClientId(), seat: 1, name, layoutId: '', match: null };
          saveRoomSession(props.code, s);
          props.onRememberName(name);
          setSession(s);
        }}
        onExit={props.onExit}
      />
    );
  }
  return <RoomLive {...props} session={session} />;
}

function RoomLive(props: Props & { session: RoomSession }) {
  const { code, session } = props;
  const room = useMemo(() => getRoom(code, { clientId: session.clientId, seat: session.seat, name: session.name }), [code, session.clientId, session.seat, session.name]);
  const snap = useSyncExternalStore(room.subscribe, room.getSnapshot);
  const [match, setMatch] = useState(session.match);
  const [initialSync, setInitialSync] = useState<MatchSyncState | null>(session.match?.state ?? null);
  const restored = useRef(!!session.match);
  const matchRef = useRef(match);
  matchRef.current = match;

  useEffect(() => {
    room.connect();
    if (import.meta.env.DEV) (window as unknown as { __asykRoom?: Room }).__asykRoom = room; // отладка в браузере
    return () => room.close();
  }, [room]);

  const persist = (m: RoomSession['match']) => saveRoomSession(code, { ...session, match: m });

  /** Самый свежий сохранённый снимок текущего матча (из sessionStorage, а не из памяти компонента). */
  const readSnapshot = (): MatchSyncState | null => {
    const stored = loadRoomSession(code)?.match;
    const cur = matchRef.current;
    return stored && cur && stored.matchId === cur.matchId ? (stored.state ?? null) : null;
  };

  // старт матча и вход в уже идущий матч
  useEffect(
    () =>
      room.onMessage((msg, ctx) => {
        const cur = matchRef.current;
        // начать матч может только хозяин комнаты (место 0), и только гость его слушает
        if (msg.t === 'start' && ctx.seat === 0 && session.seat === 1 && (!cur || msg.matchId > cur.matchId)) {
          const m = { config: msg.config, matchId: msg.matchId };
          restored.current = false;
          setInitialSync(null);
          setMatch(m);
          persist(m);
        } else if (msg.t === 'sync' && (!cur || msg.matchId > cur.matchId)) {
          const m = { config: msg.config, matchId: msg.matchId };
          restored.current = false;
          setInitialSync(msg.state);
          setMatch(m);
          persist(m);
        }
      }),
    [room],
  );

  const opponent = snap.peer;
  const isHost = session.seat === 0;

  /** Хост бросает жребий и начинает матч (или реванш: первым — другой игрок). */
  const startMatch = (rematch: boolean) => {
    if (!isHost) return;
    const cur = matchRef.current;
    const guestName = opponent?.name ?? cur?.config.players[1] ?? 'Соперник';
    const first: Seat = rematch && cur ? (cur.config.first === 0 ? 1 : 0) : Math.random() < 0.5 ? 0 : 1;
    const config: MatchConfig = { layoutId: session.layoutId, players: [session.name, guestName], first, rematch };
    const m = { config, matchId: (cur?.matchId ?? 0) + 1 };
    room.send({ t: 'start', config, matchId: m.matchId });
    restored.current = false;
    setInitialSync(null);
    setMatch(m);
    persist(m);
  };

  const exit = () => {
    room.send({ t: 'leave' });
    saveRoomSession(code, { ...session, match: null });
    props.onExit();
  };

  if (snap.status === 'full') {
    return <Notice title="Комната занята" text="В этой комнате уже играют двое. Попроси друга создать новую ссылку." onExit={props.onExit} />;
  }

  if (match) {
    return (
      <OnlineMatchScreen
        key={match.matchId}
        room={room}
        roomSnap={snap}
        config={match.config}
        matchId={match.matchId}
        localSeat={session.seat}
        restored={restored.current}
        initialSync={initialSync}
        muted={props.muted}
        reducedMotion={props.reducedMotion}
        onToggleMute={props.onToggleMute}
        readSnapshot={readSnapshot}
        onSnapshot={(state) => {
          const cur = matchRef.current;
          if (!cur) return;
          // более ранний снимок (например, у только что пересозданного экрана) не затирает более свежий
          const stored = readSnapshot();
          if (stored && totalOf(stored) > totalOf(state)) return;
          persist({ ...cur, state });
        }}
        onRematchStart={() => startMatch(true)}
        onLeave={exit}
      />
    );
  }

  return <Lobby code={code} session={session} status={snap.status} opponent={opponent?.name ?? null} onStart={() => startMatch(false)} onExit={exit} />;
}

function Lobby({
  code,
  session,
  status,
  opponent,
  onStart,
  onExit,
}: {
  code: string;
  session: RoomSession;
  status: string;
  opponent: string | null;
  onStart: () => void;
  onExit: () => void;
}) {
  const isHost = session.seat === 0;
  const link = `${window.location.origin}${window.location.pathname}#/room/${code}`;
  const [copied, setCopied] = useState(false);
  const layout = session.layoutId ? getMatchLayout(session.layoutId) : null;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // буфер обмена недоступен — ссылку можно выделить вручную
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Асық ату — сыграем?', text: `Сыграем в асық ату онлайн! Комната ${code}`, url: link });
    } catch {
      // пользователь закрыл окно «Поделиться»
    }
  };

  const connecting = status === 'connecting' || status === 'reconnecting';
  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onExit}>
          <Icon name="back" /> Выйти
        </button>
        <p className="kicker">Онлайн-матч</p>
        <h1 className="doc__title">
          Комната <span className="room-code">{code}</span>
        </h1>

        {isHost ? (
          <section className="lobby-card">
            <h2>Пригласи друга</h2>
            <p className="doc__muted">Отправь ссылку — друг откроет её на своём телефоне или компьютере.</p>
            <div className="share-row">
              <input className="share-row__link" value={link} readOnly aria-label="Ссылка на комнату" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" onClick={copy}>
                {copied ? 'Скопировано ✓' : 'Копировать'}
              </button>
              {canShare && (
                <button className="btn btn--primary" onClick={share}>
                  Поделиться
                </button>
              )}
            </div>
          </section>
        ) : null}

        <section className="lobby-card lobby-card--status" aria-live="polite">
          <div className="lobby-players">
            <span className="lobby-player lobby-player--0">{isHost ? `${session.name} · вы` : opponent ?? 'Хозяин комнаты'}</span>
            <span className="lobby-vs">vs</span>
            <span className="lobby-player lobby-player--1">{isHost ? opponent ?? 'ждём…' : `${session.name} · вы`}</span>
          </div>
          {connecting ? (
            <p className="lobby-status">Подключаемся к комнате…</p>
          ) : isHost ? (
            opponent ? (
              <>
                <p className="lobby-status lobby-status--ready">{opponent} в комнате!</p>
                <button className="btn btn--primary btn--xl btn--block" onClick={onStart}>
                  <Icon name="dice" /> Бросить жребий и начать
                </button>
              </>
            ) : (
              <p className="lobby-status">
                Ждём соперника<span className="dots" aria-hidden="true" />
              </p>
            )
          ) : opponent ? (
            <p className="lobby-status">
              Ждём, пока {opponent} начнёт матч<span className="dots" aria-hidden="true" />
            </p>
          ) : (
            <p className="lobby-status">
              Хозяин комнаты не в сети. Попроси его открыть игру<span className="dots" aria-hidden="true" />
            </p>
          )}
        </section>

        {layout && (
          <section className="lobby-card lobby-layout">
            <span className="layout-option__preview">
              <LevelPreview level={layout} />
            </span>
            <div>
              <b>
                {layout.name} <small>{layout.kazName}</small>
              </b>
              <p className="doc__muted">{layout.description}</p>
              <p className="doc__muted">Броски строго по очереди, по 15 на каждого. Побеждает тот, кто выбьет больше.</p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function JoinRoom({ code, defaultName, onJoin, onExit }: { code: string; defaultName: string; onJoin: (name: string) => void; onExit: () => void }) {
  const [name, setName] = useState(defaultName);
  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onExit}>
          <Icon name="back" /> На главную
        </button>
        <p className="kicker">Тебя позвали сыграть</p>
        <h1 className="doc__title">
          Комната <span className="room-code">{code}</span>
        </h1>
        <p className="doc__lead">Асық ату онлайн: бросаете по очереди, побеждает тот, кто выбьет больше асыков.</p>
        <form
          className="setup"
          onSubmit={(e) => {
            e.preventDefault();
            onJoin(cleanName(name, 'Игрок 2'));
          }}
        >
          <label className="name-field" style={{ '--player': '#8b5cf6' } as React.CSSProperties}>
            <span className="sr-only">Твоё имя</span>
            <input
              type="text"
              value={name}
              maxLength={NAME_MAX}
              placeholder="Твоё имя"
              autoComplete="nickname"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--primary btn--xl btn--block">
            <Icon name="play" /> Войти в матч
          </button>
        </form>
      </div>
    </main>
  );
}

function Notice({ title, text, onExit }: { title: string; text: string; onExit: () => void }) {
  return (
    <main className="page page--doc">
      <div className="doc">
        <h1 className="doc__title">{title}</h1>
        <p className="doc__lead">{text}</p>
        <div className="doc__actions">
          <button className="btn btn--primary" onClick={onExit}>
            <Icon name="home" /> На главную
          </button>
        </div>
      </div>
    </main>
  );
}
