# Соревновательный режим «на асыки»: итоговый проект

Проект подготовлен до начала работ (ноябрь 2026): три независимых варианта, проверка каждого «взломщиком», итоговый вариант собран из лучшего. Где написано «проверено в коде», утверждение сверено с файлами проекта.

## 0. Коротко о том, что уже сделано

Оба пункта сделаны:
1. Игра на одном устройстве и игра по сети разделены.
2. 10 асыков выдаются один раз за вход через Google. Это делает функция `ensure_profile` в `supabase/schema.sql`. Она проверяет `app_metadata.provider = 'google'`, а это поле игрок подделать не может.

На момент начала работы эти изменения ещё не закоммичены: `src/net/account.ts`, `collection.ts`, `client.ts`, `CollectionScreen.tsx` и папка `supabase/` не добавлены в git. Кроме того, `schema.sql` нужно один раз выполнить в Supabase (SQL Editor).

Сейчас самое правильное — заняться механикой соревновательного режима. Страница рейтинга и аккаунта потом будет брать данные из функций, которые появятся на этом шаге (`leaderboard`, `my_comp_history`).

## 1. Решение простыми словами

**Сервер-судья и сервер-банк.**
- **Банк (база Postgres).** Перед матчем каждый игрок ставит 5 асыков. Асыки никуда не переносятся, база просто ставит на них отметку «в коне матча X». Одну и ту же фишку нельзя поставить в два матча. После матча база сама раздаёт асыки: выбитый асык получает тот, кто его выбил, невыбитый возвращается хозяину. Всё это делается одной операцией, повторить или подделать её нельзя.
- **Судья (Edge Function `comp-throw`, это TypeScript на сервере Supabase).** В соревновательном режиме устройство игрока **не считает результат броска**. Оно отправляет только «угол и силу». Сервер сам считает бросок тем же кодом физики, что и в игре (Matter.js), добавляет случайный разброс из секрета, которого браузер не знает, и записывает результат в базу. Все устройства, в том числе бросающего, просто проигрывают запись, присланную сервером.
- **Обычный онлайн-режим остаётся как есть**, работает без входа и по тому же коду. Соревновательный режим живёт отдельно, по адресу `#/comp/<код>`.

**Почему выбран этот вариант.** Я сравнил три проекта, и у каждого была своя критика:

| Вариант | Идея | Что нашла проверка | Итог |
|---|---|---|---|
| «Безопасность прежде всего» | сервер пересчитывает каждый бросок | дыры в правах доступа и мелкие ошибки, все исправимы | **основа** |
| «Согласие игроков» | бросок считает телефон, игроки подтверждают итог | **критично:** можно подать фальшивый итог и тянуть время; можно выбить жертву из матча сообщением `start`/`sync`; проигравший может аннулировать матч | отклонён |
| «Свидетели пересчитывают» | телефоны соперников пересчитывают бросок | **критично:** бросающий подделывает конечные позиции асыков; можно перебрасывать без конца | отклонён |

Почему телефоны не могут проверять друг друга, проверено в коде:
- `GameEngine` запускает сақу через `RELEASE_DELAY_MS = 90` мс по настенным часам.
- Физика шагает и в фазе READY.
- В `throwRecord.ts` прямо написано, что браузеры по-разному округляют вычисления.

Поэтому два устройства никогда не получат одинаковый бросок. Честно посчитать бросок может только одно место — сервер.

Из двух других проектов я взял:
- из проекта 2: журнал переходов асыков, лимиты на пары игроков, отметку «в коне» в коллекции, простую разметку кона;
- из проекта 3: метку-тамгу цвета хозяина на асыке, экран итогов «Твой улов / Вернулись / Ушли», окно ставки с понятными правилами.

## 2. Как это выглядит для игрока

1. **Создание.** Игрок вошёл через Google и у него есть хотя бы 5 свободных асыков. Он нажимает «Матч на асыки» и получает код или ссылку. Без входа кнопка предлагает войти. Если асыков меньше 5, кнопка серая с подписью «У тебя 3, нужно 5».
2. **Вход по ссылке.** Без входа через Google присоединиться нельзя. Обычные комнаты по-прежнему открываются без входа.
3. **Ставка.** Окно с правилами:
   - «Что выбьешь — твоё, даже чужое».
   - «Невыбитые вернутся».
   - «Выход из матча = твои асыки остаются в коне».
   - «До старта ставку можно забрать».

   Кнопка «Поставить 5». В коллекции эти асыки помечаются значком «в коне».
4. **Старт.** Хозяин нажимает «Бросить жребий». Порядок ходов и места асыков в коне выбирает сервер, хозяин повлиять на них не может. Дальше идёт проверка готовности: за 60 секунд каждый игрок должен подтвердить, что он здесь. Если кто-то не подтвердил, матч отменяется и ставки возвращаются.
5. **Ход.** Игрок целится. Соперники видят прицел, это только картинка. Игрок отпускает, рука делает выброс, сервер считает бросок (0,2–0,5 с, при «холодном» старте до 1,5 с, всё это время виден индикатор «Бросок…»). Затем все видят одинаковый бросок. На каждый ход даётся 45 секунд, таймер считает база по своим часам.
6. **Конец.** Кон опустел или закончились броски. База сразу раздаёт асыки. На экране итогов три раздела: «Твой улов», «Вернулись», «Ушли» и значок итога вроде «+3». Коллекция обновляется.
7. **Уход.**
   - «Сдаться» или закрытая вкладка означают, что ходы игрока пропускаются, а после 3 пропусков подряд засчитывается сдача.
   - Его асыки остаются в коне, и их можно выбить.
   - Выходом нельзя спасти ставку, поэтому бросать матч от злости бессмысленно.

## 3. Защита: угроза, что делаем, что остаётся

| Угроза | Защита | Остаток |
|---|---|---|
| Изменённый клиент врёт о результате броска | результат считает только сервер; клиент присылает угол и силу, сервер их проверяет | нет |
| Подделка записей в базу публичным ключом | у таблиц нет прав на запись; все изменения идут через функции, которые сами проверяют `auth.uid()`; служебные функции явно закрыты от `anon/authenticated`; внутренние лежат в схеме `private`, которую API не видит; на каждую есть SQL-тест «вызов от игрока → отказ» | нет |
| Одна ставка в двух матчах | у асыка одна колонка `locked_match`; `UPDATE … WHERE locked_match IS NULL … FOR UPDATE SKIP LOCKED`, ровно 5 строк, иначе отказ; один активный матч на аккаунт (частичный уникальный индекс) | нет |
| Повторная раздача асыков | раздача — это переход статуса `active → settled` под блокировкой строки; переносятся только асыки, где `locked_match = матч`; у журнала есть ключ `unique(asyk_id, match_id)` | нет |
| Гонки (два клика, две вкладки) | блокировка строки матча; номер броска `throw_no + 1`; первичный ключ `(match_id, throw_no)` | нет |
| Выход назло, перезагрузка, обрыв связи | ставка с начала матча под замком; пропуск хода по часам базы, затем сдача; при перезагрузке `comp_rebind` и состояние берётся из базы | нет |
| Соперник пропускает мой ход, пока бросок считается | функция ставит отметку «бросок принят» (`pending_at`) до дедлайна; пропуск запрещён, пока отметке меньше 20 с; у дедлайна запас 5 с | нет |
| Подставной «отсутствующий» гость (хозяин стартует, пока гость в WhatsApp) | проверка готовности: каждый жмёт «Я здесь» за 60 с, это автоматически делает экран матча при видимой вкладке; иначе отмена с возвратом | нет |
| Поддельные анимации в канале от другого участника | закрытый канал `comp:<id>`; клиентам разрешено отправлять только событие `aim`; запись броска шлёт сам сервер событием `srv`; в конце хода всё сверяется с базой; «штрафы отправителю» в этом режиме выключены | только чужая линия прицела |
| Бот-прицел (клиент перебирает углы на своей копии физики) | **полностью не устранить ни при какой архитектуре:** у браузера есть физика и кон. Смягчение: разброс в соревновательном режиме шире (решение владельца), разброс берётся из серверного секрета на каждый бросок, статистика попаданий по аккаунтам и SQL-запрос «подозрительные» | остаётся, малый ущерб при ставке в 5 асыков |
| Фермы аккаунтов и сговор (новый аккаунт дарит асыки основному) | Google с проверкой провайдера через `app_metadata`; возраст профиля ≥ 24 ч проверяется **во всех** функциях входа и ставки; одна пара игроков — не больше 3 матчей в сутки; потолок выигрыша с «новичков» (10 асыков в неделю на получателя, остальное возвращается хозяину); журнал переводов; флаг `banned` | медленное «выкачивание» терпеливым фермером |
| Исчерпание квоты Edge Function (спам вызовами) | ранний отказ до расчёта, лимит вызовов на игрока, мониторинг в панели, флаг `banned`. Если сбой сервера задел ходы **двух и больше разных** игроков, матч аннулируется с возвратом ставок; один игрок так матч не сорвёт | квота может закончиться, асыки не теряются |
| Пауза бесплатного проекта Supabase | `comp_settle_stale` и, по желанию, pg_cron: зависшие матчи раздаются по уже выбитому, несобранные отменяются с возвратом | асыки «в коне» до пробуждения проекта |

## 4. Решения владельца (с моими рекомендациями)

1. **Разрешить серверную функцию (Edge Function)?** Рекомендую **да**. Без неё честный бросок невозможен (см. раздел 1). Запасной вариант без неё: все игроки подтверждают каждый бросок, при расхождении матч аннулируется. Он не даёт украсть асыки, но проигравший сможет срывать матчи. Ключ `service_role` при этом живёт **только внутри функции**: Supabase подставляет его сам, в репозитории и в браузере его нет.
2. **Невыбитые асыки в конце.** Рекомендую **возвращать хозяину** (так понимаю правило «каждый забирает выбитое»). Другой вариант — отдавать лучшему игроку матча.
3. **Сдача в матче на двоих.** Рекомендую: асыки сдавшегося остаются в коне, оставшийся добивает своими бросками. Строже: всё невыбитое сразу отходит победителю.
4. **Разброс броска в соревновательном режиме.** Рекомендую **в 2 раза шире обычного**: угол 0,7–1,8° вместо 0,35–0,9°, сила ±3% вместо ±1,5% (текущие значения проверены в `config.ts`). Это мешает ботам и почти незаметно человеку.
5. **Защита от ферм.** Рекомендую: соревновательный режим открывается через 24 ч после первого входа; не больше 3 матчей в сутки на пару игроков; не больше 10 асыков в неделю, выигранных у «новичков» (профиль моложе 7 дней или меньше 5 сыгранных матчей). Минус: изредка честный игрок не получит асык, выбитый у новичка.
6. **Таймер хода и сдача.** Рекомендую 45 с на ход и сдачу после 3 пропусков подряд. В обычном режиме остаются нынешние 20 с.

## 5. Что владельцу нужно будет сделать в Supabase

1. Выполнить `supabase/competitive.sql` в SQL Editor (как `schema.sql`, повторный запуск безопасен).
2. Задеплоить функцию: `npx supabase functions deploy comp-throw`. Пароли и ключи никуда копировать не нужно.
   - Проект использует **новые ключи** (`VITE_SUPABASE_PUBLISHABLE_KEY`). С ними встроенная проверка JWT на шлюзе может отклонять вызовы.
   - Поэтому функция сама проверяет токен игрока (`auth.getUser`/`getClaims`), а деплой при необходимости идёт с `--no-verify-jwt`.
   - Название служебного ключа (`SUPABASE_SERVICE_ROLE_KEY` или новые `SUPABASE_SECRET_KEYS`) проверяем в панели на шаге 0 плана.
3. Оставить включёнными «публичные каналы» Realtime: на них работают обычные комнаты. Закрытый соревновательный канал защищён политиками из SQL.
4. По желанию включить pg_cron для уборки зависших матчей.

## 6. План работ (каждый шаг проверяемый, обычный режим не ломается)

| № | Шаг | Готово, когда… | Время |
|---|---|---|---|
| 0 | Пробная проверка платформы: функция-заглушка, закрытый канал с политикой «клиенту разрешён только `aim`», рассылка от функции | два браузера: чужой не может подписаться, клиентский `srv` отклоняется, серверный доходит; вызов с publishable-ключом проходит | 0,5 дня |
| 1 | `runThrow` (чистая функция), свой генератор случайных чисел, `SIM_VERSION` | тесты: тот же seed даёт тот же результат 1000 раз, в том числе после создания других миров; «золотой» тест закрепляет выбитые асыки | 1–2 дня |
| 2 | Раскладки 5·N (10/15/20) | тесты раскладок и решаемости | 0,5 дня |
| 3 | `competitive.sql` и сценарии `competitive.check.sql` | все сценарии раздела 7.6 проходят в SQL Editor | 2–3 дня |
| 4 | Edge Function и сборка `build:edge` | матч из двух тестовых аккаунтов через curl до раздачи; повтор того же броска возвращает тот же результат | 1–2 дня |
| 5 | Сеть клиента: `competitive.ts`, закрытый канал в `Room`, подписка на изменения | тесты разборщиков | 2 дня |
| 6 | Движок в режиме «сервер решает», `CompetitiveRules`, тамга цвета хозяина | бросок в браузере идёт через сервер | 2 дня |
| 7 | Экраны: лобби, матч, итоги, значок «в коне», маршрут `#/comp/…` | полный матч в двух браузерах | 3 дня |
| 8 | Живая проверка по чек-листу | см. раздел 7.7 | 2 дня |

Итого примерно 2–3 недели работы по вечерам. После шагов 1–3 можно параллельно делать нижнюю навигацию: главная, коллекция, рейтинг и аккаунт. Для рейтинга подходят `leaderboard()` и `my_comp_history()`: они не показывают почты и id других игроков.

---

# Технический раздел

## 7.1 Что проверено в коде и на что это влияет

- `simulate.ts` вызывает `throwParams(aim, Math.random, false)` (без разброса) и `checkKnockouts(zone, 1)`, но не делает `drainContacts` и `removeFaded`. Поэтому `runThrow` нужно делать **по образцу `GameEngine.fixedStep`**: `step → drainContacts → removeFaded → checkKnockouts(zone, throwNo) → recorder.onStep → settle(PHYS.settleMs=220) / stopAll при PHYS.maxThrowMs=9000`. После этого `simulate.ts` становится тонкой обёрткой.
- `throwParams(aim, rng, jitter)` уже принимает rng. Разброс берётся из `THROW_JITTER`; для соревновательного режима нужен параметр множителя.
- `PHYS.maxAimAngle = 78° = 1,3614 рад`. Проверяем **запрошенный** угол (до разброса) ровно по этой константе, а не по «±1,37».
- В `PhysicsWorld` есть `Events.on(...)` и `destroy()`. `runThrow` обязан вызывать `destroy()` в `finally`, иначе в «тёплой» функции будет утечка памяти. В Matter есть глобальный счётчик id (`Common._nextId`), поэтому перед сборкой мира его нужно обнулять и проверять тестом детерминизм после других миров.
- `room.ts`: тема канала зашита как `asyk-atu:${code}`, `broadcast.self=false`, отправитель (`env.from`) указывается самим клиентом. Нужна опция `{ private: true, topic: 'comp:<id>' }` и заданный состав игроков (`setRoster` уже есть). Код обычного режима не меняется.
- `MatchRules.skipTurn` работает только при n ≥ 3, а `onKnockout` защищён по `p.id`. В соревновательном режиме эти решения принимает база, а `CompetitiveRules` только импортирует её состояние.
- Тесты vitest идут в Node без DOM. Значит, Matter.js работает без браузера, и так же он будет работать в Deno.
- `markOut` оставляет выбитому асыку столкновение со стенами. В серверной модели это не важно: выбитость определяют события `checkKnockouts` на сервере.

## 7.2 SQL: `supabase/competitive.sql` (основное)

Общие правила файла:
- Каждая функция объявлена `security definer set search_path = ''`.
- Функции pgcrypto пишутся с префиксом: `extensions.gen_random_bytes`, `extensions.hmac`.
- Supabase по умолчанию выдаёт права на новые объекты, поэтому **на каждую таблицу и функцию** явно делается `revoke all … from public, anon, authenticated`.
- Порядок блокировок всегда один: строка матча, затем асыки по возрастанию id.

```sql
create schema if not exists private;          -- PostgREST эту схему не публикует
revoke all on schema private from public, anon;
grant usage on schema private to authenticated; -- нужно только для функций-помощников в RLS

alter table public.profiles
  add column if not exists display_name text check (display_name is null or char_length(display_name) between 2 and 16),
  add column if not exists rating int not null default 1000,
  add column if not exists comp_played int not null default 0,
  add column if not exists banned boolean not null default false;

create table if not exists public.comp_matches (
  id uuid primary key default gen_random_uuid(),
  join_code text not null unique check (join_code ~ '^[A-HJKMNP-Z2-9]{10}$'),
  host uuid not null,                         -- без FK: удаление аккаунта не блокируется
  layout_id text not null check (layout_id in ('stake-line','stake-scatter','stake-ring')),
  sim_version int not null,
  status text not null default 'forming'
    check (status in ('forming','ready','active','settled','cancelled','void')),
  players smallint check (players between 2 and 4),
  current_seat smallint, throw_no int not null default 0,
  kon_state jsonb,                            -- округлённый AsykState[] после последнего броска
  last_throw jsonb,                           -- {throw_no, angle, power, kon_before} — только для повтора
  turn_deadline timestamptz, ready_deadline timestamptz,
  pending_by uuid, pending_at timestamptz,    -- «бросок принят сервером»
  created_at timestamptz not null default now(), started_at timestamptz,
  updated_at timestamptz not null default now(), settled_at timestamptz, end_reason text
);

alter table public.asyks
  add column if not exists locked_match uuid references public.comp_matches(id) on delete set null,
  add column if not exists acquired_at timestamptz not null default now();
create index if not exists asyks_locked_idx on public.asyks(locked_match) where locked_match is not null;
create index if not exists asyks_owner_free_idx on public.asyks(owner) where locked_match is null;

create table if not exists private.comp_secrets (       -- отдельно: postgres_changes шлёт строки целиком
  match_id uuid primary key references public.comp_matches(id) on delete cascade,
  seed bytea not null default extensions.gen_random_bytes(32)
);

create table if not exists public.comp_players (
  match_id uuid not null references public.comp_matches(id) on delete cascade,
  user_id uuid not null,
  lobby_slot smallint not null check (lobby_slot between 0 and 3),
  seat smallint check (seat between 0 and 3),            -- 0..N-1 подряд, назначается в comp_start
  client_id text not null check (client_id ~ '^[0-9a-f]{16}$'),
  display_name text not null,
  staked boolean not null default false, ready boolean not null default false,
  forfeited boolean not null default false, active boolean not null default true,
  throws int not null default 0, real_throws int not null default 0, knocked int not null default 0,
  best_combo int not null default 0, skips_in_row int not null default 0,
  joined_at timestamptz not null default now(),
  primary key (match_id, user_id), unique (match_id, lobby_slot), unique (match_id, seat)
);
create unique index if not exists comp_one_active on public.comp_players(user_id) where active;

create table if not exists public.comp_stakes (
  match_id uuid not null references public.comp_matches(id) on delete cascade,
  slot smallint not null,                                  -- = Piece.index в движке
  asyk_id bigint references public.asyks(id) on delete set null,
  owner_user uuid not null, owner_seat smallint not null,
  knocked_by_seat smallint, knocked_throw int,
  primary key (match_id, slot), unique (match_id, asyk_id)
);

create table if not exists public.comp_throws (           -- около 100 байт на строку, только добавление
  match_id uuid not null references public.comp_matches(id) on delete cascade,
  throw_no int not null, seat smallint not null, user_id uuid not null,
  kind text not null check (kind in ('throw','skip','fail')),
  angle real, power real, knocked smallint[] not null default '{}', steps int,
  created_at timestamptz not null default now(),
  primary key (match_id, throw_no)
);

create table if not exists public.asyk_transfers (
  id bigint generated always as identity primary key,
  asyk_id bigint not null, from_user uuid not null, to_user uuid not null,
  match_id uuid not null, at timestamptz not null default now(),
  unique (asyk_id, match_id)
);
create table if not exists private.comp_calls (user_id uuid, minute timestamptz, calls int not null default 0,
  primary key (user_id, minute));
```

**RLS.** Рекурсии нет: членство проверяет функция-помощник, а не подзапрос к той же таблице.

```sql
create or replace function private.is_comp_member(p_match uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.comp_players where match_id = p_match and user_id = (select auth.uid())) $$;
revoke all on function private.is_comp_member(uuid) from public, anon;
grant execute on function private.is_comp_member(uuid) to authenticated;

-- для каждой из comp_matches(id), comp_players, comp_stakes, comp_throws:
alter table … enable row level security;
revoke all on … from anon, authenticated;
grant select on … to authenticated;
create policy "comp: участники читают" on … for select to authenticated
  using (private.is_comp_member(match_id));               -- для comp_matches: (id)
-- asyk_transfers: select using (from_user = (select auth.uid()) or to_user = (select auth.uid()))
-- private.*: никаких прав
alter publication supabase_realtime add table public.comp_matches, public.comp_players;
```

**Закрытый канал Realtime.** Клиенты могут отправлять только прицел и присутствие. Событие `srv` шлёт функция, её запросы политиками не ограничиваются.

```sql
create or replace function private.is_comp_topic_member(p_topic text) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
declare id_txt text := substr(p_topic, 6);
begin
  if p_topic not like 'comp:%' or id_txt !~ '^[0-9a-f-]{36}$' then return false; end if;
  return exists (select 1 from public.comp_players p join public.comp_matches m on m.id = p.match_id
    where m.id = id_txt::uuid and p.user_id = (select auth.uid())
      and (m.status in ('forming','ready','active') or m.settled_at > now() - interval '10 minutes'));
end $$;
create policy "comp: читать" on realtime.messages for select to authenticated
  using (private.is_comp_topic_member(realtime.topic()));
create policy "comp: писать только прицел" on realtime.messages for insert to authenticated
  with check (private.is_comp_topic_member(realtime.topic())
    and (realtime.messages.extension = 'presence'
         or (realtime.messages.extension = 'broadcast' and realtime.messages.event = 'aim')));
```

Политику по колонке `event` проверяем на шаге 0 плана.

**Общая проверка вызывающего** `private.comp_caller() returns uuid`:
- uid не null, иначе 28000;
- `app_metadata.provider = 'google'` (не `user_metadata`, его игрок может менять);
- профиль существует, `banned = false`;
- возраст профиля ≥ 24 ч (`private.comp_min_age()`).

Её вызывают **все** функции для игроков, в том числе `comp_join` и `comp_stake`.

**Функции для игроков** (`grant execute … to authenticated`):

| Функция | Ключевая логика |
|---|---|
| `comp_open(p_layout text, p_client_id text, p_name text) → (match_id uuid, join_code text)` | имя очищается как в `cleanName`; у вызывающего нет активной строки; лимит 20 созданий в час; код из `extensions.gen_random_bytes`; вставка матча, секрета и хозяина в `lobby_slot 0`; `sim_version = private.comp_sim_version()`; `ready_deadline = now() + 20 min` (срок жизни лобби) |
| `comp_join(p_code, p_client_id, p_name) → (match_id, lobby_slot)` | `for update`; статус `forming`; игроков меньше 4; свободный `lobby_slot` с наименьшим номером |
| `comp_rebind(p_match, p_client_id) → jsonb` | только участник, статус `forming/ready/active`; перезаписывает `client_id` (последняя вкладка побеждает); возвращает `comp_state` |
| `comp_kick(p_match, p_lobby_slot)` | хозяин, `forming`; снимает замок с асыков исключённого и удаляет его строку |
| `comp_stake(p_match, p_ids bigint[] default null) → bigint[]` | `forming`, ещё не поставил: `update asyks set locked_match = p_match where id in (select id from asyks where owner = uid and locked_match is null and (p_ids is null or id = any(p_ids)) order by id limit 5 for update skip locked)`; `row_count <> 5` → откат с ошибкой `not_enough`; `staked = true`. Повторный вызов возвращает уже поставленные |
| `comp_leave(p_match)` | `forming`: снять замок и **удалить** строку; если это хозяин, то `private.comp_refund(p_match, 'cancelled')` |
| `comp_start(p_match)` | хозяин, `forming`; пара игроков не больше 3 раз за 24 ч (по `comp_players` и `comp_matches`); не поставившие удаляются; нужно 2–4 поставивших. Места: `row_number() over (order by extensions.hmac(user_id::text, seed, 'sha256'))-1` → 0..N-1 подряд, первым ходит место 0. Слоты: перестановка 5·N асыков по `hmac('slot'‖asyk_id, seed)`. Статус `ready`, `ready_deadline = now() + 60 s` |
| `comp_ready(p_match)` | `ready = true`; если готовы все: `active`, `current_seat = 0`, `turn_deadline = now() + 45 s`, `started_at` |
| `comp_skip(p_match, p_throw_no)` | любой участник; `active`, `p_throw_no = throw_no + 1`; `now() >= turn_deadline + 5 s`; нет `pending_at` моложе 20 с. Если `pending_at` есть, но бросок не записан: строка `kind = 'fail'` (сбой сервера, пропуском не считается); иначе `kind = 'skip'`, `skips_in_row += 1`, при 3 подряд `forfeited`. Дальше переход хода и, если матч закончен, раздача |
| `comp_forfeit(p_match)` | только за себя, `active`: `forfeited = true`; если сейчас его ход, ход переходит сразу |
| `comp_settle_stale(p_match)` | участник: `active` и `updated_at < now() − 15 min` → раздача (`stale`); `ready`/`forming` после срока → возврат ставок |
| `comp_state(p_match) → jsonb` | матч без секрета, игроки (место, имя, флаги, счёт), слоты (слот → место хозяина, id асыков только свои), последний бросок. Попутно лениво отменяет просроченный `ready` |
| `set_display_name(text)`, `leaderboard(p_limit) → (display_name, rating, comp_played)`, `my_comp_history(p_limit)` | без почт и чужих uuid |

**Служебные функции** (`revoke … from public, anon, authenticated; grant execute … to service_role`). Их вызывает только Edge Function:

`comp_begin_throw(p_match uuid, p_user uuid, p_throw_no int) → jsonb`
- `select … for update` на матч.
- Если `last_throw.throw_no = p_throw_no` и строка броска принадлежит `p_user`, возвращает `{replay: last_throw}`. Эта проверка идёт до проверки статуса, поэтому повтор работает и после раздачи.
- Иначе проверяет:
  - `status = 'active'`;
  - место игрока равно `current_seat`, он не сдался;
  - `p_throw_no = throw_no + 1`;
  - `now() <= turn_deadline + 5 s` или собственный свежий `pending_at`;
  - лимит 30 вызовов в минуту (`private.comp_calls`).
- Ставит `pending_by/pending_at = now()`.
- Возвращает `seed` (hex), `kon_state`, `layout_id`, `players`, `sim_version`.

`comp_apply_throw(p_match, p_user, p_throw_no, p_angle real, p_power real, p_kon_before jsonb, p_final jsonb, p_knocked smallint[], p_steps int) → jsonb`
- Блокировка. Если такой бросок уже записан, возвращает сохранённое (идемпотентность).
- Требует `pending_by = p_user`, `active`, `p_throw_no = throw_no + 1`.
- Проверки:
  - `abs(p_angle) <= 1.3614`, сила в [min, 1];
  - в `p_final` ровно 5·N записей с конечными числами;
  - `p_knocked` — это слоты, которые в `kon_state` ещё в коне, и они помечены выбитыми в `p_final`;
  - нет «воскрешений»;
  - `cardinality(p_knocked) <= 5·N` (потолка в 8 нет: сервер доверенный).
- Вставка в `comp_throws`; `update comp_stakes set knocked_by_seat = cur, knocked_throw = p_throw_no where slot = any(p_knocked) and knocked_by_seat is null`.
- Счёт игрока, `real_throws += 1`, `skips_in_row = 0`.
- `last_throw = {throw_no, angle, power, kon_before}`, `kon_state = p_final`, `throw_no += 1`, `pending_* = null`.
- Следующий ход: следующее по кругу место, игрок не сдался и броски у него не кончились (15 на двоих, 10 на 3–4 игроков).
- `turn_deadline = now() + p_steps * 1000/120 ms + 45 s`: дедлайн начинается после показа броска.
- Если кон пуст или броски кончились у всех, раздача в той же транзакции.

`comp_void_version(p_match)`: при несовпадении `sim_version` вызывает `private.comp_refund(p_match, 'version')`.

**Внутренние функции** (схема `private`, никому не выданы):

`private.comp_settle(p_match, p_reason)`
- Требует `status = 'active'`, иначе выход.
- Если сбои `kind = 'fail'` задели **два и больше разных места**, вызывается `comp_refund(p_match, 'server')`.
- Иначе для каждой строки `comp_stakes` по возрастанию `asyk_id`:
  - `winner = coalesce(игрок места knocked_by_seat, owner_user)`;
  - если `winner <> owner_user` и превышен `private.young_cap(owner_user, winner)` или у победителя больше нет профиля, то `winner = owner_user`;
  - `update asyks set owner = winner, locked_match = null, acquired_at = now() where id = asyk_id and locked_match = p_match`;
  - запись в `asyk_transfers … on conflict do nothing`.
- Страховка: `update asyks set locked_match = null where locked_match = p_match`.
- `comp_players.active = false`, `comp_played += 1`.
- Рейтинг меняется только если у каждого не сдавшегося игрока ≥ 5 настоящих бросков.
- `status = 'settled'`, `settled_at`, `end_reason`.

`private.comp_refund(p_match, p_reason)`: снять все замки, всем `active = false`, статус `cancelled` (до старта) или `void`.

`private.comp_expire_stale()`: для pg_cron, `order by id … for update skip locked`, порциями. В `comp_open` и `comp_join` **не вызывается**.

## 7.3 Edge Function `supabase/functions/comp-throw/index.ts` (Deno, TypeScript)

```
POST { matchId: uuid, throwNo: int, angle: number, power: number }
1. CORS; строгая проверка тела (типы, конечные числа).
2. jwt = Authorization → user = await admin.auth.getUser(jwt)   (или getClaims); нет → 401.
3. ctx = rpc('comp_begin_throw', {p_match, p_user, p_throw_no}); отказ → 409/403 с кодом.
4. if ctx.sim_version !== SIM_VERSION → rpc('comp_void_version'); 410 «обновите страницу».
5. если ctx.replay: angle/power/konBefore = из replay, иначе из запроса и ctx.kon_state.
6. aim = aimFromAnglePower(clamp(angle, ±PHYS.maxAimAngle), power); невалидно → 422.
7. key = HMAC-SHA256(seed, `${matchId}:${throwNo}`) через crypto.subtle; rng = sfc32(key).
8. params = throwParams(aim, rng, true, COMP_JITTER_SCALE).
9. rec = runThrow(stakeLayout(layout_id, players), konBefore, params)
       → { start, chunks, end, knocked, steps }   (ThrowRecorder, тот же формат)
10. next = rpc('comp_apply_throw', {…, p_kon_before: konBefore, p_final: rec.end.final, …})
    (запись завершается и при обрыве клиента: EdgeRuntime.waitUntil)
11. Одним HTTP-запросом в Realtime REST (/realtime/v1/api/broadcast, private: true):
    сообщения event 'srv' в topic 'comp:<id>': start, chunks…, end.
12. Ответ бросающему: { start, chunks, end, knocked, next }.
```

Сборка: `vite.edge.config.ts` (библиотечный режим Vite, без новых пакетов) собирает `src/game/sim/edgeEntry.ts` в один файл `supabase/functions/comp-throw/sim.js` с matter-js внутри. `scripts/check-secrets.mjs` дополнительно проверяет `supabase/functions/`.

## 7.4 Изменения протокола

- Новый закрытый канал `comp:<matchId>` (`config: { private: true, presence: { key: clientId } }`, перед подпиской `realtime.setAuth`).
  - От клиента: только `aim` (до 8 в секунду) и присутствие.
  - От сервера: `srv` = `{k:'start', throwNo, angle, power} | {k:'chunk', throwNo, seq, frames, events} | {k:'end', throwNo, steps, final, saka, knocked}`. Разбор теми же проверками, что в `validate.ts` (`parseThrowChunk` и т. п.).
- Изменения в базе (`postgres_changes` на `comp_matches id=eq.X`, `comp_players match_id=eq.X`) — это сигнал начала матча, смены хода, дедлайна и раздачи. Запасной путь при переподключении — `comp_state` каждые 5 с.
- В соревновательном режиме **не используются** `start`, `sync`, `syncRequest`, `skip`, реванш, `decideSync` и штрафы отправителям. Значит, атаки «выбить жертву сообщением start/sync» здесь нет по построению.
- Клиент буферизует итоговое состояние кона из базы до конца проигрывания записи. Если запись не пришла за 3 с, он сразу применяет `kon_state`.

## 7.5 Изменения в файлах клиента

Новые файлы:
- `src/game/sim/runThrow.ts`
- `src/game/sim/rng.ts` (sfc32)
- `src/game/sim/version.ts`
- `src/game/sim/edgeEntry.ts`
- тесты: детерминизм, «золотые» результаты, совпадение с нынешней логикой `fixedStep`
- `src/net/competitive.ts`: обёртки RPC и `submitThrow` с повтором по тому же `throwNo` через 8 с, разборщики ответов, хук `useCompMatch`; тесты к нему
- `src/game/rules/CompetitiveRules.ts`
- `src/ui/screens/CompetitiveLobbyScreen.tsx`
- `src/ui/screens/CompetitiveMatchScreen.tsx`
- `src/ui/game/StakeModal.tsx`
- `src/ui/screens/CompResultOverlay.tsx`
- `supabase/competitive.sql`, `supabase/competitive.check.sql`
- `supabase/functions/comp-throw/index.ts`, `vite.edge.config.ts`

Изменяемые файлы:
- `src/game/physics/simulate.ts` → обёртка над `runThrow`.
- `aim.ts` → множитель разброса.
- `src/game/levels/matchLayouts.ts` → `STAKE_LAYOUTS` (`build(n)` ровно 5n; `stake-line` 10 / 8+7 / 10+10 с шагом 59; `stake-scatter` через `scattered(5n)`; `stake-ring` через `ring(5n, …)`), `isStakeLayout`, тесты раскладок и решаемости.
- `GameEngine.ts` → режим `authority: 'server'`: `requestThrow(aim)`, ответ идёт в существующий путь `remoteThrowStart/Chunk/End`; `applyCanonical(konState)`.
- `Renderer.ts` и `asykShape.ts` → тамга цвета `PLAYER_STYLE[ownerSeat]` и точки 1–4 для дальтоников.
- `room.ts` → опции `private` и `topic`; посадка игроков из базы, без логики `pickFreeSeat`/`mustYieldSeat`.
- `routes.ts` и тесты → `#/comp/<code>`.
- `MatchSetupScreen.tsx`, `MenuScreen.tsx` → вход в режим (только после входа через Google).
- `account.ts` → `select id, kind, locked_match`; сохранять маршрут `#/comp/…` через редирект Google (сейчас адрес возврата теряет хеш).
- `collection.ts` → флаг `locked`; `canStake` считает только свободные.
- `CollectionScreen.tsx` → значок «в коне» со ссылкой на матч.

## 7.6 Сценарии для `competitive.check.sql`

Пользователь имитируется через `set local role authenticated; set local request.jwt.claims = …`. Сценарии:
1. Вызов `comp_apply_throw`, `comp_begin_throw`, `comp_void_version` и `private.*` от `authenticated` и `anon` → 42501.
2. Чтение `private.comp_secrets` → отказ.
3. Двойная ставка (дважды и в два матча) → отказ.
4. Ставка при 4 асыках → `not_enough`.
5. Чужой ход или неверный `throw_no` → отказ.
6. Повтор `comp_apply_throw` → тот же результат, без двойного зачёта.
7. Повторная раздача → без изменений.
8. `comp_skip` раньше дедлайна плюс 5 с или при свежем `pending_at` → отказ.
9. 3 пропуска → сдача.
10. Просроченная проверка готовности → возврат ставок.
11. `comp_settle_stale`.
12. Сбои у двух мест → возврат ставок.
13. Потолок «новичков» и лимит пары.
14. Удаление аккаунта посреди матча не ломает раздачу.

## 7.7 Чек-лист живой проверки (2–4 браузера, в том числе телефон)

- Закрыть вкладку во время броска.
- Перезагрузить страницу во время чужого хода.
- Двойной клик по броску.
- Медленная сеть (throttling).
- «Холодный» старт функции.
- Сдача.
- Пропуск по дедлайну.
- Не нажать «Я здесь».
- Хозяин выходит в лобби.
- Вторая вкладка того же аккаунта.
- После каждого случая сверить число асыков в Table Editor.

## 7.8 Остаточные риски (честно)

1. Боты-прицелы. Не устраняются без запрета клиентской физики. Смягчены разбросом из серверного секрета и статистикой.
2. Терпеливые фермы и сговор. Замедлены возрастом аккаунта, лимитами и журналом, но полностью не исключены. Асыкам никогда не стоит давать денежную ценность. Если позже появится пополнение за рекламу, на него нужен суточный лимит.
3. Ошибка в серверной логике может неверно раздать асыки. Её можно разобрать по журналам `comp_throws` и `asyk_transfers`; до запуска нужны SQL-тесты.
4. Рассинхронизация версий сайта и функции: матч со старой `sim_version` аннулируется с возвратом. Порядок выкладки: сначала функция, потом сайт.
5. Чужая линия прицела в канале. Это только картинка.
6. Ограничения бесплатного тарифа (числа приблизительные, сверить со страницей цен Supabase):
   - около 500 тыс. вызовов функций в месяц, а матч занимает 30–40 вызовов;
   - CPU на бросок 5–80 мс при лимите около 2 с;
   - база: около 100 байт на бросок плюс несколько строк на матч;
   - пауза проекта после примерно 7 дней простоя: асыки «в коне» ждут пробуждения, но не теряются.
