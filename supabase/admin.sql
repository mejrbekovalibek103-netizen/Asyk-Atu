-- «Асық ату»: служебная таблица для владельца — сколько асыков у каждого игрока.
--
-- Как применить: SQL Editor → New query → вставить весь файл → Run (после schema.sql, competitive.sql, rating.sql).
-- Скрипт можно запускать повторно.
--
-- Где смотреть: Table Editor → вверху слева выбрать схему «private» → «asyk_counts».
-- Или в SQL Editor: select * from private.asyk_counts;
--
-- Это представление (view), а не отдельная таблица: числа считаются заново из public.asyks при каждом открытии,
-- поэтому всегда точные и не могут «разойтись» с настоящими асыками. Изменить через него ничего нельзя.
--
-- Безопасность: в представлении есть почта игроков, поэтому оно лежит в схеме private (API Supabase её не
-- публикует) и закрыто от anon и authenticated. Видит его только владелец проекта в панели Supabase.
-- В конце скрипт сам проверяет, что игроки и гости прочитать его не могут.

-- пересоздаём с нуля: так повторный запуск проходит, даже если колонки в новой версии другие
drop view if exists private.asyk_counts;
drop view if exists private.asyk_totals;

create view private.asyk_counts
  with (security_invoker = true)
as
select
  pr.player_no                                                   as "ID",
  coalesce(pr.nickname, 'Игрок ' || pr.player_no::text)          as "имя",
  u.email                                                        as "почта",
  count(a.id)                                                    as "асыков всего",
  count(a.id) filter (where a.locked_match is null)              as "свободно",
  count(a.id) filter (where a.locked_match is not null)          as "в коне",
  coalesce(s.wins, 0)                                            as "побед",
  coalesce(s.played, 0)                                          as "игр",
  pr.banned                                                      as "заблокирован",
  pr.created_at                                                  as "первый вход",
  max(a.acquired_at)                                             as "последний полученный асык"
from public.profiles pr
join auth.users u on u.id = pr.id
left join public.asyks a on a.owner = pr.id
left join private.player_stats() s on s.id = pr.id
group by pr.id, pr.player_no, pr.nickname, u.email, s.wins, s.played, pr.banned, pr.created_at
order by "асыков всего" desc, pr.player_no;

comment on view private.asyk_counts is
  'Для владельца: сколько асыков у каждого игрока (всего, свободно, в коне), победы и игры. Только чтение.';

-- Итог по всей игре одной строкой: игроков, асыков, в среднем на игрока.
create view private.asyk_totals
  with (security_invoker = true)
as
select
  count(distinct pr.id)                                          as "игроков",
  (select count(*) from public.asyks)                            as "асыков всего",
  (select count(*) from public.asyks a where a.locked_match is not null) as "в коне сейчас",
  round((select count(*) from public.asyks)::numeric / nullif(count(distinct pr.id), 0), 1) as "в среднем на игрока"
from public.profiles pr;

comment on view private.asyk_totals is 'Для владельца: сводка по асыкам всей игры. Только чтение.';

-- ——— права: только владелец (роль postgres в панели) ———
revoke all on private.asyk_counts from public, anon, authenticated;
revoke all on private.asyk_totals from public, anon, authenticated;

-- ——— самопроверка: игроки и гости не должны иметь доступа ———
do $verify$
declare
  v_role text;
  v_view text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_view in array array['private.asyk_counts', 'private.asyk_totals'] loop
      if has_table_privilege(v_role, v_view, 'select') then
        raise exception 'admin.sql: FAIL — роль % может читать %', v_role, v_view;
      end if;
    end loop;
  end loop;
  -- схему private API не публикует; если кто-то добавил её в Exposed schemas — предупредить
  if exists (
    select 1 from pg_catalog.pg_db_role_setting s
    where s.setconfig::text like '%pgrst.db_schemas%private%'
  ) then
    raise warning 'admin.sql: схема private добавлена в Exposed schemas API — уберите её в Settings → API';
  end if;
  raise notice 'admin.sql: PASS — представления видны только владельцу';
end;
$verify$;

-- Показать результат сразу после запуска
select * from private.asyk_counts;
