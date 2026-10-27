import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MatchSyncState } from '../../game/engine/GameEngine';
import { getMatchLayout } from '../../game/levels/matchLayouts';
import { MAX_PLAYERS, throwsPerPlayer } from '../../game/rules/matchState';
import type { MatchConfig, Seat } from '../../game/types';
import { formatRoomCode, makeClientId, type PeerInfo } from '../../net/protocol';
import { onlineAvailable } from '../../net/config';
import { getRoom, type Room, type RoomSnapshot } from '../../net/room';
import { seatedCount } from '../../net/seats';
import { loadRoomSession, saveRoomSession, type RoomSession } from '../../net/session';
import { totalOf } from '../../net/sync';
import { Icon } from '../components/Icon';
import { LevelPreview } from '../components/LevelPreview';
import { cleanName, NAME_MAX } from '../format';
import { type LobbySlot, PlayerSlots, RoomCodeCard } from '../game/LobbyParts';
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

/** Комната онлайн-матча: вход по ссылке или коду → ожидание игроков (2–4) → матч(и). */
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
          // место гость выберет сам, когда увидит, кто уже в комнате
          const s: RoomSession = { clientId: makeClientId(), seat: null, name, layoutId: '', match: null };
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

/** Имена в составе матча должны различаться: «Айдос», «Айдос 2». */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n} ${k}`.slice(0, NAME_MAX + 3);
  });
}

function RoomLive(props: Props & { session: RoomSession }) {
  const { code } = props;
  const [session, setSession] = useState(props.session);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // одна комната на «код + игрок»: место гостя меняется внутри комнаты, саму комнату не пересоздаём
  const room = useMemo(() => getRoom(code, { clientId: session.clientId, seat: session.seat, name: session.name }), [code, session.clientId]);
  const snap = useSyncExternalStore(room.subscribe, room.getSnapshot);
  const [match, setMatch] = useState(session.match);
  const [initialSync, setInitialSync] = useState<MatchSyncState | null>(session.match?.state ?? null);
  /** Хозяин начал матч, в который этот игрок не попал (вошёл в последний момент). */
  const [excluded, setExcluded] = useState(false);
  const restored = useRef(!!session.match);
  const matchRef = useRef(match);
  matchRef.current = match;

  useEffect(() => {
    room.connect();
    if (import.meta.env.DEV) (window as unknown as { __asykRoom?: Room }).__asykRoom = room; // отладка в браузере
    return () => room.close();
  }, [room]);

  // гость занял место — запоминаем: после перезагрузки он вернётся на него
  useEffect(
    () =>
      room.onSeat((seat) => {
        const next = { ...sessionRef.current, seat };
        sessionRef.current = next;
        saveRoomSession(code, next);
        setSession(next);
      }),
    [room, code],
  );

  // состав текущего матча: только эти игроки «говорят» в матче; остальные видят, что идёт матч
  const mySeatInMatch = match?.config.ids ? match.config.ids.indexOf(session.clientId) : -1;
  useEffect(() => {
    const inMatch = !!match && mySeatInMatch >= 0;
    room.setRoster(inMatch ? (match!.config.ids ?? null) : null);
    room.setBusy(inMatch);
  }, [room, match, mySeatInMatch]);

  const persist = (m: RoomSession['match']) => saveRoomSession(code, { ...sessionRef.current, match: m });

  /** Самый свежий сохранённый снимок текущего матча (из sessionStorage, а не из памяти компонента). */
  const readSnapshot = (): MatchSyncState | null => {
    const stored = loadRoomSession(code)?.match;
    const cur = matchRef.current;
    return stored && cur && stored.matchId === cur.matchId ? (stored.state ?? null) : null;
  };

  const enterMatch = (m: { config: MatchConfig; matchId: number }, state: MatchSyncState | null) => {
    restored.current = false;
    setExcluded(false);
    setInitialSync(state);
    setMatch(m);
    persist(m);
  };

  // старт матча и вход в уже идущий матч
  useEffect(
    () =>
      room.onMessage((msg, ctx) => {
        const cur = matchRef.current;
        const me = sessionRef.current;
        if (msg.t === 'start') {
          // начать матч может только хозяин комнаты (место 0), и только гости его слушают
          if (ctx.seat !== 0 || me.seat === 0 || (cur && msg.matchId <= cur.matchId)) return;
          if (!msg.config.ids?.includes(me.clientId)) {
            setExcluded(true); // матч начался без этого игрока
            return;
          }
          enterMatch({ config: msg.config, matchId: msg.matchId }, null);
        } else if (msg.t === 'sync' && (!cur || msg.matchId > cur.matchId)) {
          // вход в идущий матч — только если я в его составе и снимок прислал участник этого матча
          const ids = msg.config.ids;
          if (!ids?.includes(me.clientId) || !ids.includes(ctx.from)) return;
          enterMatch({ config: msg.config, matchId: msg.matchId }, msg.state);
        }
      }),
    [room],
  );

  const isHost = session.seat === 0;

  /**
   * Хозяин бросает жребий и начинает матч со всеми, кто сейчас за столом (2–4 игрока).
   * Реванш (`readyIds`) — с теми, кто нажал «Реванш»; первым бросает следующий по кругу.
   */
  const startMatch = (readyIds?: string[]) => {
    if (sessionRef.current.seat !== 0) return;
    const s = room.getSnapshot();
    const cur = matchRef.current;
    const seated = s.seats.filter((p): p is PeerInfo => !!p && !s.bad.includes(p.clientId));
    let roster = [{ id: session.clientId, name: session.name }, ...seated.map((p) => ({ id: p.clientId, name: p.name }))];
    if (readyIds) roster = roster.filter((r) => readyIds.includes(r.id));
    roster = roster.slice(0, MAX_PLAYERS);
    if (roster.length < 2) return;
    const ids = roster.map((r) => r.id);
    const same = !!cur?.config.ids && cur.config.ids.length === ids.length && cur.config.ids.every((id, i) => id === ids[i]);
    const first = (readyIds && same && cur ? (cur.config.first + 1) % ids.length : Math.floor(Math.random() * ids.length)) as Seat;
    const config: MatchConfig = { layoutId: session.layoutId, players: uniqueNames(roster.map((r) => r.name)), ids, first, rematch: !!readyIds };
    const m = { config, matchId: (cur?.matchId ?? 0) + 1 };
    room.send({ t: 'start', config, matchId: m.matchId });
    enterMatch(m, null);
  };

  const exit = () => {
    room.send({ t: 'leave' });
    room.setBusy(false);
    saveRoomSession(code, { ...sessionRef.current, match: null });
    props.onExit();
  };

  if (snap.status === 'full') {
    return isHost ? (
      <Notice title="Комната уже открыта" text="Эта комната уже открыта в другой вкладке или на другом устройстве. Закрой её там или создай новую." onExit={props.onExit} />
    ) : (
      <Notice title="Комната занята" text={`За столом уже ${MAX_PLAYERS} игрока. Попроси друга создать новую комнату.`} onExit={props.onExit} />
    );
  }

  if (match && mySeatInMatch >= 0) {
    return (
      <OnlineMatchScreen
        key={match.matchId}
        room={room}
        roomSnap={snap}
        config={match.config}
        matchId={match.matchId}
        localSeat={mySeatInMatch as Seat}
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
        onRematchStart={(readyIds) => startMatch(readyIds)}
        onLeave={exit}
      />
    );
  }

  return <Lobby code={code} session={session} snap={snap} excluded={excluded} onStart={() => startMatch()} onExit={exit} />;
}

function Lobby({
  code,
  session,
  snap,
  excluded,
  onStart,
  onExit,
}: {
  code: string;
  session: RoomSession;
  snap: RoomSnapshot;
  excluded: boolean;
  onStart: () => void;
  onExit: () => void;
}) {
  const isHost = session.seat === 0;
  const link = `${window.location.origin}${window.location.pathname}#/room/${code}`;
  const layout = session.layoutId ? getMatchLayout(session.layoutId) : null;
  const connecting = snap.status === 'connecting' || snap.status === 'reconnecting';
  const host = isHost ? null : snap.seats[0];
  const count = seatedCount(snap.seats, session.seat);

  // места за столом: я и остальные; цвет — по будущему месту в матче (порядок занятых мест)
  let order = 0;
  const slots: LobbySlot[] = Array.from({ length: MAX_PLAYERS }, (_, s) => {
    const mine = session.seat === s;
    const name = mine ? session.name : (snap.seats[s]?.name ?? null);
    return { seat: s, name, you: mine, host: s === 0, order: name ? order++ : undefined };
  });

  let status: React.ReactNode;
  if (connecting) status = <p className="lobby-status">Подключаемся к комнате…</p>;
  else if (snap.status === 'busy')
    status = (
      <p className="lobby-status">
        В комнате идёт матч. Как только он закончится, ты займёшь свободное место<span className="dots" aria-hidden="true" />
      </p>
    );
  else if (excluded)
    status = (
      <p className="lobby-status">
        Матч начался без тебя. Дождись его конца — хозяин сможет начать новый<span className="dots" aria-hidden="true" />
      </p>
    );
  else if (isHost)
    status =
      count >= 2 ? (
        <>
          <p className="lobby-status lobby-status--ready">
            За столом {count} {count === MAX_PLAYERS ? 'игрока — мест больше нет' : 'игрока'}. Можно начинать!
          </p>
          <button className="btn btn--primary btn--xl btn--block" onClick={onStart}>
            <Icon name="dice" /> Бросить жребий и начать
          </button>
        </>
      ) : (
        <p className="lobby-status">
          Ждём игроков: можно позвать до трёх друзей<span className="dots" aria-hidden="true" />
        </p>
      );
  else if (host)
    status = (
      <p className="lobby-status">
        Ждём, пока {host.name} начнёт матч<span className="dots" aria-hidden="true" />
      </p>
    );
  else
    status = (
      <p className="lobby-status">
        Хозяин комнаты не в сети. Попроси его открыть игру<span className="dots" aria-hidden="true" />
      </p>
    );

  return (
    <main className="page page--doc">
      <div className="doc">
        <button className="back-btn" onClick={onExit}>
          <Icon name="back" /> Выйти
        </button>
        <p className="kicker">Онлайн-матч</p>
        <h1 className="doc__title">Комната ожидания</h1>

        <RoomCodeCard code={code} link={link} />

        <section className="lobby-card lobby-card--status" aria-live="polite">
          <PlayerSlots slots={slots} />
          {status}
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
              <p className="doc__muted">
                Броски строго по очереди, по кругу: по {throwsPerPlayer(2)} на каждого у двоих, по {throwsPerPlayer(3)} — у троих и четверых.
                Побеждает тот, кто выбьет больше.
              </p>
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
          Комната <span className="room-code">{formatRoomCode(code)}</span>
        </h1>
        <p className="doc__lead">Асық ату онлайн: бросаете по очереди, побеждает тот, кто выбьет больше асыков.</p>
        <form
          className="setup"
          onSubmit={(e) => {
            e.preventDefault();
            onJoin(cleanName(name, 'Игрок'));
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
