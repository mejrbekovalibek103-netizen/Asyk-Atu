-- «Асық ату»: проверка ника, профиля и рейтинга (supabase/rating.sql).
--
-- Как запустить: SQL Editor → New query → вставить весь файл → Run (после rating.sql).
-- Ожидается таблица сценариев со словом PASS и последняя строка «ALL PASS».
-- Скрипт НЕ оставляет данных: всё создаётся внутри блока, который в конце откатывается.

create temp table if not exists rating_check_results (n int primary key, name text not null, ok boolean not null, info text);
truncate rating_check_results;

do $check$
declare
  v_names text[] := '{}';
  v_oks boolean[] := '{}';
  v_infos text[] := '{}';
  v_ok boolean;
  v_info text;
  v_msg text;
  v_crash text;
  v_i int;
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_ja text; v_jb text; v_jmail text;
  v_r jsonb;
  v_n int;
  v_txt text;
begin
  begin
    insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u.id, 'authenticated', 'authenticated', 'rating-check-' || u.id::text || '@example.invalid',
           '{"provider":"google","providers":["google"]}'::jsonb, '{}'::jsonb, now(), now()
    from unnest(array[v_a, v_b]) as u(id);
    insert into public.profiles (id) select u.id from unnest(array[v_a, v_b]) as u(id) on conflict (id) do nothing;
    insert into public.asyks (owner) select v_a from generate_series(1, 12);
    insert into public.asyks (owner) select v_b from generate_series(1, 3);
    v_ja := jsonb_build_object('sub', v_a, 'role', 'authenticated', 'aud', 'authenticated', 'is_anonymous', false,
                               'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_jb := jsonb_build_object('sub', v_b, 'role', 'authenticated', 'aud', 'authenticated', 'is_anonymous', false,
                               'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_jmail := jsonb_build_object('sub', v_b, 'role', 'authenticated', 'aud', 'authenticated', 'is_anonymous', false,
                                  'app_metadata', jsonb_build_object('provider', 'email'))::text;

    -- ——— 1. Напрямую профиль и асыки не изменить: ни свои, ни чужие ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jb, true);
      set local role authenticated;
      foreach v_txt in array array[
        format('update public.profiles set nickname = %L where id = %L', 'Хакер', v_a),
        format('update public.profiles set nickname = %L where id = %L', 'Хакер', v_b),
        format('update public.profiles set banned = false where id = %L', v_b),
        format('update public.asyks set owner = %L where owner = %L', v_b, v_a),
        format('insert into public.asyks (owner) values (%L)', v_b),
        format('delete from public.asyks where owner = %L', v_a),
        format('insert into public.profiles (id) values (%L)', gen_random_uuid()),
        format('delete from public.profiles where id = %L', v_a)
      ] loop
        v_msg := null;
        begin execute v_txt; exception when others then v_msg := sqlstate; end;
        if v_msg is distinct from '42501' then
          v_ok := false; v_info := v_info || ' [прошло: ' || left(v_txt, 50) || ' → ' || coalesce(v_msg, 'ok') || ']';
        end if;
      end loop;
      -- чужой профиль не прочитать (RLS): видно только свою строку
      select count(*) into v_n from public.profiles;
      if v_n <> 1 then
        v_ok := false; v_info := v_info || ' [видно профилей: ' || v_n || ']';
      end if;
      reset role;
      raise exception 'rating_check_rollback';
    exception when others then
      if sqlerrm <> 'rating_check_rollback' then v_ok := false; v_info := v_info || ' ошибка: ' || sqlerrm; end if;
    end;
    v_names := array_append(v_names, '1. Чужой и свой профиль/асыки напрямую не изменить'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 2. Без входа: рейтинг смотреть можно, профиль и ник — нельзя ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      set local role anon;
      v_r := public.leaderboard('asyks', 10);
      if v_r ->> 'me' is not null then v_ok := false; v_info := v_info || ' [у гостя есть me]'; end if;
      foreach v_txt in array array['select public.my_profile()', 'select public.set_nickname(''Гость'')',
                                   'select * from private.player_stats()', 'select nickname from public.profiles'] loop
        v_msg := null;
        begin execute v_txt; exception when others then v_msg := sqlstate; end;
        if v_msg is distinct from '42501' then
          v_ok := false; v_info := v_info || ' [гость: ' || v_txt || ' → ' || coalesce(v_msg, 'ok') || ']';
        end if;
      end loop;
      reset role;
      raise exception 'rating_check_rollback';
    exception when others then
      if sqlerrm <> 'rating_check_rollback' then v_ok := false; v_info := v_info || ' ошибка: ' || sqlerrm; end if;
    end;
    v_names := array_append(v_names, '2. Гость: только рейтинг'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 3. В рейтинге нет почты и внутренних id ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_r := public.leaderboard('asyks', 100);
      reset role;
      v_txt := v_r::text;
      if v_txt like '%' || v_a::text || '%' or v_txt like '%' || v_b::text || '%' or v_txt like '%@%' then
        v_ok := false; v_info := v_info || ' [в ответе есть uuid или почта]';
      end if;
      if exists (select 1 from jsonb_array_elements(v_r -> 'rows') e(x)
                 where e.x ?| array['id', 'user_id', 'email', 'owner']) then
        v_ok := false; v_info := v_info || ' [лишние поля в строках]';
      end if;
      if (v_r -> 'me' ->> 'asyks')::int <> 12 or not (v_r -> 'me' ->> 'me')::boolean then
        v_ok := false; v_info := v_info || ' [me неверный: ' || coalesce(v_r ->> 'me', 'null') || ']';
      end if;
      raise exception 'rating_check_rollback';
    exception when others then
      if sqlerrm <> 'rating_check_rollback' then v_ok := false; v_info := v_info || ' ошибка: ' || sqlerrm; end if;
    end;
    v_names := array_append(v_names, '3. Рейтинг без почты и id'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 4. Ник: проверки и занятость; меняется только свой ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_r := public.set_nickname('  Алибек_7  ');
      if v_r ->> 'nickname' <> 'Алибек_7' then v_ok := false; v_info := v_info || ' [ник не сохранился]'; end if;
      reset role;
      update public.profiles set nickname_at = null where id = v_a;
      perform set_config('request.jwt.claims', v_jb, true);
      set local role authenticated;
      foreach v_txt in array array['алибек_7|nick_taken', 'А|nick_short', '<b>x</b>|nick_chars', '1234|nick_chars',
                                   'Игрок 12|nick_reserved', 'SuperAdmin|nick_reserved'] loop
        v_msg := null;
        begin perform public.set_nickname(split_part(v_txt, '|', 1)); exception when others then v_msg := sqlerrm; end;
        if v_msg is distinct from split_part(v_txt, '|', 2) then
          v_ok := false; v_info := v_info || ' [' || split_part(v_txt, '|', 1) || ' → ' || coalesce(v_msg, 'принят') || ']';
        end if;
      end loop;
      reset role;
      -- ник A не изменился после попыток B
      if (select nickname from public.profiles where id = v_a) <> 'Алибек_7' then
        v_ok := false; v_info := v_info || ' [чужой ник изменился]';
      end if;
      -- слишком частая смена
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.set_nickname('Алибек'); exception when others then v_msg := sqlerrm; end;
      reset role;
      update public.profiles set nickname_at = now() where id = v_a;
      set local role authenticated;
      v_msg := null;
      begin perform public.set_nickname('Алибек2'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'rate_limited' then
        v_ok := false; v_info := v_info || ' [частая смена ника: ' || coalesce(v_msg, 'прошла') || ']';
      end if;
      raise exception 'rating_check_rollback';
    exception when others then
      if sqlerrm <> 'rating_check_rollback' then v_ok := false; v_info := v_info || ' ошибка: ' || sqlerrm; end if;
    end;
    v_names := array_append(v_names, '4. Ник: проверки, занятость, только свой'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 5. Почтовый аккаунт и заблокированный ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jmail, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.set_nickname('Почта'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'google_required' then
        v_ok := false; v_info := v_info || ' [почтовый аккаунт сменил ник: ' || coalesce(v_msg, 'прошло') || ']';
      end if;
      update public.profiles set banned = true where id = v_b;
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_r := public.leaderboard('asyks', 100);
      reset role;
      if exists (select 1 from jsonb_array_elements(v_r -> 'rows') e(x)
                 where (e.x ->> 'player_no')::bigint = (select player_no from public.profiles where id = v_b)) then
        v_ok := false; v_info := v_info || ' [заблокированный в рейтинге]';
      end if;
      raise exception 'rating_check_rollback';
    exception when others then
      if sqlerrm <> 'rating_check_rollback' then v_ok := false; v_info := v_info || ' ошибка: ' || sqlerrm; end if;
    end;
    v_names := array_append(v_names, '5. Только Google; заблокированных нет в рейтинге'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    raise exception 'rating_check_rollback';
  exception when others then
    if sqlerrm <> 'rating_check_rollback' then v_crash := sqlstate || ' ' || sqlerrm; end if;
  end;

  if v_crash is not null then
    insert into rating_check_results values (0, '0. Подготовка', false, v_crash);
  end if;
  for v_i in 1..coalesce(array_length(v_names, 1), 0) loop
    insert into rating_check_results values (v_i, v_names[v_i], v_oks[v_i], nullif(btrim(v_infos[v_i]), ''));
  end loop;
end;
$check$;

do $verdict$
declare
  v_fail text;
  v_total int;
begin
  select count(*) into v_total from rating_check_results;
  select string_agg(r.name || coalesce(' — ' || r.info, ''), '; ' order by r.n) into v_fail
  from rating_check_results r where not r.ok;
  if v_fail is not null then
    raise exception 'rating.check: FAIL — %', v_fail;
  end if;
  if v_total < 5 then
    raise exception 'rating.check: FAIL — выполнено сценариев: %', v_total;
  end if;
end;
$verdict$;

select r.n as "№", r.name as "сценарий", case when r.ok then 'PASS' else 'FAIL' end as "итог", coalesce(r.info, '') as "подробности"
from rating_check_results r
union all
select 100, 'ИТОГ', 'ALL PASS', 'все сценарии прошли, тестовые данные откатаны'
order by 1;
