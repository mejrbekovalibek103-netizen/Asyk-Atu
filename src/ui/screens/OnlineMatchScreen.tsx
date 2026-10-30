import { useEffect, useRef, useState } from 'react';
import { sound } from '../../game/audio/sound';
import { GameEngine, type MatchSyncState } from '../../game/engine/GameEngine';
import { getMatchLayout } from '../../game/levels/matchLayouts';
import { MatchRules } from '../../game/rules/MatchRules';
import type { MatchConfig, MatchHud, MatchResult, Seat } from '../../game/types';
import type { NetMessage } from '../../net/protocol';
import type { Room, RoomSnapshot } from '../../net/room';
import { decideSync, factsOf, totalOf, type SyncTrust } from '../../net/sync';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { listNames } from '../format';
import { PowerMeter, RotateHint, Toast } from '../game/GameOverlays';
import { PlayerCard, TurnBanner } from '../game/MatchParts';
import { useGameEngine } from '../game/useGameEngine';
import { MatchResultOverlay, type OnlineRematch } from './MatchResultOverlay';

interface Props {
  room: Room;
  roomSnap: RoomSnapshot;
  config: MatchConfig;
  matchId: number;
  /** Моё место в матче (индекс в составе `config.ids`). */
  localSeat: Seat;
  /** Матч восстановлен после перезагрузки — запросить состояние у остальных. */
  restored: boolean;
  /** Состояние, пришедшее вместе с матчем или сохранённое до перезагрузки. */
  initialSync: MatchSyncState | null;
  /** Сохранить снимок матча (после каждого броска). */
  onSnapshot: (state: MatchSyncState) => void;
  /** Самый свежий сохранённый снимок: при (пере)создании экрана поднимаем из него матч, а не начинаем с нуля. */
  readSnapshot: () => MatchSyncState | null;
  muted: boolean;
  reducedMotion: boolean;
  onToggleMute: () => void;
  /** Хозяин запускает реванш с теми, кто готов (id клиентов). */
  onRematchStart: (readyIds: string[]) => void;
  /** Из итогов — в комнату ожидания (тот же состав; хозяин может сменить кон). */
  onToLobby: () => void;
  onLeave: () => void;
}

const STALL_SYNC_MS = 5000;
/** Игрок не в сети: его ход пропускается через это время (решение владельца проекта — около 20 секунд). */
const SKIP_AFTER_MS = 20_000;
/** Игрок сам вышел из матча — его ход пропускается почти сразу. */
const SKIP_LEFT_MS = 2_000;
/**
 * Бросок следующего игрока может прийти, пока этот экран ещё показывает предыдущий бросок (у троих-четверых
 * зритель иногда отстаёт). Такие сообщения не теряются: ждут в буфере, пока у этого игрока не наступит ход.
 */
const EARLY_TTL_MS = 15_000;
const EARLY_MAX = 300;
/** От игрока, чей ход, долго ничего нет, а он в сети, — возможно, мы отстали: спрашиваем состояние. */
const STUCK_SYNC_MS = 15_000;
const RESYNC_GAP_MS = 8_000;
/** Если назначенный игрок не пропустил ход (например, его вкладка в фоне), это сделает любой через столько же ещё. */
const SKIP_FALLBACK_MS = 10_000;
/** Получатель принимает чужой «пропуск хода», только если сам видит этот ход не меньше этого времени… */
const SKIP_ACCEPT_MS = 12_000;
/** …и пропускаемый игрок всё это время ничего не присылал. */
const SKIP_QUIET_MS = 8_000;

/** Онлайн-матч на 2–4 игрока: этот экран управляет одним игроком, броски остальных приходят по сети. */
export function OnlineMatchScreen(props: Props) {
  const { room, roomSnap, config, matchId, localSeat, muted } = props;
  const layout = getMatchLayout(config.layoutId);
  const ids = config.ids ?? [];
  const n = config.players.length;
  const [result, setResult] = useState<MatchResult | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // с чего начинаем: самый свежий из присланного родителем и сохранённого снимков (экран мог быть пересоздан)
  const [boot] = useState(() => {
    const stored = props.readSnapshot();
    const init = stored && totalOf(stored) > totalOf(props.initialSync) ? stored : props.initialSync;
    return { init, restored: props.restored || (!!init && totalOf(init) > 0) };
  });
  const [syncing, setSyncing] = useState(boot.restored && !boot.init);
  /** Кто из остальных готов к реваншу (места матча) и готов ли я. */
  const [readySeats, setReadySeats] = useState<ReadonlySet<number>>(new Set());
  const [iAmReady, setIAmReady] = useState(false);
  /** Кто сам вышел из матча (места). */
  const [leftSeats, setLeftSeats] = useState<ReadonlySet<number>>(new Set());
  /** Тикает раз в секунду, пока ждём отсутствующего игрока (обратный отсчёт до пропуска хода). */
  const [, setTick] = useState(0);
  const pendingSync = useRef(false);
  /**
   * Насколько можно доверять состоянию этого экрана (см. SyncTrust). После перезагрузки без сохранения
   * экран начинает с пустого кона и НЕ навязывает его остальным (иначе обнулил бы чужой матч);
   * с сохранением — принимает всё, что новее; живой экран проверяет чужие снимки строго.
   */
  const trust = useRef<SyncTrust>(!boot.restored ? 'live' : boot.init ? 'restored' : 'none');
  const propsRef = useRef(props);
  propsRef.current = props;
  const isHost = roomSnap.seat === 0;

  // кто из состава сейчас в комнате (я — всегда)
  const presentIds = new Set(roomSnap.peers.map((p) => p.clientId));
  const online = ids.map((id, s) => s === localSeat || presentIds.has(id));
  const gone = (s: number) => s !== localSeat && (!online[s] || leftSeats.has(s));
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const leftRef = useRef(leftSeats);
  leftRef.current = leftSeats;
  /** Когда от каждого игрока последний раз что-то приходило (для проверки «пропуска хода»). */
  const lastHeard = useRef<number[]>(ids.map(() => performance.now()));
  /** Когда игрок пропал из комнаты (null — в комнате). */
  const absentSince = useRef<(number | null)[]>(ids.map(() => null));
  const turnStartedAt = useRef(performance.now());
  /** Сообщения о броске, пришедшие раньше хода отправителя: место → сообщения (с временем прихода). */
  const early = useRef(new Map<number, { msg: NetMessage; at: number }[]>());
  const lastResync = useRef(0);

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
    if (boot.init) engine.importMatchState(boot.init, true);
    // вернулись в матч — спрашиваем остальных: если они ушли дальше, их состояние новее
    if (boot.restored) room.send({ t: 'syncRequest' });
  }, [engine]);

  // если синхронизация не пришла — играем с тем, что есть
  useEffect(() => {
    if (!syncing) return;
    const t = window.setTimeout(() => {
      // никто не ответил — у нас лучшее состояние из доступных (например, все перезагрузились)
      trust.current = 'live';
      setSyncing(false);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [syncing]);

  // новый ход — засекаем время (для пропуска хода отсутствующего игрока) и выпускаем бросок, пришедший раньше
  useEffect(() => {
    turnStartedAt.current = performance.now();
    if (!engine || !m || m.current === localSeat) return;
    const now = performance.now();
    const list = (early.current.get(m.current) ?? []).filter((x) => now - x.at <= EARLY_TTL_MS);
    early.current.delete(m.current);
    // остальные буферы чистим от устаревшего
    for (const [seat, l] of early.current) early.current.set(seat, l.filter((x) => now - x.at <= EARLY_TTL_MS));
    if (engine.getSnapshot().phase !== 'READY') return;
    for (const x of list) deliverThrow(x.msg);
  }, [m?.turnId, engine]);

  // ход «застрял»: тот, чей ход, в сети, но от него давно ничего нет — возможно, мы отстали (пропустили бросок)
  useEffect(() => {
    if (!engine || result) return;
    const t = window.setInterval(() => {
      const hud = engine.getSnapshot().mode;
      if (hud.kind !== 'match' || hud.finished || hud.current === localSeat || engine.getSnapshot().phase !== 'READY') return;
      // бросок текущего игрока застрял в буфере (пришёл раньше, чем мы успели перейти к его ходу) — выпускаем
      const waiting = early.current.get(hud.current);
      if (waiting?.length) {
        early.current.delete(hud.current);
        for (const x of waiting) if (performance.now() - x.at <= EARLY_TTL_MS) deliverThrow(x.msg);
        return;
      }
      if (!onlineRef.current[hud.current]) return; // не в сети — этим занимается пропуск хода
      const now = performance.now();
      const quietFor = now - Math.max(turnStartedAt.current, lastHeard.current[hud.current] ?? 0);
      if (quietFor >= STUCK_SYNC_MS) requestResync();
    }, 2000);
    return () => window.clearInterval(t);
  }, [engine, result]);

  // сообщения остальных игроков
  useEffect(() => {
    if (!engine) return;
    return room.onMessage((msg, ctx) => {
      // принимаем только участников этого матча; место отправителя — по составу, а не по его словам
      const from = ids.indexOf(ctx.from);
      if (from < 0 || from === localSeat) return;
      lastHeard.current[from] = performance.now();
      const hud = engine.getSnapshot().mode;
      const current = hud.kind === 'match' ? hud.current : -1;
      switch (msg.t) {
        // прицел и бросок — только от того, чей сейчас ход: остальные «бросить за другого» не могут
        case 'aim':
          if (from === current) engine.setRemoteAim(msg.a);
          break;
        case 'throwStart':
        case 'throwChunk':
        case 'throwEnd': {
          const phase = engine.getSnapshot().phase;
          const ready = from === current && (msg.t !== 'throwStart' || phase === 'READY');
          if (ready && !early.current.get(from)?.length) {
            deliverThrow(msg);
          } else {
            // ход этого игрока ещё не наступил у нас (досматриваем предыдущий бросок) — бросок ждёт в буфере
            const list = early.current.get(from) ?? [];
            if (list.length < EARLY_MAX) list.push({ msg, at: performance.now() });
            early.current.set(from, list);
            // бросок не от того, кого мы ждём, хотя мы между ходами: похоже, мы отстали — спрашиваем состояние
            if (msg.t === 'throwStart' && phase === 'READY' && from !== current) requestResync();
          }
          break;
        }
        case 'syncRequest':
          if (trust.current !== 'none') {
            pendingSync.current = true;
            trySendSync();
          }
          break;
        case 'sync': {
          if (msg.matchId !== matchId) break;
          // снимок другого состава (не этого матча) не принимаем
          const sameRoster = (msg.config.ids ?? []).length === ids.length && (msg.config.ids ?? []).every((id, i) => id === ids[i]);
          if (!sameRoster) break;
          switch (decideSync(trust.current, factsOf(msg.state, n), factsOf(engine.exportMatchState(), n), localSeat)) {
            case 'apply':
              // воскрешать выбитые асыки можно только тому, у кого вообще нет состояния
              if (engine.importMatchState(msg.state, true, trust.current === 'none')) {
                trust.current = 'live';
                setSyncing(false);
              }
              break;
            case 'reply':
              // отправитель отстал (например, вернулся со старым снимком) — отвечаем своим, более новым состоянием
              pendingSync.current = true;
              trySendSync();
              break;
            case 'reject':
              break; // снимок противоречит истории матча — игнорируем
          }
          break;
        }
        case 'skip': {
          // чужое «пропуск хода» проверяем сами: это текущий ход, и игрок действительно давно молчит (или вышел)
          if (hud.kind !== 'match' || msg.seat !== hud.current || msg.turnId !== hud.totalThrows + 1 || msg.seat === from) break;
          if (engine.getSnapshot().phase !== 'READY') break;
          const now = performance.now();
          const left = leftRef.current.has(msg.seat);
          // игрок, которого я сам вижу в комнате, не пропускается — даже если долго думает (защита от «выталкивания»)
          if (!left && onlineRef.current[msg.seat]) break;
          const quiet = now - (lastHeard.current[msg.seat] ?? 0) >= SKIP_QUIET_MS;
          const long = now - turnStartedAt.current >= SKIP_ACCEPT_MS;
          if (left || (quiet && long)) engine.skipTurn(msg.seat as Seat, msg.turnId);
          break;
        }
        case 'rematch':
        case 'rematchAccept':
          setReadySeats((prev) => new Set(prev).add(from));
          break;
        case 'leave':
          setLeftSeats((prev) => new Set(prev).add(from));
          setReadySeats((prev) => {
            const next = new Set(prev);
            next.delete(from);
            return next;
          });
          break;
      }
    });
  }, [engine, room, matchId]);

  /** Передать сообщение о броске движку (место отправителя уже проверено). */
  function deliverThrow(msg: NetMessage) {
    if (!engine) return;
    if (msg.t === 'throwStart') engine.remoteThrowStart(msg.s);
    else if (msg.t === 'throwChunk') engine.remoteThrowChunk(msg.c);
    else if (msg.t === 'throwEnd') engine.remoteThrowEnd(msg.e);
  }

  /** Спросить у остальных актуальное состояние матча (не чаще раза в несколько секунд). */
  function requestResync() {
    const now = performance.now();
    if (now - lastResync.current < RESYNC_GAP_MS) return;
    lastResync.current = now;
    room.send({ t: 'syncRequest' });
  }

  /** Отправить состояние, когда этот экран между бросками (свой бросок не прерываем). */
  function trySendSync() {
    if (!engine || !pendingSync.current || trust.current === 'none') return;
    const phase = engine.getSnapshot().phase;
    if (phase !== 'READY' && phase !== 'ROUND_COMPLETE') return;
    pendingSync.current = false;
    room.send({ t: 'sync', config, matchId, state: engine.exportMatchState() });
  }

  useEffect(() => {
    trySendSync();
  });

  // снимок матча после каждого броска — чтобы перезагрузка не обнуляла игру
  const totalThrows = m?.totalThrows ?? 0;
  useEffect(() => {
    if (!engine || trust.current === 'none') return;
    const phase = engine.getSnapshot().phase;
    if (phase === 'READY' || phase === 'ROUND_COMPLETE') propsRef.current.onSnapshot(engine.exportMatchState());
  }, [engine, s?.phase, totalThrows]);

  // кто-то из игроков вернулся в комнату — отправим актуальное состояние; запоминаем, кто когда пропал
  const onlineKey = online.map((o) => (o ? 1 : 0)).join('');
  const prevOnline = useRef(onlineKey);
  useEffect(() => {
    const now = performance.now();
    let cameBack = false;
    online.forEach((o, i) => {
      if (o) {
        if (absentSince.current[i] !== null) cameBack = true;
        absentSince.current[i] = null;
      } else if (absentSince.current[i] === null) {
        absentSince.current[i] = now;
      }
    });
    if (cameBack && prevOnline.current !== onlineKey) {
      setLeftSeats((prev) => {
        const next = new Set(prev);
        online.forEach((o, i) => o && next.delete(i));
        return next;
      });
      if (trust.current !== 'none') {
        pendingSync.current = true;
        trySendSync();
      }
    }
    prevOnline.current = onlineKey;
  }, [onlineKey]);

  // после потери связи МОЁ состояние могло отстать: принимаем более новое от остальных
  const wasOnline = useRef(roomSnap.status === 'online');
  useEffect(() => {
    if (roomSnap.status === 'online') {
      if (!wasOnline.current && trust.current === 'live') {
        trust.current = 'restored';
        room.send({ t: 'syncRequest' });
      }
      wasOnline.current = true;
    } else if (roomSnap.status === 'reconnecting') {
      wasOnline.current = false;
    }
  }, [roomSnap.status]);

  // ход отсутствующего игрока (матч на 3–4): через ~20 с его пропускает назначенный игрок
  useEffect(() => {
    if (!engine || n < 3 || result) return;
    const t = window.setInterval(() => {
      const hud = engine.getSnapshot().mode;
      if (hud.kind !== 'match' || hud.finished || engine.getSnapshot().phase !== 'READY') return;
      const cur = hud.current;
      if (cur === localSeat) return;
      const left = leftRef.current.has(cur);
      const absent = !onlineRef.current[cur] || left;
      if (!absent) return;
      setTick((x) => x + 1); // обратный отсчёт в строке статуса
      const since = Math.max(turnStartedAt.current, absentSince.current[cur] ?? turnStartedAt.current);
      const wait = left ? SKIP_LEFT_MS : SKIP_AFTER_MS;
      const waited = performance.now() - since;
      if (waited < wait) return;
      // пропускает один назначенный — первый по месту из тех, кто в комнате; если он медлит, через 10 с — любой
      const skipper = ids.findIndex((_, i) => i !== cur && onlineRef.current[i] && !leftRef.current.has(i));
      if (skipper !== localSeat && waited < wait + SKIP_FALLBACK_MS) return;
      const throwNo = hud.totalThrows + 1;
      room.send({ t: 'skip', seat: cur, turnId: throwNo });
      engine.skipTurn(cur, throwNo);
    }, 1000);
    return () => window.clearInterval(t);
  }, [engine, n, result]);

  // запись броска долго не приходит — просим полное состояние
  useEffect(() => {
    if (!s?.netWaiting) return;
    const t = window.setTimeout(() => room.send({ t: 'syncRequest' }), STALL_SYNC_MS);
    return () => window.clearTimeout(t);
  }, [s?.netWaiting, room]);

  // в онлайне движок не ставится на паузу (остальные продолжают играть), кроме итогового окна;
  // после конца матча я «смотрю итоги»: новички могут сесть за стол, хозяин в комнате ожидания ждёт меня
  useEffect(() => {
    engine?.setPaused(!!result);
    room.setStage(result ? 'results' : 'match');
  }, [engine, result, room]);

  // кто из состава уже ушёл из итогов в комнату ожидания: реванша не будет — продолжаем там
  const peerOf = new Map(roomSnap.peers.map((p) => [p.clientId, p]));
  const inLobby = (i: number) => {
    const p = peerOf.get(ids[i]);
    return !!result && i !== localSeat && !gone(i) && !!p && !p.busy && !p.results;
  };
  const lobbySeats = ids.map((_, i) => i).filter(inLobby);

  // реванш: хозяин начинает, когда готовы все, кто остался в комнате (и есть хотя бы один соперник)
  const stillHere = ids.map((_, i) => i).filter((i) => i !== localSeat && !gone(i));
  const everyoneReady = stillHere.length > 0 && stillHere.every((i) => readySeats.has(i)) && !lobbySeats.length;
  useEffect(() => {
    if (!result || !isHost || !iAmReady || !everyoneReady) return;
    propsRef.current.onRematchStart([ids[localSeat], ...stillHere.map((i) => ids[i])]);
  }, [result, isHost, iAmReady, everyoneReady]);

  const leave = () => {
    sound.uiClick();
    room.send({ t: 'leave' });
    props.onLeave();
  };

  const toLobby = () => {
    sound.uiClick();
    props.onToLobby();
  };

  const onRematchClick = () => {
    sound.uiClick();
    if (iAmReady) return;
    room.send({ t: 'rematch' });
    setIAmReady(true);
  };

  const name = (i: number) => config.players[i];
  const current = m?.current ?? -1;
  const badNames = ids.flatMap((id, i) => (roomSnap.bad.includes(id) ? [name(i)] : []));
  const goneOthers = ids.map((_, i) => i).filter((i) => gone(i));
  const reconnecting = roomSnap.status === 'reconnecting' || roomSnap.status === 'connecting';
  let statusText: string | null = null;
  let warn = false;
  if (reconnecting) {
    statusText = 'Связь с сервером восстанавливается…';
    warn = true;
  } else if (badNames.length) {
    statusText = `${listNames(badNames)} ${badNames.length === 1 ? 'присылает' : 'присылают'} некорректные данные — они игнорируются`;
  } else if (current >= 0 && current !== localSeat && gone(current) && !m?.finished) {
    warn = true;
    if (n >= 3) {
      const since = Math.max(turnStartedAt.current, absentSince.current[current] ?? turnStartedAt.current);
      const wait = leftSeats.has(current) ? SKIP_LEFT_MS : SKIP_AFTER_MS;
      const left = Math.max(0, Math.ceil((wait - (performance.now() - since)) / 1000));
      statusText = `${name(current)} ${leftSeats.has(current) ? 'вышел из матча' : 'не в сети'} — ход пропустим${left > 0 ? ` через ${left} с` : ''}`;
    } else {
      statusText = leftSeats.has(current) ? `${name(current)} вышел из матча` : `${name(current)} не в сети — ждём переподключения…`;
    }
  } else if (goneOthers.length) {
    warn = true;
    statusText = `${listNames(goneOthers.map(name))} не в сети`;
  } else if (s?.netWaiting) {
    statusText = `Ждём данные броска: ${current >= 0 ? name(current) : ''}…`;
  } else if (s?.remoteAiming && current >= 0) {
    statusText = `${name(current)} целится…`;
  }

  const rematchInfo: OnlineRematch = {
    ready: iAmReady,
    readyNames: [...readySeats].filter((i) => !gone(i) && !inLobby(i)).map(name),
    waitingNames: stillHere.filter((i) => !readySeats.has(i) && !inLobby(i)).map(name),
    goneNames: goneOthers.map(name),
    lobbyNames: lobbySeats.map(name),
    possible: stillHere.length > 0 && !lobbySeats.length,
  };

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
          <div className={`hud__stats hud__stats--match hud__stats--p${n}`}>
            {config.players.map((_, seat) => (
              <PlayerCard key={seat} seat={seat as Seat} hud={m} offline={gone(seat)} />
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
        <div className={`net-status${warn ? ' net-status--warn' : ''}`} style={{ top: view.size.top + 52 }} role="status">
          {statusText}
        </div>
      )}
      {m && !result && <TurnBanner hud={m} y={view.w2s(0, 720).y} />}
      <div className="sr-only" aria-live="polite">
        {m ? (m.current === localSeat ? 'Ваш ход.' : `Ходит ${name(m.current)}.`) + ` Счёт: ${m.players.map((p) => `${p.name} ${p.knocked}`).join(', ')}.` : ''}
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
          <p className="modal__text">Пауза в онлайне не останавливает игру — остальные ждут вашего хода.</p>
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
          online={rematchInfo}
          newMatchLabel="В комнату"
          homeLabel="Выйти из комнаты"
          onRematch={onRematchClick}
          onNewMatch={toLobby}
          onHome={leave}
        />
      )}
    </div>
  );
}
