import { defineConfig } from 'vite';

/**
 * Сборка серверной физики для Edge Function соревновательного режима: `npm run build:edge`.
 *
 * Библиотечный режим Vite (без новых пакетов): src/game/sim/edgeEntry.ts вместе с matter-js собирается в ОДИН
 * ES-модуль supabase/functions/comp-throw/sim.js. Функция (Deno) импортирует его как обычный файл — без npm и CDN,
 * поэтому сервер считает бросок ровно тем кодом, что и игра. Модуль не трогает window/document.
 *
 * После любого изменения физики, раскладок STAKE_LAYOUTS или цикла броска: поднять SIM_VERSION (src/game/sim/version.ts),
 * пересобрать и задеплоить функцию заново.
 */
export default defineConfig({
  // папка public (иконки, манифест) серверу не нужна
  publicDir: false,
  build: {
    lib: {
      entry: 'src/game/sim/edgeEntry.ts',
      formats: ['es'],
      fileName: () => 'sim.js',
    },
    outDir: 'supabase/functions/comp-throw',
    // в этой папке лежит и сама функция (index.ts) — не стираем её
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'es2022',
    // читаемый файл: его удобно проверять глазами и искать в нём секреты (их там быть не может)
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
});
