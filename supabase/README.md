# Настройка входа через Google и базы игроков

Делается один раз владельцем проекта. Секреты вводятся **только** в панелях Google и Supabase —
в репозиторий, в `.env`, в переменные GitHub/Render и в чат они не попадают.

## 1. Google Cloud — клиент OAuth

1. Откройте <https://console.cloud.google.com/> и создайте проект (например, «Asyk Atu»).
2. **Google Auth Platform → Branding** (раньше «OAuth consent screen»): тип **External**, название игры,
   почта поддержки. Области доступа (scopes) оставьте стандартные: `openid`, `email`, `profile`.
3. **Audience → Publish app** (статус «In production»). Пока приложение в статусе «Testing», войти смогут
   только адреса, добавленные вручную в «Test users».
4. **Clients → Create client → Web application**:
   - **Authorized JavaScript origins:**
     `https://mejrbekovalibek103-netizen.github.io`, `https://asyk-atu.onrender.com`, `http://localhost:5173`
   - **Authorized redirect URIs:** адрес из Supabase — см. шаг 2.1 (вида
     `https://<ваш-проект>.supabase.co/auth/v1/callback`).
5. Сохраните. Google покажет **Client ID** и **Client secret** — они нужны на следующем шаге.

## 2. Supabase — провайдер Google

1. **Authentication → Sign In / Providers → Google**: включите, скопируйте оттуда **Callback URL**
   (его и нужно вставить в Google на шаге 1.4), вставьте **Client ID** и **Client secret**, сохраните.
2. Там же: провайдер **Email** — выключить; **Anonymous sign-ins** — выключить.
   «Allow new users to sign up» должен быть **включён**: иначе новые игроки не смогут войти через Google.
3. **Authentication → URL Configuration**:
   - **Site URL:** `https://mejrbekovalibek103-netizen.github.io/Asyk-Atu/`
   - **Redirect URLs** (добавить все три):
     `https://mejrbekovalibek103-netizen.github.io/Asyk-Atu/`, `https://asyk-atu.onrender.com/`,
     `http://localhost:5173/`

   Игрок после входа возвращается только на адреса из этого списка — чужой сайт получить вход не сможет.

## 3. Supabase — таблицы и функции

1. **SQL Editor → New query**, вставьте весь файл [`schema.sql`](schema.sql), нажмите **Run**.
   Должно быть «Success. No rows returned». Скрипт можно запускать повторно.
2. Проверьте в **Table Editor**: появились таблицы `profiles` и `asyks`, у обеих отметка **RLS enabled**.

## 4. Проверка

Откройте игру → «Онлайн игра» → «Моя коллекция асыков» → «Войти через Google».
После входа должно показать «10 асыков» и приветствие. При повторном входе — те же 10, без новой выдачи.

## 5. Соревновательный режим «на асыки»

Подробный проект — [`docs/competitive-mode.md`](../docs/competitive-mode.md) (раздел 0.1 — окончательные решения).
Матч на 2–4 игроков, каждый ставит 5 асыков (кон из 10 / 15 / 20); вдвоём по 15 бросков, втроём и вчетвером по 10; ход 45 с.
На проверке готовности тот, кто вышел или не подтвердил «Я здесь», получает ставку назад, а остальные играют без него
(если их двое и больше и они в сети; иначе матч отменяется с возвратом).

### 5.1 Таблицы и функции

1. Сначала должен быть выполнен [`schema.sql`](schema.sql) (шаг 3).
2. **SQL Editor → New query**, вставьте весь файл [`competitive.sql`](competitive.sql), нажмите **Run**.
   Должно быть «Success. No rows returned». Скрипт можно запускать повторно (в том числе после правок):
   данные он не удаляет.
3. **SQL Editor → New query**, вставьте весь файл [`competitive.check.sql`](competitive.check.sql), **Run**.
   Ожидается таблица из 23 сценариев со словом **PASS** и последняя строка **ALL PASS**.
   Если что-то не так, скрипт закончится ошибкой `competitive.check: FAIL — …` со списком сценариев.
   Проверка создаёт тестовых пользователей и матчи, но в конце всё откатывает: в базе ничего не остаётся.
4. Проверьте в **Table Editor**: появились `comp_matches`, `comp_players`, `comp_stakes`, `comp_throws`,
   `asyk_transfers`, у всех отметка **RLS enabled**. Схема `private` (секреты матчей) в API не видна — так и должно быть.

Что появилось:
- у `profiles` — колонки `comp_played` (сыграно матчей) и `banned` (бан режима: поставить `true` вручную в Table Editor);
- у `asyks` — колонки `locked_match` (асык «в коне» матча) и `acquired_at`;
- у `comp_matches` — счётчик `players_rev`: растёт при любой смене состава лобби и матча;
- журнал `asyk_transfers`: кто у кого выиграл какой асык (игрокам напрямую не виден, история — функция `my_comp_history`);
- в схеме `private`: секреты матчей, счётчик вызовов броска и список исключённых из лобби (`comp_kicked`).

### 5.2 Realtime

- **Realtime → Settings**: «публичные каналы» (*Allow public access*) оставить **включёнными** — на них работают обычные комнаты.
- У матча два закрытых канала, их защищают политики на `realtime.messages` (создаёт `competitive.sql`).
  Слушать оба могут только участники:
  - `comp:<id матча>` — игроки пишут сюда только присутствие; запись броска (`srv`) шлёт только серверная функция;
  - `comp-aim:<id матча>` — линия прицела (`aim`) от игроков.

  Разделение нужно потому, что Realtime проверяет право писать один раз при входе в канал и не видит,
  какое событие будет отправлено: в одном канале нельзя было бы разрешить `aim` и запретить поддельный `srv`.
- `competitive.sql` сам добавляет таблицу `comp_matches` в публикацию `supabase_realtime`
  (**Database → Publications**): по ней клиент узнаёт о смене хода, состава (`players_rev`) и раздаче
  и перечитывает `comp_state`. Таблицы `comp_players` в публикации быть **не должно** — скрипт сам её убирает:
  удаления строк Realtime рассылает всем подписчикам, без проверки прав.

### 5.3 Уборка зависших матчей (по желанию)

Без неё зависшие матчи убираются сами, когда кто-то из игроков снова откроет матч.
Если включить расширение **pg_cron** (**Database → Extensions**), можно убирать раз в 5 минут:

```sql
select cron.schedule('comp-expire-stale', '*/5 * * * *', $$select private.comp_expire_stale(100)$$);
```

### 5.3.1 Ферма стартовых асыков (ручная проверка)

Лимитов на пары соперников и возраст аккаунта нет (решение 0.1), поэтому один человек может завести несколько
Google-аккаунтов и «сливать» их стартовые асыки на основной. Видно это по журналу `asyk_transfers`:
пары, где асыки почти всегда уходят в одну сторону. **SQL Editor → New query**:

```sql
select t.from_user, t.to_user,
       count(*) as asyks,
       count(distinct t.match_id) as matches,
       coalesce((select count(*) from public.asyk_transfers b
                 where b.from_user = t.to_user and b.to_user = t.from_user), 0) as back,
       min(t.at) as first_at, max(t.at) as last_at
from public.asyk_transfers t
group by t.from_user, t.to_user
having count(*) >= 10
order by asyks desc
limit 50;
```

Подозрительно, когда у одного `to_user` много разных `from_user` с `back = 0`, а аккаунты-доноры свежие
(`auth.users.created_at`). Бан — вручную: `profiles.banned = true` в **Table Editor**. Автоматических лимитов
нет, пока владелец не решит иначе.

### 5.4 Серверная функция comp-throw

В соревновательном режиме бросок считает сервер, а не браузер: функция `supabase/functions/comp-throw/index.ts`.
Физика лежит рядом в `sim.js`: это тот же код, что в игре, его собирает `npm run build:edge`.
Что делает функция на каждый бросок:
1. Проверяет сайт (CORS) и тело запроса `{ matchId, throwNo, angle, power }` (не больше 1 КБ).
2. Узнаёт игрока по его токену входа.
3. Вызывает `comp_count_call`: не больше 30 бросков в минуту на игрока, отклонённые тоже считаются.
4. Вызывает `comp_begin_throw`: чей ход, номер броска, срок. Оттуда же берёт секрет матча для разброса.
5. Считает бросок, записывает его через `comp_apply_throw` и рассылает запись в канал `comp:<id матча>`.

**Ставить ничего не нужно, кроме Node.js.** Supabase CLI запускается через `npx`.
Команды выполняются в Git Bash из папки проекта.

1. Войдите в Supabase CLI:
   ```bash
   npx supabase login
   ```
   Откроется браузер. Если браузер не открылся, CLI попросит токен доступа: его создают в панели
   **Account → Access Tokens** и вставляют **только в терминал**. В чат, файлы и git токен не попадает.
2. Привяжите папку к проекту. `<ref>` — это id проекта, часть адреса `https://<ref>.supabase.co`, его же видно
   в **Project Settings → General**:
   ```bash
   npx supabase link --project-ref <ref>
   ```
   Если CLI спросит пароль базы, нажмите Enter: для деплоя функции он не нужен.
   CLI создаст папку `supabase/.temp/`. Секретов в ней нет, но в git она не нужна.
3. Соберите физику и выложите функцию:
   ```bash
   npm run build:edge
   npx supabase functions deploy comp-throw --no-verify-jwt
   ```
   Если CLI пишет, что нужен Docker, добавьте `--use-api`: тогда функция собирается на стороне Supabase.
   Если CLI не находит привязку к проекту, добавьте `--project-ref <ref>`.

   **Почему `--no-verify-jwt` безопасно.** Флаг выключает только проверку токена на входе в Supabase, до функции.
   Функция сама проверяет токен каждого запроса через `auth.getUser`. Без токена или с чужим токеном она отвечает
   401 и к базе не обращается. Мусор и просроченные токены отсекаются ещё до запроса в Auth (форма, срок, роль). Служебные функции базы (`comp_begin_throw` и другие) доступны только служебному ключу,
   а он есть только внутри функции. Входная проверка всё равно мешала бы: предзапрос браузера (`OPTIONS`) приходит
   без токена, и Supabase отклонял бы его ещё до функции. Тогда браузер не дал бы сайту вызвать функцию вообще.
4. Проверьте ключи. **Edge Functions → Secrets**: там должны быть `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY`
   (или `SUPABASE_SECRET_KEYS` для новых ключей `sb_secret_…`). Supabase добавляет их сам, вводить ничего не нужно.
   Функция берёт `SUPABASE_SERVICE_ROLE_KEY`, а если его нет — ключ `default` из `SUPABASE_SECRET_KEYS`.
   Если ключа нет совсем, функция отвечает 503 `{"error":"config"}`.
5. Проверьте функцию через curl (подставьте `<ref>`):
   ```bash
   # предзапрос браузера: ждём 204 и строку Access-Control-Allow-Origin: http://localhost:5173
   curl -i -X OPTIONS "https://<ref>.supabase.co/functions/v1/comp-throw" \
     -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST"
   # бросок без входа: ждём 401 и {"error":"not_signed_in"}
   curl -i -X POST "https://<ref>.supabase.co/functions/v1/comp-throw" -H "Content-Type: application/json" \
     -d '{"matchId":"00000000-0000-0000-0000-000000000000","throwNo":1,"angle":0,"power":1}'
   ```
   Настоящий бросок проверяется только из игры, с двух браузеров. Журнал функции открывается в
   **Edge Functions → comp-throw → Logs**. Там пишутся только коды и время, без почт и ключей.

   **Откуда проверять.** Функция пускает только сайты из списка `ALLOWED_ORIGINS` (`src/game/sim/edgeHttp.ts`):
   опубликованный сайт (GitHub Pages, Render) и `http://localhost` / `http://127.0.0.1` на любом порту.
   С телефона через `npm run dev:lan` (адрес вида `http://192.168.x.x:5173`) броски **не пройдут**: браузер получит
   отказ CORS, и игра скажет «Нет связи». Лобби и ставка при этом работают — это не поломка сервера.
   Проверку с телефона делайте на опубликованном сайте.

**Порядок выкладки: сначала функция, потом сайт.** Новый сайт зовёт функцию, поэтому функция должна уже работать.
После любого изменения в `src/game/` (физика, раскладки кона, цикл броска) повторите `npm run build:edge` и деплой.
Если меняется сам результат броска, поднимите `SIM_VERSION` (`src/game/sim/version.ts`) и число в
`private.comp_sim_version()` в `competitive.sql`. Выполните `competitive.sql` заново, затем выложите функцию и сайт.
Матчи, начатые на старой версии, функция аннулирует и возвращает ставки: ответ 410 `{"error":"version"}`.
Версию поднимают, чтобы бросок, начатый на старой физике, не досчитался на новой.

Если позже появится `supabase/config.toml` (команда `npx supabase init`), добавьте туда строки ниже.
С ними деплой без флага тоже отключит входную проверку:
```toml
[functions.comp-throw]
verify_jwt = false
```

Ответы функции:

| Код | Ответ | Когда |
|---|---|---|
| 200 | `{ throwNo, duplicate, start, chunks, end, knocked, next }` | бросок посчитан и записан; повтор того же броска даёт тот же результат и `duplicate: true` (если записан другой запрос того же броска — например, из второй вкладки, — в ответе именно записанный бросок) |
| 401 | `not_signed_in` | нет токена или он неверный |
| 403 | `origin`, `banned`, `no_profile`, `not_member` | чужой сайт, бан, нет профиля, не участник |
| 404 | `not_found` | матча нет |
| 409 | `not_active`, `not_your_turn`, `stale_throw`, `deadline`, `forfeited`, `not_pending` | не твой ход, бросок устарел или время вышло |
| 410 | `version` | версия физики сменилась, матч аннулирован с возвратом ставок |
| 413 / 422 | `too_large` / `bad_body`, `bad_match`, `bad_throw_no`, `bad_angle`, `bad_power` | неверное тело запроса |
| 429 | `rate_limited` | больше 30 бросков в минуту |
| 500 / 503 | `server` / `config` | сбой сервера или не настроено окружение |

## 6. Рейтинг и ник игрока

1. SQL Editor → вставить `supabase/rating.sql` → Run (после `competitive.sql`; повторный запуск безопасен).
2. Затем `supabase/rating.check.sql` → Run. Ожидается 5 сценариев **PASS** и строка **ALL PASS**.
   Сценарии проверяют, что игрок не может изменить ни свой, ни чужой профиль и асыки напрямую,
   гость видит только рейтинг, в ответах нет почты и внутренних id, ник проверяется и меняется только свой.

Что видно в рейтинге: место, ник (или «Игрок N»), асыки, победы, сыгранные матчи. Свой ID (номер игрока) и
счёт игрок видит на странице «Рейтинг». Почта нигде в игре не показывается.

## 7. Таблица «сколько асыков у игроков» (только для владельца)

1. SQL Editor → вставить `supabase/admin.sql` → Run (после `rating.sql`). В конце — сообщение
   «admin.sql: PASS» и сразу сама таблица.
2. Потом смотреть в Table Editor: вверху слева схема **private** → **asyk_counts** (по игрокам) или
   **asyk_totals** (сводка по всей игре). Или в SQL Editor: `select * from private.asyk_counts;`

Это представление: числа считаются из настоящих асыков при каждом открытии и всегда точные. Изменить через
него ничего нельзя — асыки меняет игра или владелец запросами ниже (SQL Editor, вместо почты — почта игрока):

```sql
-- добавить 10 асыков
insert into public.asyks (owner)
select u.id from auth.users u join public.profiles p on p.id = u.id
cross join generate_series(1, 10)
where u.email = 'почта@gmail.com';

-- забрать 3 свободных (асыки в коне не трогаются)
delete from public.asyks where id in (
  select a.id from public.asyks a join auth.users u on u.id = a.owner
  where u.email = 'почта@gmail.com' and a.locked_match is null
  order by a.id desc limit 3);
```
В нём есть почта игроков, поэтому оно закрыто от игроков и гостей (схема private, права только у владельца).

## Что где хранится

| Что | Где | Секрет? |
|---|---|---|
| Адрес проекта и публичный ключ Supabase | `.env`, переменные GitHub и Render | нет, они видны в коде сайта |
| Client ID Google | панель Supabase | нет |
| **Client secret Google** | **только панель Supabase** | **да** |
| **Секретный ключ Supabase (`service_role`)** | **только окружение Edge Function `comp-throw` в Supabase** (подставляет сам Supabase); в репозитории, `.env` и браузере его нет | **да** |
| Секрет матча (разброс бросков) | таблица `private.comp_secrets`, игрокам не выдаётся | да |
