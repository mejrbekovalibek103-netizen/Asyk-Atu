-- «Асық ату»: база данных игроков и коллекции асыков (этап Б).
--
-- Как применить: панель Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Скрипт можно запускать повторно: он ничего не удаляет и не дублирует.
--
-- Модель безопасности (в браузере есть только публичный ключ, поэтому вся защита — здесь):
--   * на обеих таблицах включён RLS; игрок может ЧИТАТЬ только свои строки;
--   * политик на вставку, изменение и удаление НЕТ — напрямую таблицы не меняет никто;
--   * все изменения делают функции ниже (security definer): они сами проверяют, кто их вызвал;
--   * стартовые асыки выдаются один раз и только аккаунту, вошедшему через Google
--     (анонимные и почтовые аккаунты асыков не получают — так сложнее «фермы» аккаунтов).
-- Секретный ключ (service_role) нигде не используется и не нужен.

-- ——— таблицы ———

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.asyks (
  id bigint generated always as identity primary key,
  owner uuid not null references public.profiles (id) on delete cascade,
  -- вид асыка: пока только обычный; редкие появятся позже
  kind text not null default 'bone' check (kind in ('bone')),
  created_at timestamptz not null default now()
);

create index if not exists asyks_owner_idx on public.asyks (owner);

-- ——— доступ: только чтение своего ———

alter table public.profiles enable row level security;
alter table public.asyks enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.asyks from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.asyks to authenticated;

drop policy if exists "profiles: читать свой" on public.profiles;
create policy "profiles: читать свой" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "asyks: читать свои" on public.asyks;
create policy "asyks: читать свои" on public.asyks
  for select to authenticated
  using (owner = (select auth.uid()));

-- ——— функции ———

-- Сколько асыков получает новый игрок.
create or replace function public.starter_asyks() returns int
  language sql immutable
  set search_path = ''
as $$ select 10 $$;

-- Первый вход: создать профиль и один раз выдать стартовые асыки.
-- Повторные вызовы ничего не меняют. Возвращает, сколько асыков выдано (10 или 0).
create or replace function public.ensure_profile() returns int
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  claims jsonb := auth.jwt();
  created int;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  -- только аккаунт Google: не анонимный и не почтовый
  if coalesce((claims ->> 'is_anonymous')::boolean, false)
     or coalesce(claims -> 'app_metadata' ->> 'provider', '') <> 'google' then
    raise exception 'google sign-in required' using errcode = '42501';
  end if;

  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  get diagnostics created = row_count;
  if created = 0 then
    return 0; -- профиль уже был: асыки выданы раньше
  end if;

  insert into public.asyks (owner)
    select uid from generate_series(1, public.starter_asyks());
  return public.starter_asyks();
end;
$$;

revoke all on function public.ensure_profile() from public, anon;
grant execute on function public.ensure_profile() to authenticated;
revoke all on function public.starter_asyks() from public, anon;
grant execute on function public.starter_asyks() to authenticated;
