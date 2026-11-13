import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './config';

/**
 * Единственный клиент Supabase на всё приложение: комнаты (Realtime), вход через Google и коллекция асыков.
 *
 * В браузере есть только публичный ключ. Вход — по схеме PKCE: после Google игрок возвращается на сайт
 * с одноразовым кодом в адресе (`?code=…`), клиент сам обменивает его на сессию и убирает код из адреса.
 * Сессия хранится в localStorage этого браузера; права игрока определяет база (RLS), а не этот код.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
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
