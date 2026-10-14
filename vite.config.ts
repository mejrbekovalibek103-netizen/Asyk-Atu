import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Политика безопасности контента (CSP) для production-сборки.
 *
 * GitHub Pages не позволяет задавать HTTP-заголовки, поэтому политика кладётся в <meta> — так её понимают
 * все браузеры (кроме директив frame-ancestors, report-uri и sandbox: их можно задать только заголовком,
 * см. SECURITY.md для Render).
 *
 * Что разрешено: свой код и шрифты, соединения только со своим сайтом и с проектом Supabase (Realtime —
 * это WebSocket на тот же хост), Web Worker из blob (его создаёт realtime-js для сердцебиения соединения).
 * Запрещено всё остальное: чужие скрипты, inline-скрипты, eval, плагины (object), чужие формы и <base>.
 * Если XSS-уязвимость когда-нибудь появится, внедрённый скрипт не сможет ни выполниться, ни отправить данные
 * на чужой сервер.
 */
function cspPlugin(supabaseUrl: string | undefined): Plugin {
  const host = (() => {
    try {
      return supabaseUrl ? new URL(supabaseUrl).host : null;
    } catch {
      return null;
    }
  })();
  const connect = ["'self'", ...(host ? [`https://${host}`, `wss://${host}`] : [])].join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "manifest-src 'self'",
  ].join('; ');
  return {
    name: 'asyk-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
  };
}

// base: './' — относительные пути, чтобы сборка работала на любом статическом
// хостинге (GitHub Pages в подпапке, Vercel, Netlify) без перенастройки.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    base: './',
    plugins: [react(), cspPlugin(env.VITE_SUPABASE_URL)],
    // Ничего не встраиваем в CSS/JS как data:-адреса (по умолчанию так делают маленькие шрифты).
    // Это позволяет оставить CSP строгим: font-src 'self' без data:.
    build: { assetsInlineLimit: 0 },
    // Сервер разработки слушает только localhost. Для проверки с телефона: `npm run dev:lan`
    // (открывает сервер для всей локальной сети — делайте это только в доверенной сети).
  };
});
