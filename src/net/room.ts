import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import type { Envelope, NetMessage, PeerInfo } from './protocol';

/**
 * Комната онлайн-матча поверх Supabase Realtime.
 *
 * - broadcast — сообщения игроков (прицел, запись броска, синхронизация);
 * - presence — кто сейчас в комнате (имя и место за «столом»).
 * Базы данных и таблиц нет: сервер только пересылает сообщения.
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
  /** Другие игроки в комнате (без меня). */
  peers: PeerInfo[];
}

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
  private snapshot: RoomSnapshot = { status: 'connecting', peers: [] };
  private readonly messageHandlers = new Set<(msg: NetMessage, from: string) => void>();
  private readonly listeners = new Set<() => void>();
  private tracked = false;
  private closeTimer: number | null = null;

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

    ch.on('broadcast', { event: 'm' }, ({ payload }) => {
      const env = payload as Envelope;
      if (!env || env.from === this.me.clientId || !env.msg) return;
      for (const h of this.messageHandlers) h(env.msg, env.from);
    });

    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<PeerInfo>();
      const byId = new Map<string, PeerInfo>();
      for (const list of Object.values(state)) {
        for (const p of list) {
          if (p.clientId && p.clientId !== this.me.clientId) byId.set(p.clientId, { clientId: p.clientId, seat: p.seat, name: p.name });
        }
      }
      const peers = [...byId.values()];
      // в комнате уже есть игрок на моём месте — значит, это не моя партия (третий лишний)
      if (!this.tracked && peers.some((p) => p.seat === this.me.seat)) {
        this.set({ status: 'full', peers });
        void this.closeNow();
        return;
      }
      this.set({ ...this.snapshot, peers });
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
        else window.setTimeout(() => {
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

  send(msg: NetMessage): void {
    const ch = this.channel;
    if (!ch) return;
    const env: Envelope = { from: this.me.clientId, msg };
    void ch.send({ type: 'broadcast', event: 'm', payload: env });
  }

  onMessage(fn: (msg: NetMessage, from: string) => void): () => void {
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
    if (ch) await getClient().removeChannel(ch);
    this.onDisposed?.();
  }

  private set(next: RoomSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}
