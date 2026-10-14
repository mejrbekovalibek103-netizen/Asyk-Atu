import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Seat } from '../game/types';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import { LIMITS, RATES, RateLimiter, StrikeCounter } from './limits';
import type { Envelope, NetMessage, PeerInfo } from './protocol';
import { parseEnvelope, parsePeer } from './validate';

/**
 * Комната онлайн-матча поверх Supabase Realtime.
 *
 * - broadcast — сообщения игроков (прицел, запись броска, синхронизация);
 * - presence — кто сейчас в комнате (имя и место за «столом»).
 * Базы данных и таблиц нет: сервер только пересылает сообщения.
 *
 * Всё входящее проходит «таможню» (см. `handleBroadcast`): размер → разбор и проверка → закреплённый
 * отправитель → лимит частоты → счётчик нарушений. Недоверенные данные до игры не доходят.
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

export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'full' | 'closed';

export interface RoomSnapshot {
  status: RoomStatus;
  /** Все остальные участники комнаты (прошедшие проверку формата). */
  peers: PeerInfo[];
  /** Закреплённый соперник — единственный, чьи сообщения принимаются. */
  peer: PeerInfo | null;
  /** Соперник присылает слишком много некорректных данных: временно игнорируется. */
  badPeer: boolean;
  /** Сколько в комнате посторонних (кроме двух игроков). */
  intruders: number;
}

export interface MessageContext {
  from: string;
  /** Место отправителя (определено по закреплённому соперника, а не заявлено в сообщении). */
  seat: Seat;
}

/** Сколько сообщений от ещё не опознанного отправителя ждём появления его в presence. */
const PENDING_MAX = 30;
const PENDING_TTL_MS = 3_000;

const rooms = new Map<string, Room>();

/**
 * Один объект комнаты на пару «код + игрок». Повторный вызов (повторный рендер, горячая перезагрузка
 * модулей, быстрый выход и вход) возвращает тот же объект и отменяет его отложенное закрытие, поэтому
 * для одного кода никогда не создаётся два канала.
 */
export function getRoom(code: string, me: PeerInfo): Room {
  const key = `${code}:${me.clientId}`;
  let room = rooms.get(key);
  if (!room) {
    room = new Room(code, me, () => rooms.delete(key));
    rooms.set(key, room);
  }
  return room;
}

export class Room {
  private channel: RealtimeChannel | null = null;
  private snapshot: RoomSnapshot = { status: 'connecting', peers: [], peer: null, badPeer: false, intruders: 0 };
  private readonly messageHandlers = new Set<(msg: NetMessage, ctx: MessageContext) => void>();
  private readonly listeners = new Set<() => void>();
  private tracked = false;
  private closeTimer: number | null = null;
  private pinnedId: string | null = null;
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly strikes = new StrikeCounter();
  private badTimer: number | null = null;
  private pending: { env: Envelope; at: number }[] = [];

  constructor(
    readonly code: string,
    readonly me: PeerInfo,
    private readonly onDisposed?: () => void,
  ) {}

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

    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState();
      const byId = new Map<string, PeerInfo>();
      for (const list of Object.values(state)) {
        for (const raw of list as unknown[]) {
          const p = parsePeer(raw);
          if (p && p.clientId !== this.me.clientId) byId.set(p.clientId, p);
        }
      }
      const peers = [...byId.values()];
      // в комнате уже есть игрок на моём месте — значит, это не моя партия (третий лишний)
      if (!this.tracked && peers.some((p) => p.seat === this.me.seat)) {
        this.set({ ...this.snapshot, status: 'full', peers });
        void this.closeNow();
        return;
      }
      // соперник закрепляется за первым, кто занял противоположное место, и остаётся им, пока в комнате:
      // позже пришедший с тем же местом не может «перехватить» игру
      const opposite = peers.filter((p) => p.seat !== this.me.seat);
      let peer = this.pinnedId ? (opposite.find((p) => p.clientId === this.pinnedId) ?? null) : null;
      if (!peer) {
        peer = opposite[0] ?? null;
        this.pinnedId = peer?.clientId ?? null;
      }
      this.set({ ...this.snapshot, peers, peer, intruders: peers.length - (peer ? 1 : 0) });
      if (peer) this.flushPending();
      if (!this.tracked && this.snapshot.status === 'online') {
        this.tracked = true;
        void ch.track(this.me);
      }
    });

    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.set({ ...this.snapshot, status: 'online' });
        // track — после первого снимка presence (проверка «место занято»); на переподключении — сразу
        if (this.tracked) void ch.track(this.me);
        else
          window.setTimeout(() => {
            if (!this.tracked && this.snapshot.status === 'online') {
              this.tracked = true;
              void ch.track(this.me);
            }
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

  /**
   * «Таможня» входящих сообщений. Любая ошибка проверки — отбросить, не бросая исключений наружу;
   * слишком частые или некорректные сообщения копятся в счётчике нарушений.
   */
  private handleBroadcast(payload: unknown): void {
    // пока соперник заблокирован, не тратим на него время: ни разбора, ни новых нарушений
    if (this.strikes.isBlocked()) return;
    if (typeof payload !== 'object' || payload === null) return this.reject();
    let size = 0;
    try {
      size = JSON.stringify(payload).length;
    } catch {
      return this.reject(); // циклическая или необычная структура
    }
    if (size > LIMITS.maxEnvelopeBytes) return this.reject();
    const env = parseEnvelope(payload);
    if (!env) return this.reject();
    if (env.from === this.me.clientId) return;
    if (!this.pinnedId) {
      // отправитель ещё не появился в presence — подождём немного (порядок событий в сети не гарантирован)
      this.pending.push({ env, at: performance.now() });
      if (this.pending.length > PENDING_MAX) this.pending.shift();
      return;
    }
    if (env.from !== this.pinnedId) return; // посторонний в комнате — молча игнорируем
    this.dispatch(env);
  }

  private dispatch(env: Envelope): void {
    if (this.strikes.isBlocked()) return;
    let limiter = this.limiters.get(env.msg.t);
    if (!limiter) {
      const [rate, burst] = RATES[env.msg.t] ?? [2, 3];
      limiter = new RateLimiter(rate, burst);
      this.limiters.set(env.msg.t, limiter);
    }
    if (!limiter.take()) return this.reject();
    const peer = this.snapshot.peer;
    if (!peer) return;
    const ctx: MessageContext = { from: env.from, seat: peer.seat };
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
    for (const { env, at } of items) {
      if (now - at <= PENDING_TTL_MS && env.from === this.pinnedId) this.dispatch(env);
    }
  }

  private reject(): void {
    const blocked = this.strikes.strike();
    if (blocked && !this.snapshot.badPeer) {
      this.set({ ...this.snapshot, badPeer: true });
      this.armBadPeerReset();
    }
  }

  /** Снять отметку «соперник присылает мусор», когда блокировка закончилась (пока идёт — перезапускаем таймер). */
  private armBadPeerReset(): void {
    if (this.badTimer !== null) window.clearTimeout(this.badTimer);
    this.badTimer = window.setTimeout(() => {
      this.badTimer = null;
      if (this.strikes.isBlocked()) this.armBadPeerReset();
      else if (this.snapshot.badPeer) this.set({ ...this.snapshot, badPeer: false });
    }, this.strikes.remainingMs() + 250);
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
    if (this.badTimer !== null) window.clearTimeout(this.badTimer);
    if (ch) await getClient().removeChannel(ch);
    this.onDisposed?.();
  }

  private set(next: RoomSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}
