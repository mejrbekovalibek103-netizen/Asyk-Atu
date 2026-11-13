import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from './client';
import { parseCollection, type OwnedAsyk } from './collection';

/**
 * Аккаунт игрока: вход через Google и коллекция асыков.
 *
 * Обычная онлайн-игра входа не требует; он нужен для коллекции и соревновательного режима.
 * Пароли игра не видит и не хранит: вход идёт на стороне Google и Supabase.
 */

export type AccountState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  /** Вошёл; коллекция загружается или загружена. `granted` — сколько стартовых асыков выдано при этом входе. */
  | { status: 'signedIn'; email: string; asyks: OwnedAsyk[] | null; granted: number }
  /** Вошёл, но база не ответила как надо (`setup` — в проекте ещё не выполнен SQL-скрипт). */
  | { status: 'error'; email: string; reason: 'setup' | 'provider' | 'network' };

/** Адрес, на который Google возвращает игрока: сам сайт без параметров и без #. */
function returnUrl(): string {
  return window.location.origin + window.location.pathname;
}

export async function signInWithGoogle(): Promise<boolean> {
  const { error } = await getSupabase().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnUrl() } });
  return !error; // при успехе браузер уходит на страницу входа Google
}

export async function signOut(): Promise<void> {
  // только это устройство: другие устройства игрока остаются в игре
  await getSupabase().auth.signOut({ scope: 'local' });
}

async function loadCollection(): Promise<{ asyks: OwnedAsyk[]; granted: number } | 'setup' | 'provider' | 'network'> {
  const sb = getSupabase();
  // первый вход: профиль и стартовые асыки (выдаёт сама база, один раз)
  const ensured = await sb.rpc('ensure_profile');
  if (ensured.error) {
    const code = ensured.error.code;
    if (code === '42501') return 'provider'; // вошли не через Google
    // функции или таблицы ещё нет в проекте
    if (code === 'PGRST202' || code === '42883' || code === '42P01') return 'setup';
    return 'network';
  }
  const rows = await sb.from('asyks').select('id, kind').order('id');
  if (rows.error) return rows.error.code === '42P01' || rows.error.code === 'PGRST205' ? 'setup' : 'network';
  const asyks = parseCollection(rows.data);
  if (!asyks) return 'network';
  const granted = typeof ensured.data === 'number' && Number.isInteger(ensured.data) && ensured.data > 0 ? ensured.data : 0;
  return { asyks, granted };
}

/** Состояние аккаунта для экрана: следит за входом и выходом, загружает коллекцию. */
export function useAccount(): { state: AccountState; reload: () => void } {
  const [state, setState] = useState<AccountState>({ status: 'loading' });
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // кто вошёл: первое событие приходит сразу после чтения сохранённой сессии (или обмена кода из адреса)
  useEffect(() => {
    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user ? (session.user.email ?? '') : null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (email === undefined) return;
    if (email === null) {
      setState({ status: 'signedOut' });
      return;
    }
    let alive = true;
    setState({ status: 'signedIn', email, asyks: null, granted: 0 });
    void loadCollection().then((r) => {
      if (!alive) return;
      setState(typeof r === 'string' ? { status: 'error', email, reason: r } : { status: 'signedIn', email, ...r });
    });
    return () => {
      alive = false;
    };
  }, [email, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, reload };
}
