import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { MAX_PLAYERS } from '../game/rules/matchState';
import type { Seat } from '../game/types';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import { LIMITS, RATES, RateLimiter, StrikeCounter } from './limits';
import { CLIENT_ID_RE, type Envelope, type NetMessage, type PeerInfo, type RoomStage } from './protocol';
import { mustYieldSeat, pickFreeSeat, resolveSeats } from './seats';
import { parseEnvelope, parsePeer } from './validate';

/**
 * Комната онлайн-матча поверх Supabase Realtime (2–4 игрока).
 *
 * - broadcast — сообщения игроков (прицел, запись броска, синхронизация);
 * - presence — кто сейчас в комнате (имя, место за «столом», где он: в комнате ожидания, в матче или в итогах;
 *   у хозяина — кон следующего матча).
 * Базы данных и таблиц нет: сервер только пересылает сообщения.
 *
 * Всё входящее проходит «таможню» (см. `handleBroadcast`): размер → разбор и проверка → отправитель известен
 * (занимает место или входит в состав матча) → лимит частоты этого отправителя → его счётчик нарушений.
 * Недоверенные данные до игры не доходят, а один спамер не блокирует остальных игроков.
 */

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: {
        // прицел ~12/с + запись броска ~4/с; запас на всплески
        params: { eventsPerSecond: 40 },
        // сердцебиение соединения из Web Worker: фоновая вкладка не теряет связь из-за замедленных таймеров
        worker: true,
      },
    });
  }
  return client;
}

/**
 * - `full` — свободных мест нет (или моё место занято, а я хозяин);
 * - `busy` — в комнате идёт матч без меня: ждём его конца, место не занимаем.
 */
export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'full' | 'busy' | 'closed';

export interface RoomSnapshot {
  status: RoomStatus;
  /** Моё место (гость получает его после входа; null — ещё не занял). */
  seat: Seat | null;
  /** Все остальные участники комнаты (прошедшие проверку формата). */
  peers: PeerInfo[];
  /** Игроки по местам комнаты (кроме меня): индекс — место, null — свободно. */
  seats: (PeerInfo | null)[];
  /** id игроков, чьи сообщения временно игнорируются из-за потока некорректных данных. */
  bad: string[];
  /** Сколько в комнате посторонних (без места и не в составе матча). */
  intruders: number;
}

export interface MessageContext {
  from: string;
  /** Место отправителя в комнате (по закреплению, а не по его словам); null — известен только по составу матча. */
  seat: Seat | null;
}

/** Сколько сообщений от ещё не опознанного отправителя ждём появления его в presence. */
const PENDING_MAX = 60;
const PENDING_TTL_MS = 3_000;

const rooms = new Map<string, Room>();

/**
 * Один объект комнаты на пару «код + игрок». Повторный вызов (повторный рендер, горячая перезагрузка
 * модулей, быстрый выход и вход) возвращает тот же объект и отменяет его отложенное закрытие, поэтому
 * для одного кода никогда не создаётся два канала.
 */
export function getRoom(code: string, me: { clientId: string; seat: Seat | null; name: string }): Room {
  const key = `${code}:${me.clientId}`;
  let room = rooms.get(key);
  if (!room) {
    room = new Room(code, me, () => rooms.delete(key));
    rooms.set(key, room);
  }
  return room;
}

/** Учёт одного отправителя: лимиты частоты по типам сообщений и счётчик нарушений. */
interface SenderGuard {
  limiters: Map<string, RateLimiter>;
  strikes: StrikeCounter;
  timer: number | null;
}

export class Room {
  private channel: RealtimeChannel | null = null;
  private me: { clientId: string; seat: Seat | null; name: string; stage: RoomStage; layoutId: string | null };
  private snapshot: RoomSnapshot;
  private readonly messageHandlers = new Set<(msg: NetMessage, ctx: MessageContext) => void>();
  private readonly listeners = new Set<() => void>();
  private readonly seatListeners = new Set<(seat: Seat) => void>();
  private tracked = false;
  private closeTimer: number | null = null;
  /** Закреплённые места: место → id игрока. */
  private pins: (string | null)[] = Array.from({ length: MAX_PLAYERS }, () => null);
  /** Состав текущего матча (id по местам матча) — их сообщения принимаются, даже если место в комнате потеряно. */
  private roster: string[] | null = null;
  private readonly guards = new Map<string, SenderGuard>();
  private pending: { env: Envelope; at: number }[] = [];

  constructor(
    readonly code: string,
    me: { clientId: string; seat: Seat | null; name: string },
    private readonly onDisposed?: () => void,
  ) {
    this.me = { ...me, stage: 'lobby', layoutId: null };
    this.snapshot = { status: 'connecting', seat: me.seat, peers: [], seats: Array.from({ length: MAX_PLAYERS }, () => null), bad: [], intruders: 0 };
  }

  get clientId(): string {
    return this.me.clientId;
  }

  connect(): void {
    // повторное подключение сразу после close() (React StrictMode монтирует дважды) — оставляем канал
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.channel) return;
    const topic = `asyk-atu:${this.code}`;
    // страховка: в клиенте остался закрывающийся канал с тем же именем — дожидаемся его удаления
    const stale = getClient()
      .getChannels()
      .find((c) => c.topic === `realtime:${topic}`);
    if (stale) {
      void getClient()
        .removeChannel(stale)
        .then(() => this.connect());
      return;
    }
    const ch = getClient().channel(topic, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.me.clientId, enabled: true } },
    });

    ch.on('broadcast', { event: 'm' }, ({ payload }) => this.handleBroadcast(payload));
    ch.on('presence', { event: 'sync' }, () => this.onPresence(ch));

    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.set({ ...this.snapshot, status: this.snapshot.status === 'full' || this.snapshot.status === 'busy' ? this.snapshot.status : 'online' });
        // track — после первого снимка presence (выбор и проверка места); на переподключении — сразу
        if (this.tracked) this.track();
        else
          window.setTimeout(() => {
            if (!this.tracked && this.snapshot.status === 'online') this.onPresence(ch);
          }, 1200);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // realtime-js сам переподключается; показываем статус
        if (this.snapshot.status !== 'full') this.set({ ...this.snapshot, status: 'reconnecting' });
      } else if (status === 'CLOSED') {
        if (this.snapshot.status !== 'full') this.set({ ...this.snapshot, status: 'closed' });
      }
    });
    this.channel = ch;
  }

  private readPeers(ch: RealtimeChannel): PeerInfo[] {
    const byId = new Map<string, PeerInfo>();
    for (const list of Object.values(ch.presenceState())) {
      for (const raw of list as unknown[]) {
        const p = parsePeer(raw);
        if (p && p.clientId !== this.me.clientId) byId.set(p.clientId, p);
      }
    }
    return [...byId.values()];
  }

  private onPresence(ch: RealtimeChannel): void {
    const peers = this.readPeers(ch);
    let status = this.snapshot.status === 'connecting' ? 'online' : this.snapshot.status;

    if (!this.tracked) {
      if (this.me.seat === null) {
        // гость без места: пока идёт чужой матч — ждём; иначе занимаем свободное место
        if (peers.some((p) => p.busy)) {
          status = 'busy';
        } else {
          const free = pickFreeSeat(peers);
          if (free === null) status = 'full';
          else this.takeSeat(free);
        }
      } else if (this.me.seat === 0 && peers.some((p) => p.seat === 0)) {
        // хозяйское место занято другим: это не моя комната (или открыта вторая вкладка хозяина)
        status = 'full';
      } else if (this.me.seat !== 0 && peers.some((p) => p.seat === this.me.seat) && !this.roster) {
        // моё место гостя заняли, пока меня не было — ищу другое свободное
        const free = pickFreeSeat(peers); // моё прежнее место занято (оно среди мест пришедших)
        if (free === null) status = 'full';
        else this.takeSeat(free);
      }
      if (this.me.seat !== null && status !== 'full') {
        status = 'online';
        this.tracked = true;
        this.track();
      }
    } else if (!this.roster && mustYieldSeat(this.me.seat, this.me.clientId, peers)) {
      // два гостя одновременно сели на одно место: уступает тот, у кого id больше (то есть я)
      const free = pickFreeSeat(peers); // моё место занято тем, кому я уступаю
      if (free === null) status = 'full';
      else {
        this.takeSeat(free);
        this.track();
      }
    } else if (status === 'busy' && !peers.some((p) => p.busy)) {
      status = 'online';
    }

    // закрепление мест: моё место — только моё (самозванец на нём не получает голоса)
    const seats = resolveSeats(this.pins, peers);
    if (this.me.seat !== null) seats[this.me.seat] = null;
    this.pins = seats.map((p) => p?.clientId ?? null);
    const known = new Set([...this.pins.filter((x): x is string => !!x), ...(this.roster ?? [])]);
    const intruders = peers.filter((p) => !known.has(p.clientId)).length;
    this.set({ ...this.snapshot, status: status as RoomStatus, seat: this.me.seat, peers, seats, intruders });
    this.flushPending();
    if (status === 'full') void this.closeNow();
  }

  private takeSeat(seat: Seat): void {
    this.me = { ...this.me, seat };
    for (const l of this.seatListeners) l(seat);
  }

  private track(): void {
    const ch = this.channel;
    if (!ch || this.me.seat === null) return;
    const payload: PeerInfo = { clientId: this.me.clientId, seat: this.me.seat, name: this.me.name };
    if (this.me.stage === 'match') payload.busy = true;
    if (this.me.stage === 'results') payload.results = true;
    if (this.me.layoutId) payload.layoutId = this.me.layoutId;
    void ch.track(payload);
  }

  /** Отправитель известен: занимает место в комнате или входит в состав текущего матча. */
  private isKnown(id: string): boolean {
    return this.pins.includes(id) || (this.roster?.includes(id) ?? false);
  }

  private seatOf(id: string): Seat | null {
    const i = this.pins.indexOf(id);
    return i >= 0 ? (i as Seat) : null;
  }

  /**
   * «Таможня» входящих сообщений. Любая ошибка проверки — отбросить, не бросая исключений наружу;
   * слишком частые или некорректные сообщения копятся в счётчике нарушений отправителя.
   */
  private handleBroadcast(payload: unknown): void {
    // кто прислал (если поле похоже на id известного игрока) — чтобы засчитать нарушение именно ему
    const claimed = typeof payload === 'object' && payload !== null ? (payload as { from?: unknown }).from : undefined;
    const senderId = typeof claimed === 'string' && CLIENT_ID_RE.test(claimed) && this.isKnown(claimed) ? claimed : null;
    if (senderId && this.guard(senderId).strikes.isBlocked()) return; // пока заблокирован — ни разбора, ни нарушений
    if (typeof payload !== 'object' || payload === null) return;
    let size = 0;
    try {
      size = JSON.stringify(payload).length;
    } catch {
      return this.reject(senderId); // циклическая или необычная структура
    }
    if (size > LIMITS.maxEnvelopeBytes) return this.reject(senderId);
    const env = parseEnvelope(payload);
    if (!env) return this.reject(senderId);
    if (env.from === this.me.clientId) return;
    if (!this.isKnown(env.from)) {
      // отправитель ещё не появился в presence — подождём немного (порядок событий в сети не гарантирован)
      this.pending.push({ env, at: performance.now() });
      if (this.pending.length > PENDING_MAX) this.pending.shift();
      return;
    }
    this.dispatch(env);
  }

  private guard(id: string): SenderGuard {
    let g = this.guards.get(id);
    if (!g) {
      g = { limiters: new Map(), strikes: new StrikeCounter(), timer: null };
      this.guards.set(id, g);
    }
    return g;
  }

  private dispatch(env: Envelope): void {
    const g = this.guard(env.from);
    if (g.strikes.isBlocked()) return;
    let limiter = g.limiters.get(env.msg.t);
    if (!limiter) {
      const [rate, burst] = RATES[env.msg.t] ?? [2, 3];
      limiter = new RateLimiter(rate, burst);
      g.limiters.set(env.msg.t, limiter);
    }
    if (!limiter.take()) return this.reject(env.from);
    const ctx: MessageContext = { from: env.from, seat: this.seatOf(env.from) };
    for (const h of this.messageHandlers) {
      try {
        h(env.msg, ctx);
      } catch {
        // ошибка в обработчике не должна рвать приём следующих сообщений
      }
    }
  }

  private flushPending(): void {
    const now = performance.now();
    const items = this.pending;
    this.pending = [];
    for (const item of items) {
      if (now - item.at > PENDING_TTL_MS) continue;
      if (this.isKnown(item.env.from)) this.dispatch(item.env);
      else this.pending.push(item);
    }
  }

  /** Нарушение отправителя (если он известен). Набралось много — временная блокировка и отметка в снимке. */
  private reject(id: string | null): void {
    if (!id) return;
    const g = this.guard(id);
    if (g.strikes.strike() && !this.snapshot.bad.includes(id)) {
      this.set({ ...this.snapshot, bad: [...this.snapshot.bad, id] });
      this.armBadReset(id);
    }
  }

  /** Снять отметку «присылает мусор», когда блокировка закончилась (пока идёт — перезапускаем таймер). */
  private armBadReset(id: string): void {
    const g = this.guard(id);
    if (g.timer !== null) window.clearTimeout(g.timer);
    g.timer = window.setTimeout(() => {
      g.timer = null;
      if (g.strikes.isBlocked()) this.armBadReset(id);
      else if (this.snapshot.bad.includes(id)) this.set({ ...this.snapshot, bad: this.snapshot.bad.filter((x) => x !== id) });
    }, g.strikes.remainingMs() + 250);
  }

  /** Состав текущего матча (id по местам матча) или null вне матча. */
  setRoster(ids: string[] | null): void {
    this.roster = ids ? [...ids] : null;
    this.flushPending();
  }

  /**
   * Где я: в комнате ожидания, в матче или в итогах. Виден остальным: новичок не займёт место посреди матча,
   * а хозяин не начнёт следующий матч, пока кто-то ещё смотрит итоги.
   */
  setStage(stage: RoomStage): void {
    if (this.me.stage === stage) return;
    this.me = { ...this.me, stage };
    if (this.tracked) this.track();
  }

  /** Кон следующего матча (сообщает хозяин): гости видят его в комнате ожидания. */
  setLayout(layoutId: string | null): void {
    if (this.me.layoutId === layoutId) return;
    this.me = { ...this.me, layoutId };
    if (this.tracked) this.track();
  }

  /** Подписка на выбор места гостем (чтобы сохранить его в сессии и вернуться на него после перезагрузки). */
  onSeat(fn: (seat: Seat) => void): () => void {
    this.seatListeners.add(fn);
    return () => this.seatListeners.delete(fn);
  }

  send(msg: NetMessage): void {
    const ch = this.channel;
    if (!ch) return;
    const env: Envelope = { from: this.me.clientId, msg };
    void ch.send({ type: 'broadcast', event: 'm', payload: env });
  }

  onMessage(fn: (msg: NetMessage, ctx: MessageContext) => void): () => void {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): RoomSnapshot => this.snapshot;

  /**
   * Отложенное закрытие: realtime-js переиспользует канал с тем же именем, поэтому
   * мгновенное «закрыть и открыть заново» сломало бы подписку.
   */
  close(): void {
    if (!this.channel || this.closeTimer !== null) return;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      void this.closeNow();
    }, 150);
  }

  async closeNow(): Promise<void> {
    const ch = this.channel;
    this.channel = null;
    for (const g of this.guards.values()) if (g.timer !== null) window.clearTimeout(g.timer);
    if (ch) await getClient().removeChannel(ch);
    this.onDisposed?.();
  }

  private set(next: RoomSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}
