-- «Асық ату»: соревновательный режим «на асыки» (матч на двоих, кон из 10 асыков).
--
-- Как применить: панель Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Сначала должен быть выполнен schema.sql. Этот скрипт можно запускать повторно:
-- он ничего не удаляет из данных и не дублирует (create … if not exists, create or replace, drop policy if exists).
-- После него выполните competitive.check.sql — он должен закончиться таблицей с «ALL PASS».
--
-- Модель безопасности (решения владельца — docs/competitive-mode.md, раздел 0.1):
--   * в таблицы режима никто не пишет напрямую: нет прав на запись, все изменения — функции ниже;
--   * функции для игроков (authenticated) сами проверяют auth.uid() и вход через Google;
--   * служебные функции comp_count_call / comp_begin_throw / comp_apply_throw / comp_void_version
--     выданы только service_role:
--     их вызывает серверная функция comp-throw, ключ которой живёт только в окружении Supabase;
--   * внутренние функции и секреты матча лежат в схеме private, которую API (PostgREST) не публикует;
--   * секрет матча (seed) хранится отдельно в private.comp_secrets и игрокам не возвращается никогда;
--   * чужие uuid (host, user_id, owner_user, pending_by) игрокам не выдаются: права на колонки.
-- Порядок блокировок везде один: строка матча, затем строки игроков и асыки по возрастанию id.
-- Строку игрока без блокировки матча меняют только пульс и перепривязка (client_id, last_seen) —
-- они не трогают строку матча и поэтому не могут попасть в дедлок.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;          -- PostgREST эту схему не публикует
revoke all on schema private from public, anon;
grant usage on schema private to authenticated; -- нужно только для функций-помощников в политиках RLS

-- ——— константы режима (поднять до 3–4 игроков — поменять здесь) ———

-- Сколько игроков пускает матч. Первая версия — только на двоих.
create or replace function private.comp_max_players() returns int
  language sql immutable security definer set search_path = ''
as $$ select 2 $$;

-- Сколько асыков ставит каждый игрок (кон = 5 · число игроков).
create or replace function private.comp_stake_size() returns int
  language sql immutable security definer set search_path = ''
as $$ select 5 $$;

-- Бросков на игрока: 15 на двоих, 10 на троих-четверых.
create or replace function private.comp_throws_per_player(p_players int) returns int
  language sql immutable security definer set search_path = ''
as $$ select case when coalesce(p_players, 2) <= 2 then 15 else 10 end $$;

-- Секунд на ход.
create or replace function private.comp_turn_seconds() returns int
  language sql immutable security definer set search_path = ''
as $$ select 45 $$;

-- Сколько пропусков подряд засчитываются как сдача.
create or replace function private.comp_skips_to_forfeit() returns int
  language sql immutable security definer set search_path = ''
as $$ select 2 $$;

-- Версия серверной физики: должна совпадать с SIM_VERSION в коде (src/game/sim/version.ts).
-- Поменяли физику — поднимите число здесь и выполните скрипт заново.
create or replace function private.comp_sim_version() returns int
  language sql immutable security definer set search_path = ''
as $$ select 1 $$;

-- Предел запрошенного угла (PHYS.maxAimAngle = 78° ≈ 1,36136 рад) и минимальная сила
-- (PHYS.minSlide / PHYS.maxSlide = 100 / 1250 = 0,08; с запасом на округление).
create or replace function private.comp_max_angle() returns double precision
  language sql immutable security definer set search_path = ''
as $$ select 1.3614::double precision $$;

create or replace function private.comp_min_power() returns double precision
  language sql immutable security definer set search_path = ''
as $$ select 0.079::double precision $$;

-- Коны соревновательного режима: должны совпадать с STAKE_LAYOUT_IDS (src/game/levels/matchLayouts.ts).
-- Новый кон — добавьте id сюда и выполните скрипт заново (ограничение таблицы пересоздаётся ниже).
create or replace function private.comp_layout_ids() returns text[]
  language sql immutable security definer set search_path = ''
as $$ select array['stake-line', 'stake-scatter', 'stake-ring', 'stake-uime', 'stake-korgan', 'stake-series', 'stake-romb', 'stake-irek', 'stake-qaqpa', 'stake-piles']::text[] $$;

-- ——— таблицы ———

alter table public.profiles
  add column if not exists comp_played int not null default 0,
  add column if not exists banned boolean not null default false;

create table if not exists public.comp_matches (
  id uuid primary key default gen_random_uuid(),
  join_code text not null unique check (join_code ~ '^[A-HJKMNP-Z2-9]{10}$'),
  host uuid not null,                         -- без FK: удаление аккаунта не блокируется
  layout_id text not null,                    -- проверка — ограничение comp_matches_layout_id_check ниже
  sim_version int not null,
  status text not null default 'forming'
    check (status in ('forming', 'ready', 'active', 'settled', 'cancelled', 'void')),
  players smallint check (players between 2 and 4),
  current_seat smallint,
  throw_no int not null default 0,
  kon_state jsonb,                            -- AsykState[] после последнего броска (null — исходная раскладка)
  last_throw jsonb,                           -- {throw_no, seat, angle, power, kon_before, knocked, steps}
  turn_started_at timestamptz,                -- начало хода (после показа прошлого броска)
  turn_deadline timestamptz,
  ready_deadline timestamptz,                 -- forming: срок жизни лобби; ready: срок «Я здесь»
  pending_by uuid, pending_at timestamptz,    -- «бросок принят сервером»
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  end_reason text
);
alter table public.comp_matches add column if not exists turn_started_at timestamptz;
-- список конов растёт: ограничение пересоздаётся при каждом запуске скрипта
alter table public.comp_matches drop constraint if exists comp_matches_layout_id_check;
alter table public.comp_matches add constraint comp_matches_layout_id_check
  check (layout_id = any (private.comp_layout_ids()));
-- Реванш: следующий матч той же компании (comp_rematch). Игрокам колонка не выдаётся — код реванша в comp_state.
alter table public.comp_matches add column if not exists next_match uuid
  references public.comp_matches (id) on delete set null;
-- Счётчик изменений состава (вход, ставка, «Я здесь», выход, сдача…). comp_players не публикуется
-- в Realtime (там DELETE уходят всем без RLS), поэтому сигнал «перечитай comp_state» идёт через строку матча.
alter table public.comp_matches add column if not exists players_rev int not null default 0;
create index if not exists comp_matches_host_idx on public.comp_matches (host, created_at);
create index if not exists comp_matches_live_idx on public.comp_matches (status, updated_at)
  where status in ('forming', 'ready', 'active');

alter table public.asyks
  add column if not exists locked_match uuid references public.comp_matches (id) on delete set null,
  add column if not exists acquired_at timestamptz not null default now();
create index if not exists asyks_locked_idx on public.asyks (locked_match) where locked_match is not null;
create index if not exists asyks_owner_free_idx on public.asyks (owner) where locked_match is null;

-- Секрет матча — отдельно: postgres_changes рассылает строки comp_matches целиком.
create table if not exists private.comp_secrets (
  match_id uuid primary key references public.comp_matches (id) on delete cascade,
  seed bytea not null default extensions.gen_random_bytes(32)
);

create table if not exists public.comp_players (
  match_id uuid not null references public.comp_matches (id) on delete cascade,
  user_id uuid not null,
  lobby_slot smallint not null check (lobby_slot between 0 and 3),
  seat smallint check (seat between 0 and 3),            -- 0..N-1 подряд, назначается при старте (comp_ready)
  client_id text not null check (client_id ~ '^[0-9a-f]{16}$'),
  display_name text not null,
  staked boolean not null default false,
  ready boolean not null default false,
  forfeited boolean not null default false,
  active boolean not null default true,
  throws int not null default 0,                         -- израсходованные ходы (бросок, пропуск, сбой)
  real_throws int not null default 0,                    -- настоящие броски
  knocked int not null default 0,
  best_combo int not null default 0,
  skips_in_row int not null default 0,
  last_seen timestamptz,                                 -- пульс comp_heartbeat
  joined_at timestamptz not null default now(),
  -- первичный ключ — из видимых игроку колонок (user_id игроку не выдан).
  -- В публикацию Realtime таблица не входит: DELETE там уходят всем без RLS (см. конец файла)
  primary key (match_id, lobby_slot),
  unique (match_id, user_id),
  unique (match_id, seat)
);
alter table public.comp_players add column if not exists last_seen timestamptz;
create unique index if not exists comp_one_active on public.comp_players (user_id) where active;
create index if not exists comp_players_user_idx on public.comp_players (user_id);

create table if not exists public.comp_stakes (
  match_id uuid not null references public.comp_matches (id) on delete cascade,
  slot smallint not null,                                -- = индекс асыка в раскладке (Piece.index)
  asyk_id bigint references public.asyks (id) on delete set null,
  owner_user uuid not null,
  owner_seat smallint not null,
  knocked_by_seat smallint,
  knocked_throw int,
  primary key (match_id, slot),
  unique (match_id, asyk_id)
);

create table if not exists public.comp_throws (           -- около 100 байт на строку, только добавление
  match_id uuid not null references public.comp_matches (id) on delete cascade,
  throw_no int not null,
  seat smallint not null,
  user_id uuid not null,
  kind text not null check (kind in ('throw', 'skip', 'fail')),
  angle double precision,
  power double precision,
  knocked smallint[] not null default '{}',
  steps int,
  created_at timestamptz not null default now(),
  primary key (match_id, throw_no)
);

-- Журнал переходов асыков между игроками (только сервер; игроку — через my_comp_history).
create table if not exists public.asyk_transfers (
  id bigint generated always as identity primary key,
  asyk_id bigint not null,
  from_user uuid not null,
  to_user uuid not null,
  match_id uuid not null,
  at timestamptz not null default now(),
  unique (asyk_id, match_id)
);
create index if not exists asyk_transfers_match_idx on public.asyk_transfers (match_id);

-- Счётчик вызовов серверной функции броска (лимит в минуту на игрока).
create table if not exists private.comp_calls (
  user_id uuid not null,
  minute timestamptz not null,
  calls int not null default 0,
  primary key (user_id, minute)
);

-- Исключённые хозяином: по тому же коду в этот матч их больше не пускают.
create table if not exists private.comp_kicked (
  match_id uuid not null references public.comp_matches (id) on delete cascade,
  user_id uuid not null,
  at timestamptz not null default now(),
  primary key (match_id, user_id)
);

-- ——— права на таблицы: читать только участникам и только безопасные колонки ———

alter table public.comp_matches enable row level security;
alter table public.comp_players enable row level security;
alter table public.comp_stakes enable row level security;
alter table public.comp_throws enable row level security;
alter table public.asyk_transfers enable row level security;
alter table private.comp_secrets enable row level security;
alter table private.comp_calls enable row level security;
alter table private.comp_kicked enable row level security;

revoke all on public.comp_matches from public, anon, authenticated;
revoke all on public.comp_players from public, anon, authenticated;
revoke all on public.comp_stakes from public, anon, authenticated;
revoke all on public.comp_throws from public, anon, authenticated;
revoke all on public.asyk_transfers from public, anon, authenticated;
revoke all on private.comp_secrets from public, anon, authenticated, service_role;
revoke all on private.comp_calls from public, anon, authenticated, service_role;
revoke all on private.comp_kicked from public, anon, authenticated, service_role;

-- Последовательность журнала: Supabase по умолчанию выдаёт её anon и authenticated — забираем.
do $seq$
declare
  v_seq text := pg_get_serial_sequence('public.asyk_transfers', 'id');
begin
  if v_seq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
  end if;
end;
$seq$;

-- host и pending_by (чужие uuid) не выдаются
grant select (id, join_code, layout_id, sim_version, status, players, current_seat, throw_no,
              kon_state, last_throw, turn_started_at, turn_deadline, ready_deadline, pending_at,
              created_at, started_at, updated_at, settled_at, end_reason, players_rev)
  on public.comp_matches to authenticated;
-- user_id и client_id не выдаются
grant select (match_id, lobby_slot, seat, display_name, staked, ready, forfeited, active,
              throws, real_throws, knocked, best_combo, skips_in_row, last_seen, joined_at)
  on public.comp_players to authenticated;
-- asyk_id и owner_user не выдаются (свои асыки — в comp_state)
grant select (match_id, slot, owner_seat, knocked_by_seat, knocked_throw)
  on public.comp_stakes to authenticated;
-- user_id не выдаётся
grant select (match_id, throw_no, seat, kind, angle, power, knocked, steps, created_at)
  on public.comp_throws to authenticated;
-- asyk_transfers: игрокам прав нет, история — через my_comp_history()

-- ——— помощники для политик ———

-- Участник ли вызывающий в матче. Рекурсии в RLS нет: это функция, а не подзапрос к той же таблице.
create or replace function private.is_comp_member(p_match uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.comp_players p
    where p.match_id = p_match and p.user_id = (select auth.uid())
  )
$$;

-- Можно ли вызывающему слушать закрытые каналы матча:
--   comp:<uuid матча>     — запись броска от сервера ('srv') и присутствие;
--   comp-aim:<uuid матча> — линия прицела от игроков.
-- Что можно писать в каждый канал — в политиках на realtime.messages в конце файла.
create or replace function private.is_comp_topic_member(p_topic text) returns boolean
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_id text;
begin
  if p_topic is null then
    return false;
  elsif left(p_topic, 5) = 'comp:' then
    v_id := substr(p_topic, 6);
  elsif left(p_topic, 9) = 'comp-aim:' then
    v_id := substr(p_topic, 10);
  else
    return false;
  end if;
  if v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from public.comp_players p
    join public.comp_matches m on m.id = p.match_id
    where m.id = v_id::uuid
      and p.user_id = (select auth.uid())
      and (m.status in ('forming', 'ready', 'active') or m.settled_at > now() - interval '10 minutes')
  );
end;
$$;

drop policy if exists "comp: участники читают" on public.comp_matches;
create policy "comp: участники читают" on public.comp_matches
  for select to authenticated using (private.is_comp_member(id));

drop policy if exists "comp: участники читают" on public.comp_players;
create policy "comp: участники читают" on public.comp_players
  for select to authenticated using (private.is_comp_member(match_id));

drop policy if exists "comp: участники читают" on public.comp_stakes;
create policy "comp: участники читают" on public.comp_stakes
  for select to authenticated using (private.is_comp_member(match_id));

drop policy if exists "comp: участники читают" on public.comp_throws;
create policy "comp: участники читают" on public.comp_throws
  for select to authenticated using (private.is_comp_member(match_id));

-- updated_at матча меняется при каждом изменении строки (по нему ищутся «зависшие» матчи).
-- Если колонку меняют явно (уборка, тесты), значение не трогаем.
create or replace function private.comp_touch() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists comp_matches_touch on public.comp_matches;
create trigger comp_matches_touch before update on public.comp_matches
  for each row execute function private.comp_touch();

-- Любое изменение состава (кроме пульса и перепривязки вкладки) поднимает players_rev матча:
-- по UPDATE строки матча в postgres_changes клиент перечитывает comp_state.
-- Все функции, меняющие эти колонки, уже держат блокировку строки матча.
create or replace function private.comp_players_bump() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_match uuid;
begin
  if tg_op = 'DELETE' then
    v_match := old.match_id;
  else
    v_match := new.match_id;
  end if;
  update public.comp_matches m set players_rev = m.players_rev + 1 where m.id = v_match;
  return null;
end;
$$;

drop trigger if exists comp_players_bump on public.comp_players;
create trigger comp_players_bump
  after insert or delete
     or update of seat, display_name, staked, ready, forfeited, active, throws, real_throws, knocked,
                  best_combo, skips_in_row
  on public.comp_players
  for each row execute function private.comp_players_bump();

-- ——— внутренние функции (схема private, никому не выданы) ———

-- Проверка вызывающего для всех функций игрока: вход есть, это Google, профиль есть, не забанен.
create or replace function private.comp_caller() returns uuid
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := auth.jwt();
  v_banned boolean;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  -- app_metadata игрок изменить не может (в отличие от user_metadata)
  if coalesce((v_claims ->> 'is_anonymous')::boolean, false)
     or coalesce(v_claims -> 'app_metadata' ->> 'provider', '') <> 'google' then
    raise exception 'google_required' using errcode = '42501';
  end if;
  select pr.banned into v_banned from public.profiles pr where pr.id = v_uid;
  if not found then
    raise exception 'no_profile' using errcode = 'P0001';
  end if;
  if v_banned then
    raise exception 'banned' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- Имя игрока, очищенное как cleanName в src/ui/format.ts: без управляющих и невидимых символов,
-- пробелы схлопнуты, не длиннее 16 символов; пустое — запасное имя.
create or replace function private.comp_clean_name(p_raw text, p_fallback text) returns text
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_s text := left(coalesce(p_raw, ''), 100);
begin
  v_s := normalize(v_s, NFC);
  -- символы заданы escape-кодами регулярки (\uXXXX), а не самими невидимыми знаками:
  -- редактор или SQL Editor может молча выкинуть U+2028 или U+FEFF и сломать диапазоны
  v_s := regexp_replace(v_s,
    '[[:cntrl:]\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uE000-\uF8FF]', '', 'g');
  v_s := btrim(regexp_replace(v_s, '\s+', ' ', 'g'));
  v_s := btrim(left(v_s, 16));
  if v_s = '' then
    return p_fallback;
  end if;
  return v_s;
end;
$$;

-- Код комнаты: 10 знаков из того же алфавита, что у обычных комнат (без 0/O/1/I/L).
create or replace function private.comp_new_code() returns text
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(10);
  v_out text := '';
  v_i int;
begin
  for v_i in 0..9 loop
    v_out := v_out || substr(v_alpha, (get_byte(v_bytes, v_i) % 31) + 1, 1);
  end loop;
  return v_out;
end;
$$;

-- Отмена матча с возвратом всех ставок: до старта — cancelled, после — void.
create or replace function private.comp_refund(p_match uuid, p_reason text) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_status text;
  v_started timestamptz;
begin
  select m.status, m.started_at into v_status, v_started
  from public.comp_matches m where m.id = p_match for update;
  if not found or v_status not in ('forming', 'ready', 'active') then
    return;
  end if;
  perform 1 from public.asyks a where a.locked_match = p_match order by a.id for update;
  update public.asyks a set locked_match = null where a.locked_match = p_match;
  update public.comp_players p set active = false where p.match_id = p_match;
  update public.comp_matches m
     set status = case when v_started is null then 'cancelled' else 'void' end,
         end_reason = p_reason,
         settled_at = now(),
         turn_deadline = null,
         pending_by = null,
         pending_at = null
   where m.id = p_match;
end;
$$;

-- Раздача: выбитый асык — тому, кто выбил; невыбитый — хозяину. Только из active, ровно один раз.
create or replace function private.comp_settle(p_match uuid, p_reason text) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_status text;
  v_fail_seats int;
  v_row record;
  v_winner uuid;
begin
  select m.status into v_status from public.comp_matches m where m.id = p_match for update;
  if not found or v_status <> 'active' then
    return; -- уже раздан или отменён: повторная раздача ничего не меняет
  end if;

  -- сбой сервера задел ходы двух и больше разных мест — матч аннулируется с возвратом
  select count(distinct t.seat) into v_fail_seats
  from public.comp_throws t where t.match_id = p_match and t.kind = 'fail';
  if v_fail_seats >= 2 then
    perform private.comp_refund(p_match, 'server');
    return;
  end if;

  perform 1 from public.asyks a where a.locked_match = p_match order by a.id for update;

  for v_row in
    select s.asyk_id, s.owner_user,
           (select p.user_id from public.comp_players p
             where p.match_id = p_match and p.seat = s.knocked_by_seat) as knocker
    from public.comp_stakes s
    where s.match_id = p_match and s.asyk_id is not null
    order by s.asyk_id
  loop
    v_winner := coalesce(v_row.knocker, v_row.owner_user);
    -- у победителя больше нет профиля (аккаунт удалён) — асык остаётся хозяину
    if v_winner <> v_row.owner_user
       and not exists (select 1 from public.profiles pr where pr.id = v_winner) then
      v_winner := v_row.owner_user;
    end if;
    update public.asyks a
       set owner = v_winner,
           locked_match = null,
           acquired_at = case when a.owner <> v_winner then now() else a.acquired_at end
     where a.id = v_row.asyk_id and a.locked_match = p_match;
    if found and v_winner <> v_row.owner_user then
      insert into public.asyk_transfers (asyk_id, from_user, to_user, match_id)
      values (v_row.asyk_id, v_row.owner_user, v_winner, p_match)
      on conflict (asyk_id, match_id) do nothing;
    end if;
  end loop;

  -- страховка: ни один асык не остаётся «в коне»
  update public.asyks a set locked_match = null where a.locked_match = p_match;

  update public.profiles pr set comp_played = pr.comp_played + 1
   where pr.id in (select p.user_id from public.comp_players p where p.match_id = p_match);
  update public.comp_players p set active = false where p.match_id = p_match;
  update public.comp_matches m
     set status = 'settled',
         settled_at = now(),
         end_reason = p_reason,
         turn_deadline = null,
         pending_by = null,
         pending_at = null
   where m.id = p_match;
end;
$$;

-- Переход хода (строка матча уже заблокирована, статус active, throw_no уже увеличен).
-- p_delay — время показа броска: ход и дедлайн начинаются после него.
create or replace function private.comp_advance(p_match uuid, p_delay interval) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_players int;
  v_current int;
  v_limit int;
  v_next int;
  v_seat int;
  v_i int;
begin
  select m.players, m.current_seat into v_players, v_current
  from public.comp_matches m where m.id = p_match;

  if not exists (select 1 from public.comp_stakes s
                 where s.match_id = p_match and s.knocked_by_seat is null) then
    perform private.comp_settle(p_match, 'cleared');
    return;
  end if;

  v_limit := private.comp_throws_per_player(v_players);
  v_next := null;
  -- следующее по кругу место: игрок не сдался и броски у него не кончились (текущее — последним)
  for v_i in 1..v_players loop
    v_seat := (coalesce(v_current, -1) + v_i) % v_players;
    if exists (select 1 from public.comp_players p
               where p.match_id = p_match and p.seat = v_seat
                 and not p.forfeited and p.throws < v_limit) then
      v_next := v_seat;
      exit;
    end if;
  end loop;

  if v_next is null then
    perform private.comp_settle(p_match,
      case when exists (select 1 from public.comp_players p
                        where p.match_id = p_match and not p.forfeited)
           then 'throws_out' else 'all_forfeited' end);
    return;
  end if;

  update public.comp_matches m
     set current_seat = v_next,
         turn_started_at = now() + p_delay,
         turn_deadline = now() + p_delay + make_interval(secs => private.comp_turn_seconds()),
         pending_by = null,
         pending_at = null
   where m.id = p_match;
end;
$$;

-- Сдача игрока (строка матча уже заблокирована, статус active). Если сейчас его ход — ход переходит.
create or replace function private.comp_do_forfeit(p_match uuid, p_user uuid) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_seat int;
  v_current int;
  v_throw_no int;
begin
  update public.comp_players p set forfeited = true
   where p.match_id = p_match and p.user_id = p_user and not p.forfeited
  returning p.seat into v_seat;
  if not found then
    return;
  end if;
  select m.current_seat, m.throw_no into v_current, v_throw_no
  from public.comp_matches m where m.id = p_match;
  if v_current = v_seat then
    insert into public.comp_throws (match_id, throw_no, seat, user_id, kind)
    values (p_match, v_throw_no + 1, v_seat, p_user, 'skip');
    update public.comp_players p set throws = p.throws + 1
     where p.match_id = p_match and p.user_id = p_user;
    update public.comp_matches m set throw_no = v_throw_no + 1 where m.id = p_match;
    perform private.comp_advance(p_match, interval '0 seconds');
  end if;
end;
$$;

-- Жребий (строка матча уже заблокирована): места и слоты кона выбирает сервер (HMAC от секрета матча).
-- Вызывается в момент старта, когда все нажали «Я здесь»: до этого ни мест, ни раскладки никто не видит,
-- и перебросить жребий выходом на проверке готовности нельзя.
create or replace function private.comp_deal(p_match uuid) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_n int;
  v_seed bytea;
  v_slots int;
begin
  select count(*) into v_n from public.comp_players p where p.match_id = p_match;

  select s.seed into v_seed from private.comp_secrets s where s.match_id = p_match;
  if v_seed is null then
    insert into private.comp_secrets (match_id) values (p_match) returning seed into v_seed;
  end if;

  -- места 0..N-1 подряд; первым ходит место 0
  update public.comp_players p
     set seat = x.seat
    from (
      select p2.user_id,
             (row_number() over (order by extensions.hmac(convert_to('seat:' || p2.user_id::text, 'UTF8'),
                                                         v_seed, 'sha256'), p2.user_id) - 1)::smallint as seat
      from public.comp_players p2
      where p2.match_id = p_match
    ) as x
   where p.match_id = p_match and p.user_id = x.user_id;

  -- слот = индекс асыка в раскладке: перестановка 5·N асыков
  delete from public.comp_stakes s where s.match_id = p_match;
  insert into public.comp_stakes (match_id, slot, asyk_id, owner_user, owner_seat)
  select p_match,
         (row_number() over (order by extensions.hmac(convert_to('slot:' || a.id::text, 'UTF8'),
                                                     v_seed, 'sha256'), a.id) - 1)::smallint,
         a.id, a.owner, p.seat
  from public.asyks a
  join public.comp_players p on p.match_id = p_match and p.user_id = a.owner
  where a.locked_match = p_match;
  get diagnostics v_slots = row_count;
  if v_slots <> v_n * private.comp_stake_size() then
    raise exception 'stake_mismatch' using errcode = 'P0001';
  end if;
end;
$$;

-- Ленивая уборка одного матча: просроченное лобби или «Я здесь» — возврат ставок;
-- p_include_active — ещё и зависший active (нет изменений 15 мин) — раздача по уже выбитому.
create or replace function private.comp_lazy_expire(p_match uuid, p_include_active boolean) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_status text;
  v_rd timestamptz;
  v_upd timestamptz;
begin
  select m.status, m.ready_deadline, m.updated_at into v_status, v_rd, v_upd
  from public.comp_matches m where m.id = p_match;
  if not found then
    return;
  end if;
  if not ((v_status in ('forming', 'ready') and coalesce(v_rd < now(), false))
          or (p_include_active and v_status = 'active' and v_upd < now() - interval '15 minutes')) then
    return;
  end if;
  -- перепроверка под блокировкой
  select m.status, m.ready_deadline, m.updated_at into v_status, v_rd, v_upd
  from public.comp_matches m where m.id = p_match for update;
  if v_status in ('forming', 'ready') and coalesce(v_rd < now(), false) then
    perform private.comp_refund(p_match,
      case when v_status = 'forming' then 'lobby_expired' else 'not_ready' end);
  elsif p_include_active and v_status = 'active' and v_upd < now() - interval '15 minutes' then
    perform private.comp_settle(p_match, 'stale');
  end if;
end;
$$;

-- Перед входом в новый матч: если прошлый матч игрока просрочен — убрать его.
create or replace function private.comp_release_own(p_user uuid) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_match uuid;
begin
  select p.match_id into v_match from public.comp_players p where p.user_id = p_user and p.active;
  if found then
    perform private.comp_lazy_expire(v_match, true);
  end if;
end;
$$;

-- Уборка всех зависших матчей порциями (для pg_cron). В comp_open/comp_join не вызывается.
create or replace function private.comp_expire_stale(p_limit int default 50) returns int
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_n int := 0;
begin
  for v_id in
    select m.id from public.comp_matches m
    where (m.status in ('forming', 'ready') and m.ready_deadline < now())
       or (m.status = 'active' and m.updated_at < now() - interval '15 minutes')
    order by m.id
    limit greatest(coalesce(p_limit, 50), 1)
    for update skip locked
  loop
    perform private.comp_lazy_expire(v_id, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Коротко о матче после броска (ответ служебных функций).
create or replace function private.comp_next_json(p_match uuid) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'status', m.status,
    'current_seat', m.current_seat,
    'throw_no', m.throw_no,
    'turn_started_at', m.turn_started_at,
    'turn_deadline', m.turn_deadline,
    'end_reason', m.end_reason)
  from public.comp_matches m where m.id = p_match
$$;

-- Состояние матча для игрока p_uid (без секрета и без чужих uuid).
create or replace function private.comp_state_json(p_match uuid, p_uid uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_m public.comp_matches%rowtype;
  v_me public.comp_players%rowtype;
  v_count int;
  v_n int;
  v_players jsonb;
  v_slots jsonb;
  v_result jsonb := null;
begin
  select m.* into v_m from public.comp_matches m where m.id = p_match;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select p.* into v_me from public.comp_players p where p.match_id = p_match and p.user_id = p_uid;
  select count(*) into v_count from public.comp_players p where p.match_id = p_match;
  v_n := coalesce(v_m.players, v_count);

  select coalesce(jsonb_agg(jsonb_build_object(
           'lobby_slot', p.lobby_slot,
           'seat', p.seat,
           'name', p.display_name,
           'is_host', p.user_id = v_m.host,
           'is_me', p.user_id = p_uid,
           'staked', p.staked,
           'ready', p.ready,
           'forfeited', p.forfeited,
           'active', p.active,
           'throws', p.throws,
           'real_throws', p.real_throws,
           'knocked', p.knocked,
           'best_combo', p.best_combo,
           'skips_in_row', p.skips_in_row,
           'seen_ago_ms', case when p.last_seen is null then null
                               else greatest(0, floor(extract(epoch from (now() - p.last_seen)) * 1000))::bigint end,
           'online', coalesce(p.last_seen > now() - interval '15 seconds', false)
         ) order by p.seat nulls last, p.lobby_slot), '[]'::jsonb)
    into v_players
  from public.comp_players p where p.match_id = p_match;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slot', s.slot,
           'owner_seat', s.owner_seat,
           'knocked_by_seat', s.knocked_by_seat,
           'knocked_throw', s.knocked_throw,
           'mine', s.owner_user = p_uid,
           'asyk_id', case when s.owner_user = p_uid then s.asyk_id end
         ) order by s.slot), '[]'::jsonb)
    into v_slots
  from public.comp_stakes s where s.match_id = p_match;

  if v_m.status = 'settled' then
    v_result := jsonb_build_object(
      'refunded', false,
      'won', coalesce((select jsonb_agg(s.slot order by s.slot) from public.comp_stakes s
                       where s.match_id = p_match and s.knocked_by_seat = v_me.seat
                         and s.owner_user <> p_uid), '[]'::jsonb),
      'returned', coalesce((select jsonb_agg(s.slot order by s.slot) from public.comp_stakes s
                            where s.match_id = p_match and s.owner_user = p_uid
                              and (s.knocked_by_seat is null or s.knocked_by_seat = v_me.seat)), '[]'::jsonb),
      'lost', coalesce((select jsonb_agg(s.slot order by s.slot) from public.comp_stakes s
                        where s.match_id = p_match and s.owner_user = p_uid
                          and s.knocked_by_seat is not null and s.knocked_by_seat <> v_me.seat), '[]'::jsonb),
      'delta', (select count(*) from public.asyk_transfers t where t.match_id = p_match and t.to_user = p_uid)
             - (select count(*) from public.asyk_transfers t where t.match_id = p_match and t.from_user = p_uid));
  elsif v_m.status in ('cancelled', 'void') then
    v_result := jsonb_build_object(
      'refunded', true,
      'won', '[]'::jsonb,
      'returned', coalesce((select jsonb_agg(s.slot order by s.slot) from public.comp_stakes s
                            where s.match_id = p_match and s.owner_user = p_uid), '[]'::jsonb),
      'lost', '[]'::jsonb,
      'delta', 0);
  end if;

  return jsonb_build_object(
    'now', now(),
    'match', jsonb_build_object(
      'id', v_m.id,
      'join_code', v_m.join_code,
      'layout_id', v_m.layout_id,
      'sim_version', v_m.sim_version,
      'status', v_m.status,
      'players', v_m.players,
      'max_players', private.comp_max_players(),
      'stake_size', private.comp_stake_size(),
      'kon_size', v_n * private.comp_stake_size(),
      'throws_per_player', private.comp_throws_per_player(v_n),
      'turn_seconds', private.comp_turn_seconds(),
      'current_seat', v_m.current_seat,
      'throw_no', v_m.throw_no,
      'kon_state', v_m.kon_state,
      'last_throw', v_m.last_throw,
      'turn_started_at', v_m.turn_started_at,
      'turn_deadline', v_m.turn_deadline,
      'skip_absent_at', v_m.turn_started_at + interval '20 seconds',
      'skip_at', v_m.turn_deadline + interval '5 seconds',
      'ready_deadline', v_m.ready_deadline,
      'pending', v_m.pending_at is not null,
      'pending_at', v_m.pending_at,
      'players_rev', v_m.players_rev,
      'created_at', v_m.created_at,
      'started_at', v_m.started_at,
      'settled_at', v_m.settled_at,
      'end_reason', v_m.end_reason,
      -- реванш: код следующего матча, пока в него можно войти или он идёт
      'next_code', (select n.join_code from public.comp_matches n
                    where n.id = v_m.next_match and n.status in ('forming', 'ready', 'active'))),
    'me', jsonb_build_object(
      'lobby_slot', v_me.lobby_slot,
      'seat', v_me.seat,
      'is_host', v_m.host = p_uid,
      'staked', coalesce(v_me.staked, false),
      'ready', coalesce(v_me.ready, false),
      'forfeited', coalesce(v_me.forfeited, false),
      'staked_ids', to_jsonb(array(select a.id from public.asyks a
                                   where a.locked_match = p_match and a.owner = p_uid order by a.id))),
    'players', v_players,
    'slots', v_slots,
    'result', v_result);
end;
$$;

-- Вызывающий — участник матча? Иначе not_member.
create or replace function private.comp_require_member(p_match uuid, p_uid uuid) returns void
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.comp_players p where p.match_id = p_match and p.user_id = p_uid) then
    raise exception 'not_member' using errcode = 'P0001';
  end if;
end;
$$;

-- ——— функции для игроков (authenticated) ———

-- Создать матч. Возвращает {match_id, join_code, lobby_slot: 0}.
create or replace function public.comp_open(p_layout text, p_client_id text, p_name text) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_old_code text;
  v_id uuid;
  v_code text;
  v_try int := 0;
begin
  if p_layout is null or not (p_layout = any (private.comp_layout_ids())) then
    raise exception 'bad_layout' using errcode = 'P0001';
  end if;
  if p_client_id is null or p_client_id !~ '^[0-9a-f]{16}$' then
    raise exception 'bad_client_id' using errcode = 'P0001';
  end if;

  perform private.comp_release_own(v_uid);
  select m.join_code into v_old_code
  from public.comp_players p join public.comp_matches m on m.id = p.match_id
  where p.user_id = v_uid and p.active;
  if found then
    raise exception 'already_in_match' using errcode = 'P0001', detail = v_old_code;
  end if;

  if (select count(*) from public.comp_matches m
      where m.host = v_uid and m.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  loop
    v_code := private.comp_new_code();
    begin
      insert into public.comp_matches (join_code, host, layout_id, sim_version, ready_deadline)
      values (v_code, v_uid, p_layout, private.comp_sim_version(), now() + interval '20 minutes')
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try >= 5 then
        raise exception 'busy' using errcode = 'P0001';
      end if;
    end;
  end loop;

  insert into private.comp_secrets (match_id) values (v_id);
  begin
    insert into public.comp_players (match_id, user_id, lobby_slot, client_id, display_name, last_seen)
    values (v_id, v_uid, 0, p_client_id, private.comp_clean_name(p_name, 'Хозяин'), now());
  exception when unique_violation then
    raise exception 'already_in_match' using errcode = 'P0001';
  end;

  return jsonb_build_object('match_id', v_id, 'join_code', v_code, 'lobby_slot', 0);
end;
$$;

-- Войти в матч по коду. Участнику (в том числе после старта) просто возвращает его место.
-- Возвращает {match_id, join_code, lobby_slot, status}.
create or replace function public.comp_join(p_code text, p_client_id text, p_name text) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_code text;
  v_id uuid;
  v_status text;
  v_rd timestamptz;
  v_slot int;
  v_count int;
  v_old_code text;
begin
  if p_client_id is null or p_client_id !~ '^[0-9a-f]{16}$' then
    raise exception 'bad_client_id' using errcode = 'P0001';
  end if;
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if v_code !~ '^[A-HJKMNP-Z2-9]{10}$' then
    raise exception 'bad_code' using errcode = 'P0001';
  end if;

  select m.id, m.status into v_id, v_status from public.comp_matches m where m.join_code = v_code;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select p.lobby_slot into v_slot from public.comp_players p where p.match_id = v_id and p.user_id = v_uid;
  if found then
    update public.comp_players p set client_id = p_client_id, last_seen = now()
     where p.match_id = v_id and p.user_id = v_uid;
    return jsonb_build_object('match_id', v_id, 'join_code', v_code, 'lobby_slot', v_slot, 'status', v_status);
  end if;
  if exists (select 1 from private.comp_kicked k where k.match_id = v_id and k.user_id = v_uid) then
    raise exception 'kicked' using errcode = 'P0001';
  end if;

  perform private.comp_release_own(v_uid);
  select m.join_code into v_old_code
  from public.comp_players p join public.comp_matches m on m.id = p.match_id
  where p.user_id = v_uid and p.active;
  if found then
    raise exception 'already_in_match' using errcode = 'P0001', detail = v_old_code;
  end if;

  select m.status, m.ready_deadline into v_status, v_rd
  from public.comp_matches m where m.id = v_id for update;
  if v_status <> 'forming' then
    raise exception 'not_forming' using errcode = 'P0001';
  end if;
  if coalesce(v_rd < now(), false) then
    raise exception 'expired' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.comp_players p where p.match_id = v_id;
  if v_count >= private.comp_max_players() then
    raise exception 'full' using errcode = 'P0001';
  end if;
  select min(g.n) into v_slot
  from generate_series(0, private.comp_max_players() - 1) as g(n)
  where not exists (select 1 from public.comp_players p where p.match_id = v_id and p.lobby_slot = g.n);
  if v_slot is null then
    raise exception 'full' using errcode = 'P0001';
  end if;

  begin
    insert into public.comp_players (match_id, user_id, lobby_slot, client_id, display_name, last_seen)
    values (v_id, v_uid, v_slot, p_client_id, private.comp_clean_name(p_name, 'Гость'), now());
  exception when unique_violation then
    raise exception 'already_in_match' using errcode = 'P0001';
  end;

  return jsonb_build_object('match_id', v_id, 'join_code', v_code, 'lobby_slot', v_slot, 'status', 'forming');
end;
$$;

-- Перепривязать вкладку (последняя вкладка побеждает) и получить состояние.
create or replace function public.comp_rebind(p_match uuid, p_client_id text) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
begin
  if p_client_id is null or p_client_id !~ '^[0-9a-f]{16}$' then
    raise exception 'bad_client_id' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  -- сначала уборка (она блокирует матч, затем игроков), потом своя строка: порядок «матч → игроки»
  perform private.comp_lazy_expire(p_match, false);
  update public.comp_players p set client_id = p_client_id, last_seen = now()
   where p.match_id = p_match and p.user_id = v_uid
     and exists (select 1 from public.comp_matches m
                 where m.id = p_match and m.status in ('forming', 'ready', 'active'));
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- Хозяин исключает игрока из лобби: ставка исключённого возвращается,
-- войти в этот матч снова он уже не сможет (comp_join → kicked).
create or replace function public.comp_kick(p_match uuid, p_lobby_slot int) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_host uuid;
  v_status text;
  v_target uuid;
begin
  select m.host, m.status into v_host, v_status from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_host <> v_uid then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_status <> 'forming' then
    raise exception 'not_forming' using errcode = 'P0001';
  end if;
  if p_lobby_slot is null or p_lobby_slot = 0 then
    raise exception 'bad_slot' using errcode = 'P0001';
  end if;
  select p.user_id into v_target from public.comp_players p
  where p.match_id = p_match and p.lobby_slot = p_lobby_slot;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform 1 from public.asyks a where a.locked_match = p_match and a.owner = v_target order by a.id for update;
  update public.asyks a set locked_match = null where a.locked_match = p_match and a.owner = v_target;
  insert into private.comp_kicked (match_id, user_id) values (p_match, v_target)
  on conflict (match_id, user_id) do nothing;
  delete from public.comp_players p where p.match_id = p_match and p.user_id = v_target;
end;
$$;

-- Поставить 5 свободных асыков (по желанию — из списка p_ids). Повторный вызов возвращает уже поставленные.
create or replace function public.comp_stake(p_match uuid, p_ids bigint[] default null) returns bigint[]
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_status text;
  v_staked boolean;
  v_ids bigint[];
begin
  select m.status into v_status from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select p.staked into v_staked from public.comp_players p where p.match_id = p_match and p.user_id = v_uid;
  if not found then
    raise exception 'not_member' using errcode = 'P0001';
  end if;
  if v_staked then
    return array(select a.id from public.asyks a
                 where a.locked_match = p_match and a.owner = v_uid order by a.id);
  end if;
  if v_status <> 'forming' then
    raise exception 'not_forming' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(x.id order by x.id), '{}'::bigint[]) into v_ids
  from (
    select a.id from public.asyks a
    where a.owner = v_uid and a.locked_match is null
      and (p_ids is null or a.id = any (p_ids))
    order by a.id
    limit private.comp_stake_size()
    for update skip locked
  ) as x;
  if cardinality(v_ids) <> private.comp_stake_size() then
    raise exception 'not_enough' using errcode = 'P0001', detail = cardinality(v_ids)::text;
  end if;

  update public.asyks a set locked_match = p_match where a.id = any (v_ids);
  update public.comp_players p set staked = true where p.match_id = p_match and p.user_id = v_uid;
  return v_ids;
end;
$$;

-- Забрать ставку до старта.
create or replace function public.comp_unstake(p_match uuid) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_status text;
begin
  select m.status into v_status from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  if v_status <> 'forming' then
    raise exception 'not_forming' using errcode = 'P0001';
  end if;
  perform 1 from public.asyks a where a.locked_match = p_match and a.owner = v_uid order by a.id for update;
  update public.asyks a set locked_match = null where a.locked_match = p_match and a.owner = v_uid;
  update public.comp_players p set staked = false where p.match_id = p_match and p.user_id = v_uid;
end;
$$;

-- Выйти: в лобби — ставка возвращается (хозяин — матч отменяется целиком);
-- на проверке готовности — отмена матча; во время игры — это сдача (асыки остаются в коне).
create or replace function public.comp_leave(p_match uuid) returns void
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_status text;
  v_host uuid;
begin
  select m.status, m.host into v_status, v_host from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  if v_status = 'forming' then
    if v_host = v_uid then
      perform private.comp_refund(p_match, 'host_left');
    else
      perform 1 from public.asyks a where a.locked_match = p_match and a.owner = v_uid order by a.id for update;
      update public.asyks a set locked_match = null where a.locked_match = p_match and a.owner = v_uid;
      delete from public.comp_players p where p.match_id = p_match and p.user_id = v_uid;
    end if;
  elsif v_status = 'ready' then
    perform private.comp_refund(p_match, 'left');
  elsif v_status = 'active' then
    perform private.comp_do_forfeit(p_match, v_uid);
  end if;
end;
$$;

-- Хозяин запускает матч: не поставившие удаляются, дальше — проверка готовности 60 с.
-- Места и слоты кона здесь ещё не назначаются (seat = null, slots пусто): жребий — в comp_ready,
-- когда готовы все.
create or replace function public.comp_start(p_match uuid) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_host uuid;
  v_status text;
  v_n int;
begin
  select m.host, m.status into v_host, v_status from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_host <> v_uid then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_status <> 'forming' then
    raise exception 'not_forming' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.comp_players p
                 where p.match_id = p_match and p.user_id = v_uid and p.staked) then
    raise exception 'not_staked' using errcode = 'P0001';
  end if;

  delete from public.comp_players p where p.match_id = p_match and not p.staked;
  select count(*) into v_n from public.comp_players p where p.match_id = p_match;
  if v_n < 2 or v_n > private.comp_max_players() then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;
  if (select count(*) from public.asyks a where a.locked_match = p_match) <> v_n * private.comp_stake_size() then
    raise exception 'stake_mismatch' using errcode = 'P0001';
  end if;

  update public.comp_matches m
     set status = 'ready',
         players = v_n,
         kon_state = null,
         ready_deadline = now() + interval '60 seconds'
   where m.id = p_match;

  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- «Я здесь». Когда готовы все — жребий (места и слоты кона) и старт: ходит место 0, дедлайн хода 45 с.
-- Просроченная проверка готовности — отмена с возвратом (ошибки нет, статус cancelled).
create or replace function public.comp_ready(p_match uuid) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_status text;
  v_rd timestamptz;
begin
  select m.status, m.ready_deadline into v_status, v_rd
  from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);

  if v_status = 'ready' and coalesce(v_rd < now(), false) then
    perform private.comp_refund(p_match, 'not_ready');
    return private.comp_state_json(p_match, v_uid);
  end if;
  if v_status <> 'ready' then
    if v_status in ('active', 'settled', 'cancelled', 'void') then
      return private.comp_state_json(p_match, v_uid);
    end if;
    raise exception 'not_ready_stage' using errcode = 'P0001';
  end if;

  update public.comp_players p set ready = true, last_seen = now()
   where p.match_id = p_match and p.user_id = v_uid;
  if not exists (select 1 from public.comp_players p where p.match_id = p_match and not p.ready) then
    perform private.comp_deal(p_match);
    update public.comp_matches m
       set status = 'active',
           current_seat = 0,
           throw_no = 0,
           started_at = now(),
           turn_started_at = now(),
           turn_deadline = now() + make_interval(secs => private.comp_turn_seconds()),
           ready_deadline = null
     where m.id = p_match;
  end if;
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- Пульс: клиент шлёт каждые 5 с. Обновляет last_seen не чаще раза в 2 с. Возвращает серверное время.
create or replace function public.comp_heartbeat(p_match uuid) returns timestamptz
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  update public.comp_players p set last_seen = now()
   where p.match_id = p_match and p.user_id = v_uid
     and (p.last_seen is null or p.last_seen < now() - interval '2 seconds');
  if not found then
    perform private.comp_require_member(p_match, v_uid);
  end if;
  return now();
end;
$$;

-- Пропуск хода. Разрешён любому участнику, если
--   (с начала хода прошло 20 с и пульс текущего игрока старше 15 с) или наступил дедлайн + 5 с,
--   и нет отметки «бросок принят» моложе 20 с.
-- Если отметка есть, но бросок так и не записан — это сбой сервера ('fail'), пропуском не считается.
-- 2 пропуска подряд — сдача.
create or replace function public.comp_skip(p_match uuid, p_throw_no int) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_m public.comp_matches%rowtype;
  v_cur public.comp_players%rowtype;
  v_allowed boolean;
begin
  select m.* into v_m from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  if v_m.status <> 'active' then
    raise exception 'not_active' using errcode = 'P0001';
  end if;
  if p_throw_no is null or p_throw_no <> v_m.throw_no + 1 then
    raise exception 'stale_throw' using errcode = 'P0001';
  end if;
  if v_m.pending_at is not null and v_m.pending_at > now() - interval '20 seconds' then
    raise exception 'pending' using errcode = 'P0001';
  end if;

  select p.* into v_cur from public.comp_players p
  where p.match_id = p_match and p.seat = v_m.current_seat;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_allowed := coalesce(now() >= v_m.turn_deadline + interval '5 seconds', false)
            or (coalesce(now() >= v_m.turn_started_at + interval '20 seconds', false)
                and coalesce(v_cur.last_seen < now() - interval '15 seconds', true));
  if not v_allowed then
    -- detail — ближайший момент, когда пропуск может стать возможным (если пульс больше не придёт),
    -- и не раньше чем через 1 с: клиент ждёт до него и не крутит вызовы впустую
    raise exception 'too_early' using errcode = 'P0001',
      detail = greatest(now() + interval '1 second',
                        least(v_m.turn_deadline + interval '5 seconds',
                              greatest(v_m.turn_started_at + interval '20 seconds',
                                       coalesce(v_cur.last_seen + interval '15 seconds',
                                                v_m.turn_started_at + interval '20 seconds'))))::text;
  end if;

  if v_m.pending_at is not null then
    insert into public.comp_throws (match_id, throw_no, seat, user_id, kind)
    values (p_match, p_throw_no, v_cur.seat, v_cur.user_id, 'fail');
    update public.comp_players p set throws = p.throws + 1
     where p.match_id = p_match and p.user_id = v_cur.user_id;
  else
    insert into public.comp_throws (match_id, throw_no, seat, user_id, kind)
    values (p_match, p_throw_no, v_cur.seat, v_cur.user_id, 'skip');
    update public.comp_players p
       set throws = p.throws + 1,
           skips_in_row = p.skips_in_row + 1,
           forfeited = p.forfeited or (p.skips_in_row + 1 >= private.comp_skips_to_forfeit())
     where p.match_id = p_match and p.user_id = v_cur.user_id;
  end if;

  update public.comp_matches m
     set throw_no = p_throw_no, pending_by = null, pending_at = null
   where m.id = p_match;
  perform private.comp_advance(p_match, interval '0 seconds');
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- Сдаться (только за себя). Асыки сдавшегося остаются в коне.
create or replace function public.comp_forfeit(p_match uuid) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_status text;
begin
  select m.status into v_status from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  if v_status <> 'active' then
    raise exception 'not_active' using errcode = 'P0001';
  end if;
  perform private.comp_do_forfeit(p_match, v_uid);
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- Уборка зависшего матча участником: active без изменений 15 мин — раздача по уже выбитому;
-- просроченные лобби и проверка готовности — возврат ставок.
create or replace function public.comp_settle_stale(p_match uuid) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
begin
  perform private.comp_require_member(p_match, v_uid);
  perform private.comp_lazy_expire(p_match, true);
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- Состояние матча. Попутно отменяет просроченное лобби или проверку готовности.
create or replace function public.comp_state(p_match uuid) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  perform private.comp_lazy_expire(p_match, false);
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- История своих матчей (без чужих uuid и почт): jsonb-массив, новые сверху, не больше 50.
create or replace function public.my_comp_history(p_limit int default 20) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_out jsonb;
begin
  select coalesce(jsonb_agg(x.j order by x.t desc), '[]'::jsonb) into v_out
  from (
    select coalesce(m.settled_at, m.created_at) as t,
           jsonb_build_object(
             'match_id', m.id,
             'status', m.status,
             'end_reason', m.end_reason,
             'layout_id', m.layout_id,
             'players', m.players,
             'started_at', m.started_at,
             'settled_at', m.settled_at,
             'my_seat', p.seat,
             'forfeited', p.forfeited,
             'knocked', p.knocked,
             'real_throws', p.real_throws,
             'best_combo', p.best_combo,
             'won', (select count(*) from public.asyk_transfers t
                     where t.match_id = m.id and t.to_user = v_uid),
             'lost', (select count(*) from public.asyk_transfers t
                      where t.match_id = m.id and t.from_user = v_uid),
             'opponents', coalesce((select jsonb_agg(o.display_name order by o.seat)
                                    from public.comp_players o
                                    where o.match_id = m.id and o.user_id <> v_uid), '[]'::jsonb)
           ) as j
    from public.comp_players p
    join public.comp_matches m on m.id = p.match_id
    where p.user_id = v_uid and m.status in ('settled', 'void')
    order by coalesce(m.settled_at, m.created_at) desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  ) as x;
  return v_out;
end;
$$;

-- Хозяин меняет кон в лобби (до жребия). Ставки не трогаются: кон из тех же 5 · N асыков.
create or replace function public.comp_set_layout(p_match uuid, p_layout text) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_m public.comp_matches%rowtype;
begin
  if p_layout is null or not (p_layout = any (private.comp_layout_ids())) then
    raise exception 'bad_layout' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  select m.* into v_m from public.comp_matches m where m.id = p_match for update;
  if v_m.host <> v_uid then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_m.status <> 'forming' then
    raise exception 'not_forming' using errcode = 'P0001';
  end if;
  if v_m.layout_id <> p_layout then
    update public.comp_matches m set layout_id = p_layout, players_rev = m.players_rev + 1 where m.id = p_match;
  end if;
  return private.comp_state_json(p_match, v_uid);
end;
$$;

-- Реванш / «В комнату» после матча: следующий матч той же компании.
-- Первый нажавший создаёт новое лобби (тот же кон, он — хозяин), остальные входят в него.
-- Ставка в новом матче — заново, обычным comp_stake. Возвращает {match_id, join_code, lobby_slot, created}.
create or replace function public.comp_rematch(p_match uuid, p_client_id text) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := private.comp_caller();
  v_m public.comp_matches%rowtype;
  v_name text;
  v_code text;
  v_status text;
  v_res jsonb;
begin
  if p_client_id is null or p_client_id !~ '^[0-9a-f]{16}$' then
    raise exception 'bad_client_id' using errcode = 'P0001';
  end if;
  perform private.comp_require_member(p_match, v_uid);
  -- блокировка старого матча: двое нажали одновременно — второй ждёт и входит в лобби первого
  select m.* into v_m from public.comp_matches m where m.id = p_match for update;
  if v_m.status not in ('settled', 'cancelled', 'void') then
    raise exception 'not_over' using errcode = 'P0001';
  end if;
  select p.display_name into v_name from public.comp_players p where p.match_id = p_match and p.user_id = v_uid;

  if v_m.next_match is not null then
    select n.join_code, n.status into v_code, v_status from public.comp_matches n where n.id = v_m.next_match;
    if found and v_status in ('forming', 'ready', 'active') then
      -- участнику comp_join вернёт его место в любом статусе, новичку — свободное место в лобби
      return public.comp_join(v_code, p_client_id, v_name) || jsonb_build_object('created', false);
    end if;
  end if;

  -- следующего матча нет (или он уже кончился) — новое лобби
  v_res := public.comp_open(v_m.layout_id, p_client_id, v_name);
  update public.comp_matches m
     set next_match = (v_res ->> 'match_id')::uuid, players_rev = m.players_rev + 1
   where m.id = p_match;
  return v_res || jsonb_build_object('created', true);
end;
$$;

-- ——— служебные функции (только service_role: их вызывает серверная функция comp-throw) ———

-- Лимит вызовов серверной функции броска: 30 в минуту на игрока.
-- Отдельный вызов (своя транзакция) — поэтому счётчик не откатывается, даже если бросок потом отклонён.
-- comp-throw вызывает его первым; false — сразу отказ rate_limited, comp_begin_throw не вызывается.
create or replace function public.comp_count_call(p_user uuid) returns boolean
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_calls int;
begin
  if p_user is null then
    return false;
  end if;
  insert into private.comp_calls as c (user_id, minute, calls)
  values (p_user, date_trunc('minute', now()), 1)
  on conflict (user_id, minute) do update set calls = c.calls + 1
  returning c.calls into v_calls;
  delete from private.comp_calls c where c.user_id = p_user and c.minute < now() - interval '1 hour';
  return v_calls <= 30;
end;
$$;

-- Начало броска: проверки, отметка «бросок принят», секрет для разброса.
-- Повтор того же броска тем же игроком (после обрыва связи) возвращает {replay: last_throw, …}.
-- Проверки идут дважды: сначала без блокировки (чужой матч, чужой ход, старый номер отсекаются,
-- не трогая строку матча), затем ещё раз под блокировкой — перед записью отметки.
create or replace function public.comp_begin_throw(p_match uuid, p_user uuid, p_throw_no int) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_banned boolean;
  v_m public.comp_matches%rowtype;
  v_p public.comp_players%rowtype;
  v_seed bytea;
begin
  if p_match is null or p_user is null or p_throw_no is null then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  select pr.banned into v_banned from public.profiles pr where pr.id = p_user;
  if not found then
    raise exception 'no_profile' using errcode = 'P0001';
  end if;
  if v_banned then
    raise exception 'banned' using errcode = '42501';
  end if;

  -- лимит считает comp_count_call; здесь — только проверка (счётчик этой минуты уже превышен)
  if coalesce((select c.calls from private.comp_calls c
               where c.user_id = p_user and c.minute = date_trunc('minute', now())), 0) > 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  for v_pass in 1..2 loop
    if v_pass = 1 then
      select m.* into v_m from public.comp_matches m where m.id = p_match;
    else
      select m.* into v_m from public.comp_matches m where m.id = p_match for update;
    end if;
    if not found then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    select p.* into v_p from public.comp_players p where p.match_id = p_match and p.user_id = p_user;
    if not found then
      raise exception 'not_member' using errcode = 'P0001';
    end if;

    -- повтор: проверяется до статуса, поэтому работает и после раздачи (только чтение — блокировка не нужна)
    if v_m.last_throw is not null
       and (v_m.last_throw ->> 'throw_no')::int = p_throw_no
       and exists (select 1 from public.comp_throws t
                   where t.match_id = p_match and t.throw_no = p_throw_no
                     and t.user_id = p_user and t.kind = 'throw') then
      select s.seed into v_seed from private.comp_secrets s where s.match_id = p_match;
      return jsonb_build_object(
        'replay', v_m.last_throw,
        'seed', encode(v_seed, 'hex'),
        'kon_state', v_m.last_throw -> 'kon_before',
        'layout_id', v_m.layout_id,
        'players', v_m.players,
        'sim_version', v_m.sim_version,
        'throw_no', p_throw_no,
        'seat', v_p.seat,
        'stake_size', private.comp_stake_size());
    end if;

    if v_m.status <> 'active' then
      raise exception 'not_active' using errcode = 'P0001';
    end if;
    if v_p.forfeited then
      raise exception 'forfeited' using errcode = 'P0001';
    end if;
    if v_p.seat is distinct from v_m.current_seat then
      raise exception 'not_your_turn' using errcode = 'P0001';
    end if;
    if p_throw_no <> v_m.throw_no + 1 then
      raise exception 'stale_throw' using errcode = 'P0001';
    end if;
    if not (coalesce(now() <= v_m.turn_deadline + interval '5 seconds', false)
            or coalesce(v_m.pending_by = p_user and v_m.pending_at > now() - interval '20 seconds', false)) then
      raise exception 'deadline' using errcode = 'P0001';
    end if;
  end loop;
  select s.seed into v_seed from private.comp_secrets s where s.match_id = p_match;

  -- свежая собственная отметка сохраняется (повтор не продлевает ход), иначе ставится новая
  update public.comp_matches m
     set pending_by = p_user,
         pending_at = case when coalesce(v_m.pending_by = p_user and v_m.pending_at > now() - interval '20 seconds', false)
                           then v_m.pending_at else now() end
   where m.id = p_match;
  update public.comp_players p set last_seen = now() where p.match_id = p_match and p.user_id = p_user;

  return jsonb_build_object(
    'replay', null,
    'seed', encode(v_seed, 'hex'),
    'kon_state', v_m.kon_state,
    'layout_id', v_m.layout_id,
    'players', v_m.players,
    'sim_version', v_m.sim_version,
    'throw_no', p_throw_no,
    'seat', v_p.seat,
    'stake_size', private.comp_stake_size());
end;
$$;

-- Запись результата броска, посчитанного сервером. Идемпотентна: повтор возвращает сохранённое.
-- p_final — AsykState[] ([слот, x, y, угол, 1 — в коне / 0 — выбит]) ровно на 5·N слотов;
-- p_knocked — ровно те слоты, что были в коне и стали выбитыми этим броском.
create or replace function public.comp_apply_throw(
  p_match uuid, p_user uuid, p_throw_no int,
  p_angle double precision, p_power double precision,
  p_kon_before jsonb, p_final jsonb, p_knocked int[], p_steps int
) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_m public.comp_matches%rowtype;
  v_p public.comp_players%rowtype;
  v_t public.comp_throws%rowtype;
  v_kon_before jsonb := nullif(p_kon_before, 'null'::jsonb);
  v_size int;
  v_new int[];
  v_k int[];
  v_n int;
begin
  if p_match is null or p_user is null or p_throw_no is null then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  select m.* into v_m from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- идемпотентность
  select t.* into v_t from public.comp_throws t where t.match_id = p_match and t.throw_no = p_throw_no;
  if found then
    if v_t.user_id = p_user and v_t.kind = 'throw' then
      return jsonb_build_object(
        'duplicate', true,
        'throw_no', v_t.throw_no,
        'knocked', to_jsonb(v_t.knocked),
        'steps', v_t.steps,
        'next', private.comp_next_json(p_match));
    end if;
    raise exception 'stale_throw' using errcode = 'P0001';
  end if;

  if v_m.status <> 'active' then
    raise exception 'not_active' using errcode = 'P0001';
  end if;
  if v_m.pending_by is distinct from p_user then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  if p_throw_no <> v_m.throw_no + 1 then
    raise exception 'stale_throw' using errcode = 'P0001';
  end if;
  select p.* into v_p from public.comp_players p where p.match_id = p_match and p.user_id = p_user;
  if not found or v_p.seat is distinct from v_m.current_seat or v_p.forfeited then
    raise exception 'not_your_turn' using errcode = 'P0001';
  end if;

  if p_angle is null or not coalesce(abs(p_angle) <= private.comp_max_angle(), false) then
    raise exception 'bad_angle' using errcode = 'P0001';
  end if;
  if p_power is null or not coalesce(p_power >= private.comp_min_power() and p_power <= 1, false) then
    raise exception 'bad_power' using errcode = 'P0001';
  end if;
  if p_steps is null or p_steps < 0 or p_steps > 3000 then
    raise exception 'bad_steps' using errcode = 'P0001';
  end if;
  if v_kon_before is distinct from v_m.kon_state then
    raise exception 'bad_kon_before' using errcode = 'P0001';
  end if;

  -- форма p_final: массив из 5·N массивов по 5 чисел
  v_size := v_m.players * private.comp_stake_size();
  if p_final is null or jsonb_typeof(p_final) <> 'array' then
    raise exception 'bad_final' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_final) <> v_size then
    raise exception 'bad_final' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_final) as e(v)
    where case
            when jsonb_typeof(e.v) <> 'array' then true
            when jsonb_array_length(e.v) <> 5 then true
            else exists (select 1 from jsonb_array_elements(e.v) as f(x)
                         where case when jsonb_typeof(f.x) <> 'number' then true
                                    else abs(f.x::numeric) > 1000000 end)
          end
  ) then
    raise exception 'bad_final' using errcode = 'P0001';
  end if;
  -- слоты строго по порядку 0..5N-1 (так их читает parseKonState в серверной функции), состояние 0 или 1
  if exists (
    select 1 from jsonb_array_elements(p_final) with ordinality as e(v, i)
    where (e.v -> 0)::numeric <> e.i - 1
       or (e.v -> 4)::numeric not in (0, 1)
  ) then
    raise exception 'bad_final' using errcode = 'P0001';
  end if;

  -- нет воскрешений: выбитый раньше слот в p_final тоже выбит
  if exists (
    select 1 from jsonb_array_elements(p_final) as e(v)
    join public.comp_stakes s on s.match_id = p_match and s.slot = ((e.v -> 0)::numeric)::int
    where s.knocked_by_seat is not null and (e.v -> 4)::numeric = 1
  ) then
    raise exception 'resurrection' using errcode = 'P0001';
  end if;

  -- p_knocked = ровно те слоты, что были в коне и выбиты в p_final
  if p_knocked is null then
    raise exception 'bad_knocked' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(s.slot::int order by s.slot), '{}'::int[]) into v_new
  from jsonb_array_elements(p_final) as e(v)
  join public.comp_stakes s on s.match_id = p_match and s.slot = ((e.v -> 0)::numeric)::int
  where s.knocked_by_seat is null and (e.v -> 4)::numeric = 0;
  select coalesce(array_agg(k.k order by k.k), '{}'::int[]) into v_k from unnest(p_knocked) as k(k);
  if v_k <> v_new then
    raise exception 'bad_knocked' using errcode = 'P0001';
  end if;
  v_n := cardinality(v_new);

  insert into public.comp_throws (match_id, throw_no, seat, user_id, kind, angle, power, knocked, steps)
  values (p_match, p_throw_no, v_p.seat, p_user, 'throw', p_angle, p_power, v_new::smallint[], p_steps);

  update public.comp_stakes s
     set knocked_by_seat = v_p.seat, knocked_throw = p_throw_no
   where s.match_id = p_match and s.slot = any (v_new) and s.knocked_by_seat is null;

  update public.comp_players p
     set throws = p.throws + 1,
         real_throws = p.real_throws + 1,
         knocked = p.knocked + v_n,
         best_combo = greatest(p.best_combo, v_n),
         skips_in_row = 0,
         last_seen = now()
   where p.match_id = p_match and p.user_id = p_user;

  update public.comp_matches m
     set last_throw = jsonb_build_object(
           'throw_no', p_throw_no,
           'seat', v_p.seat,
           'angle', p_angle,
           'power', p_power,
           'kon_before', v_kon_before,
           'knocked', to_jsonb(v_new),
           'steps', p_steps),
         kon_state = p_final,
         throw_no = p_throw_no,
         pending_by = null,
         pending_at = null
   where m.id = p_match;

  -- ход и дедлайн начинаются после показа броска: steps шагов по 1/120 с
  perform private.comp_advance(p_match, make_interval(secs => (p_steps / 120.0)::double precision));

  return jsonb_build_object(
    'duplicate', false,
    'throw_no', p_throw_no,
    'knocked', to_jsonb(v_new),
    'steps', p_steps,
    'next', private.comp_next_json(p_match));
end;
$$;

-- Версия физики сервера не совпала с версией матча — матч аннулируется с возвратом ставок.
create or replace function public.comp_void_version(p_match uuid, p_sim_version int) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_version int;
  v_status text;
  v_voided boolean := false;
begin
  select m.sim_version, m.status into v_version, v_status
  from public.comp_matches m where m.id = p_match for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_version is distinct from p_sim_version and v_status in ('forming', 'ready', 'active') then
    perform private.comp_refund(p_match, 'version');
    v_voided := true;
  end if;
  select m.status into v_status from public.comp_matches m where m.id = p_match;
  return jsonb_build_object('voided', v_voided, 'status', v_status);
end;
$$;

-- ——— права на функции: сначала закрыть всё, потом выдать точечно ———

revoke all on function private.comp_max_players() from public, anon, authenticated;
revoke all on function private.comp_stake_size() from public, anon, authenticated;
revoke all on function private.comp_throws_per_player(int) from public, anon, authenticated;
revoke all on function private.comp_turn_seconds() from public, anon, authenticated;
revoke all on function private.comp_skips_to_forfeit() from public, anon, authenticated;
revoke all on function private.comp_sim_version() from public, anon, authenticated;
revoke all on function private.comp_max_angle() from public, anon, authenticated;
revoke all on function private.comp_min_power() from public, anon, authenticated;
revoke all on function private.comp_layout_ids() from public, anon, authenticated;
revoke all on function private.is_comp_member(uuid) from public, anon, authenticated;
revoke all on function private.is_comp_topic_member(text) from public, anon, authenticated;
revoke all on function private.comp_touch() from public, anon, authenticated;
revoke all on function private.comp_players_bump() from public, anon, authenticated;
revoke all on function private.comp_caller() from public, anon, authenticated;
revoke all on function private.comp_clean_name(text, text) from public, anon, authenticated;
revoke all on function private.comp_new_code() from public, anon, authenticated;
revoke all on function private.comp_refund(uuid, text) from public, anon, authenticated;
revoke all on function private.comp_settle(uuid, text) from public, anon, authenticated;
revoke all on function private.comp_advance(uuid, interval) from public, anon, authenticated;
revoke all on function private.comp_do_forfeit(uuid, uuid) from public, anon, authenticated;
revoke all on function private.comp_deal(uuid) from public, anon, authenticated;
revoke all on function private.comp_lazy_expire(uuid, boolean) from public, anon, authenticated;
revoke all on function private.comp_release_own(uuid) from public, anon, authenticated;
revoke all on function private.comp_expire_stale(int) from public, anon, authenticated;
revoke all on function private.comp_next_json(uuid) from public, anon, authenticated;
revoke all on function private.comp_state_json(uuid, uuid) from public, anon, authenticated;
revoke all on function private.comp_require_member(uuid, uuid) from public, anon, authenticated;

-- помощники политик RLS и Realtime — вызываются от имени игрока
grant execute on function private.is_comp_member(uuid) to authenticated;
grant execute on function private.is_comp_topic_member(text) to authenticated;

revoke all on function public.comp_open(text, text, text) from public, anon, authenticated;
revoke all on function public.comp_join(text, text, text) from public, anon, authenticated;
revoke all on function public.comp_rebind(uuid, text) from public, anon, authenticated;
revoke all on function public.comp_kick(uuid, int) from public, anon, authenticated;
revoke all on function public.comp_stake(uuid, bigint[]) from public, anon, authenticated;
revoke all on function public.comp_unstake(uuid) from public, anon, authenticated;
revoke all on function public.comp_leave(uuid) from public, anon, authenticated;
revoke all on function public.comp_start(uuid) from public, anon, authenticated;
revoke all on function public.comp_ready(uuid) from public, anon, authenticated;
revoke all on function public.comp_heartbeat(uuid) from public, anon, authenticated;
revoke all on function public.comp_skip(uuid, int) from public, anon, authenticated;
revoke all on function public.comp_forfeit(uuid) from public, anon, authenticated;
revoke all on function public.comp_settle_stale(uuid) from public, anon, authenticated;
revoke all on function public.comp_state(uuid) from public, anon, authenticated;
revoke all on function public.my_comp_history(int) from public, anon, authenticated;
revoke all on function public.comp_set_layout(uuid, text) from public, anon, authenticated;
revoke all on function public.comp_rematch(uuid, text) from public, anon, authenticated;

grant execute on function public.comp_open(text, text, text) to authenticated;
grant execute on function public.comp_join(text, text, text) to authenticated;
grant execute on function public.comp_rebind(uuid, text) to authenticated;
grant execute on function public.comp_kick(uuid, int) to authenticated;
grant execute on function public.comp_stake(uuid, bigint[]) to authenticated;
grant execute on function public.comp_unstake(uuid) to authenticated;
grant execute on function public.comp_leave(uuid) to authenticated;
grant execute on function public.comp_start(uuid) to authenticated;
grant execute on function public.comp_ready(uuid) to authenticated;
grant execute on function public.comp_heartbeat(uuid) to authenticated;
grant execute on function public.comp_skip(uuid, int) to authenticated;
grant execute on function public.comp_forfeit(uuid) to authenticated;
grant execute on function public.comp_settle_stale(uuid) to authenticated;
grant execute on function public.comp_state(uuid) to authenticated;
grant execute on function public.my_comp_history(int) to authenticated;
grant execute on function public.comp_set_layout(uuid, text) to authenticated;
grant execute on function public.comp_rematch(uuid, text) to authenticated;

revoke all on function public.comp_count_call(uuid) from public, anon, authenticated;
revoke all on function public.comp_begin_throw(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.comp_apply_throw(uuid, uuid, int, double precision, double precision, jsonb, jsonb, int[], int)
  from public, anon, authenticated;
revoke all on function public.comp_void_version(uuid, int) from public, anon, authenticated;

grant execute on function public.comp_count_call(uuid) to service_role;
grant execute on function public.comp_begin_throw(uuid, uuid, int) to service_role;
grant execute on function public.comp_apply_throw(uuid, uuid, int, double precision, double precision, jsonb, jsonb, int[], int)
  to service_role;
grant execute on function public.comp_void_version(uuid, int) to service_role;

-- ——— закрытые каналы Realtime матча ———
-- comp:<uuid матча>     — слушать: участник; писать: только присутствие (presence).
--                         Запись броска (broadcast 'srv') шлёт только серверная функция с секретным ключом:
--                         клиенту broadcast в этот канал не разрешён вовсе, подделать 'srv' нельзя.
-- comp-aim:<uuid матча> — слушать и писать broadcast: участник. Здесь только линия прицела ('aim').
-- Условие на event в политиках не используется: Realtime проверяет право писать один раз, при входе
-- в канал, пробной строкой без event — такое условие закрыло бы broadcast целиком.

do $realtime$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'Нет таблицы realtime.messages: политики закрытого канала не созданы';
    return;
  end if;

  execute 'drop policy if exists "comp: участники слушают канал" on realtime.messages';
  execute $p$
    create policy "comp: участники слушают канал" on realtime.messages
      for select to authenticated
      using (private.is_comp_topic_member((select realtime.topic())))
  $p$;

  execute 'drop policy if exists "comp: игроки шлют только прицел" on realtime.messages';
  execute 'drop policy if exists "comp: игроки шлют присутствие и прицел" on realtime.messages';
  execute $p$
    create policy "comp: игроки шлют присутствие и прицел" on realtime.messages
      for insert to authenticated
      with check (
        private.is_comp_topic_member((select realtime.topic()))
        and ((left((select realtime.topic()), 5) = 'comp:' and realtime.messages.extension = 'presence')
             or (left((select realtime.topic()), 9) = 'comp-aim:' and realtime.messages.extension = 'broadcast'))
      )
  $p$;
end;
$realtime$;

-- Изменения строки матча — в Realtime (postgres_changes). Повторный запуск безопасен.
-- comp_players в публикации быть не должно: DELETE в postgres_changes уходят всем подписчикам
-- без RLS и без фильтра. О смене состава говорит comp_matches.players_rev — по нему клиент
-- перечитывает comp_state.
do $publication$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'Нет публикации supabase_realtime: postgres_changes для матча не включены';
    return;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comp_matches') then
    execute 'alter publication supabase_realtime add table public.comp_matches';
  end if;
  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comp_players') then
    execute 'alter publication supabase_realtime drop table public.comp_players';
  end if;
end;
$publication$;

-- По желанию (pg_cron): уборка зависших матчей раз в 5 минут.
--   select cron.schedule('comp-expire-stale', '*/5 * * * *', $$select private.comp_expire_stale(100)$$);
