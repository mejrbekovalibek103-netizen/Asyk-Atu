// Поиск секретов в файлах репозитория: запускается в CI перед сборкой и вручную (`npm run check:secrets`).
// В проекте может быть только ПУБЛИЧНЫЙ ключ Supabase. Всё остальное сюда попасть не должно:
// секретный ключ Supabase, секрет клиента Google, приватные ключи, файл .env.
// Найденное значение не печатается — только файл, строка и вид секрета.
// `node scripts/check-secrets.mjs dist` — проверить только папку (собранный сайт: его проверяет `npm run build`,
// чтобы секрет, по ошибке вставленный в переменную VITE_…, не ушёл в публичный бандл ни на Pages, ни на Render).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const RULES = [
  ['секретный ключ Supabase (sb_secret_…)', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['секрет клиента Google (GOCSPX-…)', /GOCSPX-[A-Za-z0-9_-]{16,}/],
  ['приватный ключ', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['ключ Google API (AIza…)', /AIza[0-9A-Za-z_-]{35}/],
  ['токен доступа Supabase CLI (sbp_…)', /sbp_[0-9a-f]{40}/],
  ['строка подключения к базе с паролем', /postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s]+@/],
];
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

/** JWT с ролью service_role — старый формат секретного ключа Supabase. */
function isServiceRoleJwt(payload) {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}

/** Все файлы папки (рекурсивно), пути через «/» — как у git. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(path) : e.isFile() ? [path] : [];
  });
}

// Файлы git и всё из supabase/functions/: код серверной функции и собранный sim.js проверяются, даже если
// их ещё нет в git, — оттуда секрет ушёл бы при деплое функции.
const only = process.argv[2];
if (only && !existsSync(only)) {
  console.error(`Папка ${only} не найдена.`);
  process.exit(1);
}
const files = only
  ? walk(only.replace(/\\/g, '/').replace(/\/+$/, ''))
  : [...new Set([...execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean), ...walk('supabase/functions')])];
const found = [];

for (const file of files) {
  if (/(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(file)) found.push(`${file}: файл с переменными окружения не должен быть в git`);
  if (/\.(png|jpg|jpeg|webp|woff2?|ico|gif)$/i.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // файл удалён в рабочей папке
  }
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line)) found.push(`${file}:${i + 1}: ${name}`);
    for (const m of line.matchAll(JWT)) if (isServiceRoleJwt(m[1])) found.push(`${file}:${i + 1}: секретный ключ Supabase (service_role)`);
  });
}

if (found.length) {
  console.error('Найдены секреты в репозитории:\n' + found.map((f) => '  ' + f).join('\n'));
  console.error('Удалите секрет из файла, а сам ключ перевыпустите: в истории git он уже мог сохраниться.');
  process.exit(1);
}
console.log(`Секретов не найдено (проверено файлов: ${files.length}).`);
