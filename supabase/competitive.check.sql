-- «Асық ату»: проверка соревновательного режима (supabase/competitive.sql).
--
-- Как запустить: SQL Editor → New query → вставить весь файл → Run (после competitive.sql).
-- Ожидается таблица сценариев, все со словом PASS, и последняя строка «ALL PASS».
-- Если что-то не так — скрипт закончится ошибкой «competitive.check: FAIL — …» со списком сценариев.
--
-- Скрипт НЕ оставляет данных: тестовые пользователи, асыки и матчи создаются внутри блока,
-- который в конце откатывается целиком. Игроки имитируются через
-- set local role authenticated + request.jwt.claims, серверная функция — через set local role service_role.
-- Время внутри транзакции стоит на месте (now() не меняется), поэтому «прошло 20 с» имитируется
-- сдвигом полей дедлайна и пульса прямо в тестовых строках.

create temp table if not exists comp_check_results (
  n int primary key,
  name text not null,
  ok boolean not null,
  info text
);
truncate comp_check_results;

do $check$
declare
  v_names text[] := '{}';
  v_oks boolean[] := '{}';
  v_infos text[] := '{}';
  v_ok boolean;
  v_info text;
  v_msg text;
  v_sql text;
  v_crash text;
  v_i int;
  v_n int;
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();   -- у него только 4 асыка
  v_e uuid := gen_random_uuid();
  v_ja text; v_jb text; v_jc text; v_jd text; v_je text; v_jmail text;
  v_jsrv constant text := '{"role":"service_role"}';
  v_janon constant text := '{"role":"anon"}';
  v_m uuid;            -- основной матч A и B, уже active
  v_code text;
  v_first uuid;        -- игрок места 0 (ходит первым)
  v_second uuid;       -- игрок места 1
  v_jf text; v_js text;
  v_m2 uuid; v_code2 text; v_m3 uuid; v_code3 text;
  v_r jsonb; v_r2 jsonb;
  v_ids bigint[]; v_ids2 bigint[];
  v_slot int; v_slot2 int; v_asyk bigint;
  v_final jsonb; v_x jsonb; v_y jsonb;
  v_seed text;
  v_ts timestamptz;
  v_bool boolean;
  v_detail text;
  v_rev int;
begin
  begin -- всё внутри откатывается в конце
    -- ——— подготовка: 5 тестовых пользователей Google ———
    insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u.id, 'authenticated', 'authenticated', 'comp-check-' || u.id::text || '@example.invalid',
           '{"provider":"google","providers":["google"]}'::jsonb, '{}'::jsonb, now(), now()
    from unnest(array[v_a, v_b, v_c, v_d, v_e]) as u(id);
    insert into public.profiles (id)
    select u.id from unnest(array[v_a, v_b, v_c, v_d, v_e]) as u(id)
    on conflict (id) do nothing;
    delete from public.asyks a where a.owner in (v_a, v_b, v_c, v_d, v_e);
    insert into public.asyks (owner)
    select u.id from unnest(array[v_a, v_b, v_c, v_e]) as u(id) cross join generate_series(1, 10);
    insert into public.asyks (owner) select v_d from generate_series(1, 4);

    v_ja := jsonb_build_object('sub', v_a, 'role', 'authenticated', 'aud', 'authenticated',
                               'is_anonymous', false, 'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_jb := jsonb_build_object('sub', v_b, 'role', 'authenticated', 'aud', 'authenticated',
                               'is_anonymous', false, 'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_jc := jsonb_build_object('sub', v_c, 'role', 'authenticated', 'aud', 'authenticated',
                               'is_anonymous', false, 'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_jd := jsonb_build_object('sub', v_d, 'role', 'authenticated', 'aud', 'authenticated',
                               'is_anonymous', false, 'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_je := jsonb_build_object('sub', v_e, 'role', 'authenticated', 'aud', 'authenticated',
                               'is_anonymous', false, 'app_metadata', jsonb_build_object('provider', 'google'))::text;
    v_jmail := jsonb_build_object('sub', v_c, 'role', 'authenticated', 'aud', 'authenticated',
                                  'is_anonymous', false, 'app_metadata', jsonb_build_object('provider', 'email'))::text;

    -- ——— подготовка: основной матч A (хозяин) и B, обе ставки, жребий, «Я здесь» ———
    perform set_config('request.jwt.claims', v_ja, true);
    set local role authenticated;
    v_r := public.comp_open('stake-line', '0123456789abcdef', 'Асан');
    v_m := (v_r ->> 'match_id')::uuid;
    v_code := v_r ->> 'join_code';
    perform public.comp_stake(v_m);
    perform set_config('request.jwt.claims', v_jb, true);
    perform public.comp_join(v_code, 'fedcba9876543210', 'Бек');
    perform public.comp_stake(v_m);
    perform set_config('request.jwt.claims', v_ja, true);
    perform public.comp_start(v_m);
    perform public.comp_ready(v_m);
    perform set_config('request.jwt.claims', v_jb, true);
    perform public.comp_ready(v_m);
    reset role;

    select p.user_id into v_first from public.comp_players p where p.match_id = v_m and p.seat = 0;
    select p.user_id into v_second from public.comp_players p where p.match_id = v_m and p.seat = 1;
    if v_first is null or v_second is null
       or (select m.status from public.comp_matches m where m.id = v_m) <> 'active'
       or (select count(*) from public.comp_stakes s where s.match_id = v_m) <> 10 then
      raise exception 'подготовка: основной матч не стал active с 10 слотами';
    end if;
    v_jf := case when v_first = v_a then v_ja else v_jb end;
    v_js := case when v_second = v_a then v_ja else v_jb end;

    -- ——— 1. Служебные и внутренние функции закрыты от authenticated и anon ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      foreach v_sql in array array[
        format('select public.comp_begin_throw(%L::uuid, %L::uuid, 1)', v_m, v_first),
        format('select public.comp_apply_throw(%L::uuid, %L::uuid, 1, 0.1::float8, 0.5::float8, null::jsonb, %L::jsonb, %L::int[], 10)',
               v_m, v_first, '[]', '{}'),
        format('select public.comp_void_version(%L::uuid, 0)', v_m),
        format('select public.comp_count_call(%L::uuid)', v_a),
        format('select private.comp_settle(%L::uuid, %L)', v_m, 'x'),
        format('select private.comp_refund(%L::uuid, %L)', v_m, 'x'),
        format('select private.comp_deal(%L::uuid)', v_m),
        format('select private.comp_advance(%L::uuid, interval %L)', v_m, '0 seconds'),
        format('select private.comp_do_forfeit(%L::uuid, %L::uuid)', v_m, v_a),
        format('select private.comp_state_json(%L::uuid, %L::uuid)', v_m, v_b),
        format('select private.comp_lazy_expire(%L::uuid, true)', v_m),
        'select private.comp_caller()',
        'select private.comp_expire_stale(10)',
        'select private.comp_sim_version()'
      ] loop
        v_msg := null;
        begin
          execute v_sql;
        exception when others then
          v_msg := sqlstate;
        end;
        if v_msg is distinct from '42501' then
          v_ok := false;
          v_info := v_info || ' [authenticated: ' || v_sql || ' → ' || coalesce(v_msg, 'выполнилось') || ']';
        end if;
      end loop;
      reset role;

      perform set_config('request.jwt.claims', v_janon, true);
      set local role anon;
      foreach v_sql in array array[
        format('select public.comp_begin_throw(%L::uuid, %L::uuid, 1)', v_m, v_first),
        format('select public.comp_apply_throw(%L::uuid, %L::uuid, 1, 0.1::float8, 0.5::float8, null::jsonb, %L::jsonb, %L::int[], 10)',
               v_m, v_first, '[]', '{}'),
        format('select public.comp_void_version(%L::uuid, 0)', v_m),
        format('select public.comp_count_call(%L::uuid)', v_a),
        format('select private.comp_settle(%L::uuid, %L)', v_m, 'x'),
        format('select private.is_comp_member(%L::uuid)', v_m),
        format('select public.comp_state(%L::uuid)', v_m),
        format('select public.comp_heartbeat(%L::uuid)', v_m),
        format('select public.comp_skip(%L::uuid, 1)', v_m),
        format('select public.comp_open(%L, %L, %L)', 'stake-line', '0123456789abcdef', 'x'),
        'select public.my_comp_history(5)',
        'select count(*) from public.comp_matches',
        'select count(*) from private.comp_secrets'
      ] loop
        v_msg := null;
        begin
          execute v_sql;
        exception when others then
          v_msg := sqlstate;
        end;
        if v_msg is distinct from '42501' then
          v_ok := false;
          v_info := v_info || ' [anon: ' || v_sql || ' → ' || coalesce(v_msg, 'выполнилось') || ']';
        end if;
      end loop;
      reset role;

      -- вход не через Google — отказ
      perform set_config('request.jwt.claims', v_jmail, true);
      set local role authenticated;
      v_msg := null;
      begin
        perform public.comp_open('stake-line', '0123456789abcdef', 'x');
      exception when others then
        v_msg := sqlerrm;
      end;
      reset role;
      if v_msg is distinct from 'google_required' then
        v_ok := false; v_info := v_info || ' [вход по почте: ' || coalesce(v_msg, 'пустил') || ']';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '1. Служебные и внутренние функции закрыты'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 2. Секрет и чужие данные не читаются ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      foreach v_sql in array array[
        'select count(*) from private.comp_secrets',
        'select count(*) from private.comp_calls',
        'select count(*) from private.comp_kicked',
        'select user_id from public.comp_players limit 1',
        'select client_id from public.comp_players limit 1',
        'select host from public.comp_matches limit 1',
        'select pending_by from public.comp_matches limit 1',
        'select asyk_id from public.comp_stakes limit 1',
        'select owner_user from public.comp_stakes limit 1',
        'select user_id from public.comp_throws limit 1',
        'select count(*) from public.asyk_transfers',
        'insert into public.comp_throws (match_id, throw_no, seat, user_id, kind) values (gen_random_uuid(), 1, 0, gen_random_uuid(), ''skip'')',
        format('update public.comp_matches set status = %L where id = %L::uuid', 'settled', v_m),
        format('update public.asyks set locked_match = null where locked_match = %L::uuid', v_m)
      ] loop
        v_msg := null;
        begin
          execute v_sql;
        exception when others then
          v_msg := sqlstate;
        end;
        if v_msg is distinct from '42501' then
          v_ok := false;
          v_info := v_info || ' [' || v_sql || ' → ' || coalesce(v_msg, 'выполнилось') || ']';
        end if;
      end loop;

      select count(m.id) into v_n from public.comp_matches m where m.id = v_m;
      if v_n <> 1 then v_ok := false; v_info := v_info || ' [участник не видит матч]'; end if;
      select count(s.slot) into v_n from public.comp_stakes s where s.match_id = v_m;
      if v_n <> 10 then v_ok := false; v_info := v_info || ' [участник видит слотов: ' || v_n || ']'; end if;
      v_r := public.comp_state(v_m);
      reset role;

      if has_sequence_privilege('authenticated', pg_get_serial_sequence('public.asyk_transfers', 'id'), 'USAGE')
         or has_sequence_privilege('anon', pg_get_serial_sequence('public.asyk_transfers', 'id'), 'USAGE') then
        v_ok := false; v_info := v_info || ' [последовательность журнала выдана игрокам]';
      end if;

      select encode(s.seed, 'hex') into v_seed from private.comp_secrets s where s.match_id = v_m;
      if position(v_seed in v_r::text) > 0 or v_r::text like '%"seed"%' then
        v_ok := false; v_info := v_info || ' [секрет в comp_state]';
      end if;
      if position(v_a::text in v_r::text) > 0 or position(v_b::text in v_r::text) > 0 then
        v_ok := false; v_info := v_info || ' [uuid игрока в comp_state]';
      end if;
      if jsonb_array_length(v_r -> 'slots') <> 10
         or (select count(*) from jsonb_array_elements(v_r -> 'slots') as e(x)
             where (e.x ->> 'mine')::boolean and e.x -> 'asyk_id' <> 'null'::jsonb) <> 5
         or exists (select 1 from jsonb_array_elements(v_r -> 'slots') as e(x)
                    where not (e.x ->> 'mine')::boolean and e.x -> 'asyk_id' <> 'null'::jsonb) then
        v_ok := false; v_info := v_info || ' [слоты: свои id не те или видны чужие]';
      end if;
      if v_r -> 'match' ->> 'status' <> 'active' or (v_r -> 'match' ->> 'throws_per_player')::int <> 15
         or (v_r -> 'match' ->> 'kon_size')::int <> 10 then
        v_ok := false; v_info := v_info || ' [форма comp_state]';
      end if;

      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      select count(m.id) into v_n from public.comp_matches m where m.id = v_m;
      if v_n <> 0 then v_ok := false; v_info := v_info || ' [чужой видит матч]'; end if;
      select count(p.match_id) into v_n from public.comp_players p where p.match_id = v_m;
      if v_n <> 0 then v_ok := false; v_info := v_info || ' [чужой видит игроков]'; end if;
      v_msg := null;
      begin
        perform public.comp_state(v_m);
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_msg is distinct from 'not_member' then
        v_ok := false; v_info := v_info || ' [comp_state чужому: ' || coalesce(v_msg, 'отдал') || ']';
      end if;
      reset role;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '2. Секрет и чужие данные не читаются'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 3. Двойная ставка: повтор не ставит заново, второй матч не пускает ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_r := public.comp_open('stake-ring', '1111111111111111', 'Сәкен');
      v_m2 := (v_r ->> 'match_id')::uuid;
      v_ids := public.comp_stake(v_m2);
      v_ids2 := public.comp_stake(v_m2);
      if cardinality(v_ids) <> 5 or v_ids is distinct from v_ids2 then
        v_ok := false; v_info := v_info || ' [повторная ставка вернула другое]';
      end if;

      perform set_config('request.jwt.claims', v_je, true);
      v_r := public.comp_open('stake-scatter', '2222222222222222', 'Ерлан');
      v_m3 := (v_r ->> 'match_id')::uuid;
      v_code3 := v_r ->> 'join_code';

      perform set_config('request.jwt.claims', v_jc, true);
      v_msg := null;
      begin
        perform public.comp_join(v_code3, '1111111111111111', 'Сәкен');
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_msg is distinct from 'already_in_match' then
        v_ok := false; v_info := v_info || ' [вход во второй матч: ' || coalesce(v_msg, 'пустил') || ']';
      end if;
      v_msg := null;
      begin
        perform public.comp_stake(v_m3);
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_msg is distinct from 'not_member' then
        v_ok := false; v_info := v_info || ' [ставка в чужой матч: ' || coalesce(v_msg, 'приняла') || ']';
      end if;

      perform set_config('request.jwt.claims', v_ja, true);
      v_msg := null;
      begin
        perform public.comp_open('stake-line', '0123456789abcdef', 'Асан');
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_msg is distinct from 'already_in_match' then
        v_ok := false; v_info := v_info || ' [второй матч у игрока в игре: ' || coalesce(v_msg, 'создан') || ']';
      end if;
      reset role;

      select count(*) into v_n from public.asyks a where a.owner = v_c and a.locked_match is not null;
      if v_n <> 5 then v_ok := false; v_info := v_info || ' [в коне у C: ' || v_n || ']'; end if;
      select count(*) into v_n from public.asyks a where a.owner = v_c and a.locked_match = v_m2;
      if v_n <> 5 then v_ok := false; v_info := v_info || ' [в коне M2 у C: ' || v_n || ']'; end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '3. Двойная ставка — отказ'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 4. Ставка при 4 асыках → not_enough ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jd, true);
      set local role authenticated;
      v_r := public.comp_open('stake-line', '3333333333333333', 'Дана');
      v_m2 := (v_r ->> 'match_id')::uuid;
      v_msg := null;
      begin
        perform public.comp_stake(v_m2);
      exception when others then
        v_msg := sqlerrm;
      end;
      reset role;
      if v_msg is distinct from 'not_enough' then
        v_ok := false; v_info := v_info || ' [ставка при 4: ' || coalesce(v_msg, 'приняла') || ']';
      end if;
      select count(*) into v_n from public.asyks a where a.owner = v_d and a.locked_match is not null;
      if v_n <> 0 then v_ok := false; v_info := v_info || ' [остались под замком: ' || v_n || ']'; end if;
      if (select p.staked from public.comp_players p where p.match_id = v_m2 and p.user_id = v_d) then
        v_ok := false; v_info := v_info || ' [staked = true]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '4. Ставка при 4 асыках — not_enough'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 5. Чужой ход и неверный номер броска → отказ ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_msg := null;
      begin perform public.comp_begin_throw(v_m, v_second, 1); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'not_your_turn' then
        v_ok := false; v_info := v_info || ' [чужой ход: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_begin_throw(v_m, v_first, 2); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'stale_throw' then
        v_ok := false; v_info := v_info || ' [номер 2: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_begin_throw(v_m, v_first, 0); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'stale_throw' then
        v_ok := false; v_info := v_info || ' [номер 0: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_begin_throw(v_m, v_c, 1); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'not_member' then
        v_ok := false; v_info := v_info || ' [не участник: ' || coalesce(v_msg, 'принят') || ']';
      end if;

      v_r := public.comp_begin_throw(v_m, v_first, 1);
      if length(v_r ->> 'seed') <> 64 or v_r -> 'replay' <> 'null'::jsonb or (v_r ->> 'players')::int <> 2
         or v_r ->> 'layout_id' <> 'stake-line' then
        v_ok := false; v_info := v_info || ' [ответ comp_begin_throw: ' || v_r::text || ']';
      end if;
      v_msg := null;
      begin
        perform public.comp_apply_throw(v_m, v_second, 1, 0.1, 0.5, null, '[]'::jsonb, '{}'::int[], 10);
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_msg is distinct from 'not_pending' then
        v_ok := false; v_info := v_info || ' [запись чужим: ' || coalesce(v_msg, 'принята') || ']';
      end if;
      reset role;
      if (select m.pending_by from public.comp_matches m where m.id = v_m) is distinct from v_first then
        v_ok := false; v_info := v_info || ' [нет отметки pending]';
      end if;

      perform set_config('request.jwt.claims', v_js, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_skip(v_m, 5); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'stale_throw' then
        v_ok := false; v_info := v_info || ' [пропуск с неверным номером: ' || coalesce(v_msg, 'принят') || ']';
      end if;

      -- лимит 30 вызовов в минуту: счётчик ведёт comp_count_call, отказы его не откатывают
      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      for v_i in 1..30 loop
        if not public.comp_count_call(v_first) then
          v_ok := false; v_info := v_info || ' [вызов ' || v_i || ' отклонён лимитом]';
        end if;
      end loop;
      if public.comp_count_call(v_first) then
        v_ok := false; v_info := v_info || ' [31-й вызов в минуту пропущен]';
      end if;
      v_msg := null;
      begin perform public.comp_begin_throw(v_m, v_first, 1); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'rate_limited' then
        v_ok := false; v_info := v_info || ' [comp_begin_throw после лимита: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '5. Чужой ход и неверный throw_no — отказ'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 6. Повтор comp_apply_throw — тот же результат, без двойного зачёта; проверки броска ———
    v_ok := true; v_info := '';
    begin
      select s.slot into v_slot from public.comp_stakes s
      where s.match_id = v_m and s.owner_user = v_second order by s.slot limit 1;
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0,
               case when s.knocked_by_seat is null and s.slot <> v_slot then 1 else 0 end) order by s.slot)
        into v_final
      from public.comp_stakes s where s.match_id = v_m;

      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_first, 1);
      v_r2 := public.comp_apply_throw(v_m, v_first, 1, 0.1, 0.5, v_r -> 'kon_state', v_final, array[v_slot], 240);
      if (v_r2 ->> 'duplicate')::boolean or v_r2 -> 'knocked' <> jsonb_build_array(v_slot) then
        v_ok := false; v_info := v_info || ' [первая запись: ' || v_r2::text || ']';
      end if;
      v_r2 := public.comp_apply_throw(v_m, v_first, 1, 0.1, 0.5, v_r -> 'kon_state', v_final, array[v_slot], 240);
      if not (v_r2 ->> 'duplicate')::boolean then
        v_ok := false; v_info := v_info || ' [повтор не распознан]';
      end if;
      v_r := public.comp_begin_throw(v_m, v_first, 1);
      if v_r -> 'replay' = 'null'::jsonb or (v_r -> 'replay' ->> 'throw_no')::int <> 1 then
        v_ok := false; v_info := v_info || ' [повтор начала броска без replay]';
      end if;
      reset role;

      if (select count(*) from public.comp_throws t where t.match_id = v_m) <> 1 then
        v_ok := false; v_info := v_info || ' [строк бросков не 1]';
      end if;
      if (select p.knocked from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 1
         or (select p.throws from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 1
         or (select p.real_throws from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 1 then
        v_ok := false; v_info := v_info || ' [двойной зачёт счёта]';
      end if;
      if (select count(*) from public.comp_stakes s where s.match_id = v_m and s.knocked_by_seat is not null) <> 1
         or (select s.knocked_by_seat from public.comp_stakes s where s.match_id = v_m and s.slot = v_slot) <> 0 then
        v_ok := false; v_info := v_info || ' [выбитые в comp_stakes]';
      end if;
      if (select m.throw_no from public.comp_matches m where m.id = v_m) <> 1
         or (select m.current_seat from public.comp_matches m where m.id = v_m) <> 1
         or (select m.turn_deadline from public.comp_matches m where m.id = v_m) <> now() + interval '47 seconds'
         or (select m.turn_started_at from public.comp_matches m where m.id = v_m) <> now() + interval '2 seconds'
         or (select m.kon_state from public.comp_matches m where m.id = v_m) <> v_final
         or (select m.pending_at from public.comp_matches m where m.id = v_m) is not null then
        v_ok := false; v_info := v_info || ' [переход хода или дедлайн = now + 240/120 с + 45 с]';
      end if;

      -- проверки корректности следующего броска (ход места 1)
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0, 1) order by s.slot) into v_x
      from public.comp_stakes s where s.match_id = v_m;                       -- «воскрешение» выбитого
      select s.slot into v_slot2 from public.comp_stakes s
      where s.match_id = v_m and s.knocked_by_seat is null order by s.slot limit 1;
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0,
               case when s.knocked_by_seat is null and s.slot <> v_slot2 then 1 else 0 end) order by s.slot)
        into v_y
      from public.comp_stakes s where s.match_id = v_m;                       -- выбит v_slot2

      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_second, 2);
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, v_r -> 'kon_state', v_x, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'resurrection' then
        v_ok := false; v_info := v_info || ' [воскрешение: ' || coalesce(v_msg, 'принято') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, v_r -> 'kon_state', v_y, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_knocked' then
        v_ok := false; v_info := v_info || ' [knocked не совпадает с final: ' || coalesce(v_msg, 'принято') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, v_r -> 'kon_state', v_y,
                                            array[v_slot2, v_slot2], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_knocked' then
        v_ok := false; v_info := v_info || ' [повтор слота в knocked: ' || coalesce(v_msg, 'принято') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 2.0, 0.5, v_r -> 'kon_state', v_final, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_angle' then
        v_ok := false; v_info := v_info || ' [угол 2 рад: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 'NaN'::float8, 0.5, v_r -> 'kon_state', v_final, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_angle' then
        v_ok := false; v_info := v_info || ' [угол NaN: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.01, v_r -> 'kon_state', v_final, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_power' then
        v_ok := false; v_info := v_info || ' [сила 0,01: ' || coalesce(v_msg, 'принята') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, null, v_final, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_kon_before' then
        v_ok := false; v_info := v_info || ' [чужой kon_before: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, v_r -> 'kon_state', '[[0,1,2,3,1]]'::jsonb, '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_final' then
        v_ok := false; v_info := v_info || ' [короткий final: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, v_r -> 'kon_state',
                                            jsonb_set(v_final, '{0,1}', '"x"'::jsonb), '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_final' then
        v_ok := false; v_info := v_info || ' [строка в final: ' || coalesce(v_msg, 'принята') || ']';
      end if;
      v_msg := null;
      begin perform public.comp_apply_throw(v_m, v_second, 2, 0.1, 0.5, v_r -> 'kon_state',
                                            (select jsonb_agg(o.x order by o.i desc)
                                             from jsonb_array_elements(v_final) with ordinality as o(x, i)),
                                            '{}'::int[], 100);
      exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_final' then
        v_ok := false; v_info := v_info || ' [слоты не по порядку: ' || coalesce(v_msg, 'приняты') || ']';
      end if;
      reset role;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '6. Повтор comp_apply_throw и проверки броска'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 7. Повторная раздача → без изменений; история без чужих uuid ———
    v_ok := true; v_info := '';
    begin
      select s.slot, s.asyk_id into v_slot, v_asyk from public.comp_stakes s
      where s.match_id = v_m and s.owner_user = v_second order by s.slot limit 1;
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0,
               case when s.slot <> v_slot then 1 else 0 end) order by s.slot)
        into v_final
      from public.comp_stakes s where s.match_id = v_m;
      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_first, 1);
      perform public.comp_apply_throw(v_m, v_first, 1, -0.2, 0.7, v_r -> 'kon_state', v_final, array[v_slot], 120);
      reset role;

      perform private.comp_settle(v_m, 'test');
      for v_i in 1..2 loop
        if (select m.status from public.comp_matches m where m.id = v_m) <> 'settled'
           or (select a.owner from public.asyks a where a.id = v_asyk) <> v_first
           or (select count(*) from public.asyk_transfers t where t.match_id = v_m) <> 1
           or (select count(*) from public.asyks a where a.locked_match = v_m) <> 0
           or (select count(*) from public.asyks a where a.owner = v_first) <> 11
           or (select count(*) from public.asyks a where a.owner = v_second) <> 9
           or (select pr.comp_played from public.profiles pr where pr.id = v_first) <> 1
           or (select pr.comp_played from public.profiles pr where pr.id = v_second) <> 1
           or exists (select 1 from public.comp_players p where p.match_id = v_m and p.active) then
          v_ok := false; v_info := v_info || ' [раздача, проход ' || v_i || ']';
        end if;
        -- второй проход: повторная раздача и возврат после раздачи ничего не меняют
        perform private.comp_settle(v_m, 'test');
        perform private.comp_refund(v_m, 'test');
      end loop;

      perform set_config('request.jwt.claims', v_jf, true);
      set local role authenticated;
      v_r := public.my_comp_history(10);
      v_r2 := public.comp_state(v_m);
      reset role;
      if jsonb_array_length(v_r) <> 1 or (v_r -> 0 ->> 'won')::int <> 1 or (v_r -> 0 ->> 'lost')::int <> 0
         or position(v_second::text in v_r::text) > 0 or position(v_first::text in v_r::text) > 0 then
        v_ok := false; v_info := v_info || ' [история: ' || v_r::text || ']';
      end if;
      if (v_r2 -> 'result' ->> 'delta')::int <> 1 or jsonb_array_length(v_r2 -> 'result' -> 'won') <> 1
         or jsonb_array_length(v_r2 -> 'result' -> 'returned') <> 5 then
        v_ok := false; v_info := v_info || ' [итог в comp_state: ' || coalesce((v_r2 -> 'result')::text, 'null') || ']';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '7. Повторная раздача — без изменений'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 8. comp_skip раньше срока или при свежем pending → отказ; старый pending → сбой ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_js, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_skip(v_m, 1); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'too_early' then
        v_ok := false; v_info := v_info || ' [сразу: ' || coalesce(v_msg, 'пропустил') || ']';
      end if;
      reset role;

      update public.comp_matches m set turn_deadline = now() - interval '4 seconds' where m.id = v_m;
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_skip(v_m, 1); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'too_early' then
        v_ok := false; v_info := v_info || ' [дедлайн + 4 с: ' || coalesce(v_msg, 'пропустил') || ']';
      end if;
      reset role;

      update public.comp_matches m
         set turn_deadline = now() - interval '6 seconds', pending_by = v_first, pending_at = now() - interval '5 seconds'
       where m.id = v_m;
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_skip(v_m, 1); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'pending' then
        v_ok := false; v_info := v_info || ' [свежий pending: ' || coalesce(v_msg, 'пропустил') || ']';
      end if;
      reset role;

      update public.comp_matches m set pending_at = now() - interval '25 seconds' where m.id = v_m;
      set local role authenticated;
      perform public.comp_skip(v_m, 1);
      reset role;
      if (select t.kind from public.comp_throws t where t.match_id = v_m and t.throw_no = 1) is distinct from 'fail'
         or (select p.skips_in_row from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 0
         or (select p.throws from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 1
         or (select m.current_seat from public.comp_matches m where m.id = v_m) <> 1
         or (select m.pending_at from public.comp_matches m where m.id = v_m) is not null then
        v_ok := false; v_info := v_info || ' [старый pending должен дать fail без штрафа]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '8. Ранний пропуск и свежий pending — отказ'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 9. Два пропуска подряд → сдача; асыки сдавшегося остаются в коне ———
    v_ok := true; v_info := '';
    begin
      update public.comp_matches m set turn_deadline = now() - interval '6 seconds' where m.id = v_m;
      perform set_config('request.jwt.claims', v_js, true);
      set local role authenticated;
      perform public.comp_skip(v_m, 1);                 -- пропущен ход места 0
      reset role;
      update public.comp_matches m set turn_deadline = now() - interval '6 seconds' where m.id = v_m;
      perform set_config('request.jwt.claims', v_jf, true);
      set local role authenticated;
      perform public.comp_skip(v_m, 2);                 -- пропущен ход места 1
      reset role;
      update public.comp_matches m set turn_deadline = now() - interval '6 seconds' where m.id = v_m;
      perform set_config('request.jwt.claims', v_js, true);
      set local role authenticated;
      perform public.comp_skip(v_m, 3);                 -- второй пропуск места 0 → сдача
      reset role;

      if not (select p.forfeited from public.comp_players p where p.match_id = v_m and p.user_id = v_first)
         or (select p.skips_in_row from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 2
         or (select p.forfeited from public.comp_players p where p.match_id = v_m and p.user_id = v_second)
         or (select m.status from public.comp_matches m where m.id = v_m) <> 'active'
         or (select m.current_seat from public.comp_matches m where m.id = v_m) <> 1
         or (select m.throw_no from public.comp_matches m where m.id = v_m) <> 3 then
        v_ok := false; v_info := v_info || ' [сдача после 2 пропусков]';
      end if;

      select s.slot, s.asyk_id into v_slot, v_asyk from public.comp_stakes s
      where s.match_id = v_m and s.owner_user = v_first order by s.slot limit 1;
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0,
               case when s.slot <> v_slot then 1 else 0 end) order by s.slot)
        into v_final
      from public.comp_stakes s where s.match_id = v_m;
      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_second, 4);
      perform public.comp_apply_throw(v_m, v_second, 4, 0.0, 0.9, v_r -> 'kon_state', v_final, array[v_slot], 60);
      v_msg := null;
      begin perform public.comp_begin_throw(v_m, v_first, 5); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'forfeited' then
        v_ok := false; v_info := v_info || ' [бросок сдавшегося: ' || coalesce(v_msg, 'принят') || ']';
      end if;
      reset role;
      if (select m.current_seat from public.comp_matches m where m.id = v_m) <> 1 then
        v_ok := false; v_info := v_info || ' [после сдачи ход не у оставшегося]';
      end if;
      perform private.comp_settle(v_m, 'test');
      if (select a.owner from public.asyks a where a.id = v_asyk) <> v_second then
        v_ok := false; v_info := v_info || ' [асык сдавшегося не достался выбившему]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '9. Два пропуска подряд — сдача'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 10. Просроченная проверка готовности → возврат ставок ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_r := public.comp_open('stake-line', '1111111111111111', 'Сәкен');
      v_m2 := (v_r ->> 'match_id')::uuid;
      v_code2 := v_r ->> 'join_code';
      perform public.comp_stake(v_m2);
      perform set_config('request.jwt.claims', v_je, true);
      perform public.comp_join(v_code2, '2222222222222222', 'Ерлан');
      perform public.comp_stake(v_m2);
      perform set_config('request.jwt.claims', v_jc, true);
      v_r := public.comp_start(v_m2);
      if v_r -> 'match' ->> 'status' <> 'ready' then
        v_ok := false; v_info := v_info || ' [после жребия не ready]';
      end if;
      -- места и раскладка назначаются только при старте: на проверке готовности их не видно
      if jsonb_array_length(v_r -> 'slots') <> 0 or v_r -> 'me' -> 'seat' <> 'null'::jsonb
         or exists (select 1 from jsonb_array_elements(v_r -> 'players') as e(x) where e.x -> 'seat' <> 'null'::jsonb)
         or exists (select 1 from public.comp_players p where p.match_id = v_m2 and p.seat is not null)
         or exists (select 1 from public.comp_stakes s where s.match_id = v_m2) then
        v_ok := false; v_info := v_info || ' [места или слоты видны до «Я здесь»]';
      end if;
      reset role;

      update public.comp_matches m set ready_deadline = now() - interval '1 second' where m.id = v_m2;
      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_r := public.comp_ready(v_m2);
      perform set_config('request.jwt.claims', v_je, true);
      v_r2 := public.comp_state(v_m2);
      reset role;
      if v_r -> 'match' ->> 'status' <> 'cancelled' or v_r2 -> 'match' ->> 'status' <> 'cancelled'
         or not (v_r2 -> 'result' ->> 'refunded')::boolean then
        v_ok := false; v_info := v_info || ' [статус: ' || coalesce(v_r -> 'match' ->> 'status', '?') || ']';
      end if;
      if (select count(*) from public.asyks a where a.owner in (v_c, v_e) and a.locked_match is not null) <> 0
         or exists (select 1 from public.comp_players p where p.match_id = v_m2 and p.active) then
        v_ok := false; v_info := v_info || ' [ставки не вернулись]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '10. Просроченная проверка готовности — возврат'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 11. comp_settle_stale: свежий матч не трогает, зависший раздаёт ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_r := public.comp_settle_stale(v_m);
      reset role;
      if v_r -> 'match' ->> 'status' <> 'active' then
        v_ok := false; v_info := v_info || ' [раздал свежий матч]';
      end if;
      update public.comp_matches m set updated_at = now() - interval '16 minutes' where m.id = v_m;
      perform set_config('request.jwt.claims', v_jb, true);
      set local role authenticated;
      v_r := public.comp_settle_stale(v_m);
      reset role;
      if v_r -> 'match' ->> 'status' <> 'settled' or v_r -> 'match' ->> 'end_reason' <> 'stale' then
        v_ok := false; v_info := v_info || ' [зависший: ' || coalesce(v_r -> 'match' ->> 'status', '?') || ']';
      end if;
      if (select count(*) from public.asyks a where a.locked_match = v_m) <> 0
         or (select count(*) from public.asyks a where a.owner = v_a) <> 10
         or (select count(*) from public.asyks a where a.owner = v_b) <> 10 then
        v_ok := false; v_info := v_info || ' [асыки после stale]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '11. comp_settle_stale'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 12. Сбои сервера у двух мест → матч аннулирован, ставки вернулись ———
    v_ok := true; v_info := '';
    begin
      update public.comp_matches m
         set turn_deadline = now() - interval '6 seconds', pending_by = v_first, pending_at = now() - interval '25 seconds'
       where m.id = v_m;
      perform set_config('request.jwt.claims', v_js, true);
      set local role authenticated;
      perform public.comp_skip(v_m, 1);
      reset role;
      update public.comp_matches m
         set turn_deadline = now() - interval '6 seconds', pending_by = v_second, pending_at = now() - interval '25 seconds'
       where m.id = v_m;
      perform set_config('request.jwt.claims', v_jf, true);
      set local role authenticated;
      perform public.comp_skip(v_m, 2);
      reset role;
      perform private.comp_settle(v_m, 'test');
      if (select m.status from public.comp_matches m where m.id = v_m) <> 'void'
         or (select m.end_reason from public.comp_matches m where m.id = v_m) <> 'server'
         or (select count(*) from public.comp_throws t where t.match_id = v_m and t.kind = 'fail') <> 2
         or (select count(*) from public.asyks a where a.locked_match = v_m) <> 0
         or (select count(*) from public.asyks a where a.owner = v_a) <> 10
         or (select count(*) from public.asyks a where a.owner = v_b) <> 10
         or (select count(*) from public.asyk_transfers t where t.match_id = v_m) <> 0 then
        v_ok := false; v_info := v_info || ' [должен быть void с возвратом]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '12. Сбои у двух мест — возврат ставок'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 13. Кон опустел → раздача в той же транзакции ———
    v_ok := true; v_info := '';
    begin
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0, 0) order by s.slot) into v_final
      from public.comp_stakes s where s.match_id = v_m;
      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_first, 1);
      v_r2 := public.comp_apply_throw(v_m, v_first, 1, 0.3, 1.0, v_r -> 'kon_state', v_final,
                                      array(select generate_series(0, 9)), 300);
      reset role;
      if v_r2 -> 'next' ->> 'status' <> 'settled' or v_r2 -> 'next' ->> 'end_reason' <> 'cleared' then
        v_ok := false; v_info := v_info || ' [ответ: ' || v_r2::text || ']';
      end if;
      if (select count(*) from public.asyks a where a.owner = v_first) <> 15
         or (select count(*) from public.asyks a where a.owner = v_second) <> 5
         or (select count(*) from public.asyk_transfers t where t.match_id = v_m) <> 5
         or (select count(*) from public.asyks a where a.locked_match = v_m) <> 0 then
        v_ok := false; v_info := v_info || ' [раздача пустого кона]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '13. Пустой кон — раздача сразу'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 14. Удаление аккаунта посреди матча не ломает раздачу ———
    v_ok := true; v_info := '';
    begin
      select s.slot into v_slot from public.comp_stakes s
      where s.match_id = v_m and s.owner_user = v_second order by s.slot limit 1;
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0,
               case when s.slot <> v_slot then 1 else 0 end) order by s.slot)
        into v_final
      from public.comp_stakes s where s.match_id = v_m;
      perform set_config('request.jwt.claims', v_jsrv, true);
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_first, 1);
      perform public.comp_apply_throw(v_m, v_first, 1, 0.1, 0.5, v_r -> 'kon_state', v_final, array[v_slot], 120);
      reset role;

      select s.slot, s.asyk_id into v_slot2, v_asyk from public.comp_stakes s
      where s.match_id = v_m and s.owner_user = v_first order by s.slot limit 1;
      select jsonb_agg(jsonb_build_array(s.slot, 100 + s.slot, 300, 0,
               case when s.knocked_by_seat is null and s.slot <> v_slot2 then 1 else 0 end) order by s.slot)
        into v_final
      from public.comp_stakes s where s.match_id = v_m;
      set local role service_role;
      v_r := public.comp_begin_throw(v_m, v_second, 2);
      perform public.comp_apply_throw(v_m, v_second, 2, -0.1, 0.5, v_r -> 'kon_state', v_final, array[v_slot2], 120);
      reset role;

      -- удаление аккаунта: auth.users → profiles → asyks (каскад); здесь удаляем профиль напрямую
      delete from public.profiles pr where pr.id = v_second;
      perform private.comp_settle(v_m, 'test');
      if (select m.status from public.comp_matches m where m.id = v_m) <> 'settled'
         or (select a.owner from public.asyks a where a.id = v_asyk) <> v_first
         or (select count(*) from public.asyks a where a.owner = v_first) <> 10
         or (select count(*) from public.asyks a where a.locked_match = v_m) <> 0
         or (select count(*) from public.asyk_transfers t where t.match_id = v_m) <> 0 then
        v_ok := false; v_info := v_info || ' [раздача после удаления аккаунта]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '14. Удаление аккаунта посреди матча'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 15. Пульс и пропуск отсутствующего через 20 с ———
    v_ok := true; v_info := '';
    begin
      update public.comp_players p set last_seen = now() - interval '10 seconds'
       where p.match_id = v_m and p.user_id = v_first;
      perform set_config('request.jwt.claims', v_jf, true);
      set local role authenticated;
      v_ts := public.comp_heartbeat(v_m);
      reset role;
      if v_ts <> now()
         or (select p.last_seen from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> now() then
        v_ok := false; v_info := v_info || ' [пульс не записан]';
      end if;

      update public.comp_players p set last_seen = now() - interval '1 second'
       where p.match_id = v_m and p.user_id = v_first;
      set local role authenticated;
      perform public.comp_heartbeat(v_m);
      reset role;
      if (select p.last_seen from public.comp_players p where p.match_id = v_m and p.user_id = v_first)
         <> now() - interval '1 second' then
        v_ok := false; v_info := v_info || ' [пульс чаще раза в 2 с]';
      end if;

      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_heartbeat(v_m); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'not_member' then
        v_ok := false; v_info := v_info || ' [пульс чужого: ' || coalesce(v_msg, 'принят') || ']';
      end if;

      -- игрок в сети (пульс 5 с назад), ход идёт 21 с — пропуск нельзя
      update public.comp_matches m set turn_started_at = now() - interval '21 seconds' where m.id = v_m;
      update public.comp_players p set last_seen = now() - interval '5 seconds'
       where p.match_id = v_m and p.user_id = v_first;
      perform set_config('request.jwt.claims', v_js, true);
      set local role authenticated;
      v_msg := null; v_detail := null;
      begin perform public.comp_skip(v_m, 1);
      exception when others then
        v_msg := sqlerrm;
        get stacked diagnostics v_detail = pg_exception_detail;
      end;
      reset role;
      if v_msg is distinct from 'too_early' then
        v_ok := false; v_info := v_info || ' [пропуск игрока в сети: ' || coalesce(v_msg, 'пропустил') || ']';
      end if;
      -- пульс 5 с назад → пропуск станет возможен через 10 с (пульс устареет), а не «уже прошло»
      if v_detail is null or v_detail::timestamptz <> now() + interval '10 seconds' then
        v_ok := false; v_info := v_info || ' [detail у too_early: ' || coalesce(v_detail, 'null') || ']';
      end if;

      -- игрок пропал (пульс 16 с назад), но ход идёт только 10 с — пропуск нельзя
      update public.comp_matches m set turn_started_at = now() - interval '10 seconds' where m.id = v_m;
      update public.comp_players p set last_seen = now() - interval '16 seconds'
       where p.match_id = v_m and p.user_id = v_first;
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_skip(v_m, 1); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'too_early' then
        v_ok := false; v_info := v_info || ' [пропуск через 10 с: ' || coalesce(v_msg, 'пропустил') || ']';
      end if;

      -- игрок пропал и ход идёт 21 с — пропуск разрешён, хотя до дедлайна далеко
      update public.comp_matches m set turn_started_at = now() - interval '21 seconds' where m.id = v_m;
      set local role authenticated;
      v_r := public.comp_skip(v_m, 1);
      reset role;
      if (select t.kind from public.comp_throws t where t.match_id = v_m and t.throw_no = 1) is distinct from 'skip'
         or (select p.skips_in_row from public.comp_players p where p.match_id = v_m and p.user_id = v_first) <> 1
         or (select m.current_seat from public.comp_matches m where m.id = v_m) <> 1 then
        v_ok := false; v_info := v_info || ' [пропуск отсутствующего не прошёл]';
      end if;
      if exists (select 1 from jsonb_array_elements(v_r -> 'players') as e(x)
                 where (e.x ->> 'seat')::int = 0 and (e.x ->> 'online')::boolean) then
        v_ok := false; v_info := v_info || ' [отсутствующий показан в сети]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '15. Пульс и пропуск отсутствующего через 20 с'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 16. Третий игрок не может войти ———
    v_ok := true; v_info := '';
    begin
      if private.comp_max_players() <> 2 then
        v_ok := false; v_info := v_info || ' [comp_max_players не 2]';
      end if;
      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_r := public.comp_open('stake-scatter', '1111111111111111', 'Сәкен');
      v_m2 := (v_r ->> 'match_id')::uuid;
      v_code2 := v_r ->> 'join_code';
      perform set_config('request.jwt.claims', v_je, true);
      v_r := public.comp_join(lower(left(v_code2, 5)) || '-' || right(v_code2, 5), '2222222222222222', 'Ерлан');
      if (v_r ->> 'lobby_slot')::int <> 1 then
        v_ok := false; v_info := v_info || ' [второй игрок не на месте 1]';
      end if;
      perform set_config('request.jwt.claims', v_jd, true);
      v_msg := null;
      begin perform public.comp_join(v_code2, '3333333333333333', 'Дана'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'full' then
        v_ok := false; v_info := v_info || ' [третий: ' || coalesce(v_msg, 'вошёл') || ']';
      end if;
      if (select count(*) from public.comp_players p where p.match_id = v_m2) <> 2 then
        v_ok := false; v_info := v_info || ' [игроков не 2]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '16. Третий игрок не может войти'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 17. Закрытый канал Realtime и публикация ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      if not private.is_comp_topic_member('comp:' || v_m::text)
         or not private.is_comp_topic_member('comp-aim:' || v_m::text) then
        v_ok := false; v_info := v_info || ' [участник не пущен в канал]';
      end if;
      if private.is_comp_topic_member('comp:not-a-uuid') or private.is_comp_topic_member('asyk-atu:ABCDEFGHJK')
         or private.is_comp_topic_member('comp:' || repeat('-', 36))
         or private.is_comp_topic_member('comp-srv:' || v_m::text)
         or private.is_comp_topic_member('comp-aim:not-a-uuid') then
        v_ok := false; v_info := v_info || ' [неверная тема принята]';
      end if;
      perform set_config('request.jwt.claims', v_jc, true);
      if private.is_comp_topic_member('comp:' || v_m::text)
         or private.is_comp_topic_member('comp-aim:' || v_m::text) then
        v_ok := false; v_info := v_info || ' [чужой пущен в канал]';
      end if;
      reset role;
      if to_regclass('realtime.messages') is not null then
        if (select count(*) from pg_policies
            where schemaname = 'realtime' and tablename = 'messages'
              and policyname in ('comp: участники слушают канал', 'comp: игроки шлют присутствие и прицел')) <> 2
           or exists (select 1 from pg_policies
                      where schemaname = 'realtime' and tablename = 'messages'
                        and policyname = 'comp: игроки шлют только прицел') then
          v_ok := false; v_info := v_info || ' [политики realtime.messages не те]';
        end if;
        -- право писать Realtime проверяет без event: условие на event в политике закрыло бы broadcast
        if exists (select 1 from pg_policies
                   where schemaname = 'realtime' and tablename = 'messages'
                     and policyname like 'comp:%' and coalesce(with_check, '') like '%event%') then
          v_ok := false; v_info := v_info || ' [в политике записи условие на event]';
        end if;
      end if;
      if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
         and (not exists (select 1 from pg_publication_tables
                          where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comp_matches')
              or exists (select 1 from pg_publication_tables
                         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comp_players')) then
        v_ok := false; v_info := v_info || ' [публикация: нужна comp_matches и не нужна comp_players]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '17. Закрытый канал Realtime'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 18. Лобби: забрать ставку, исключить, выйти ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_r := public.comp_open('stake-line', '1111111111111111', E'  Сә\u200Bкен \t  Ұлы  ');
      v_m2 := (v_r ->> 'match_id')::uuid;
      v_code2 := v_r ->> 'join_code';
      perform public.comp_stake(v_m2);
      perform public.comp_unstake(v_m2);
      reset role;
      if (select count(*) from public.asyks a where a.owner = v_c and a.locked_match is not null) <> 0 then
        v_ok := false; v_info := v_info || ' [comp_unstake не вернул]';
      end if;
      if (select p.display_name from public.comp_players p where p.match_id = v_m2 and p.user_id = v_c) <> 'Сәкен Ұлы' then
        v_ok := false; v_info := v_info || ' [имя не очищено]';
      end if;

      select m.players_rev into v_rev from public.comp_matches m where m.id = v_m2;
      perform set_config('request.jwt.claims', v_je, true);
      set local role authenticated;
      perform public.comp_join(v_code2, '2222222222222222', repeat('я', 40));
      perform public.comp_stake(v_m2);
      perform public.comp_leave(v_m2);
      reset role;
      if exists (select 1 from public.comp_players p where p.match_id = v_m2 and p.user_id = v_e)
         or (select count(*) from public.asyks a where a.owner = v_e and a.locked_match is not null) <> 0 then
        v_ok := false; v_info := v_info || ' [выход гостя не вернул ставку]';
      end if;
      -- вход, ставка и выход — три сигнала смены состава через строку матча
      if (select m.players_rev from public.comp_matches m where m.id = v_m2) < v_rev + 3 then
        v_ok := false; v_info := v_info || ' [players_rev не растёт при смене состава]';
      end if;

      perform set_config('request.jwt.claims', v_je, true);
      set local role authenticated;
      perform public.comp_join(v_code2, '2222222222222222', repeat('я', 40));
      perform public.comp_stake(v_m2);
      perform set_config('request.jwt.claims', v_jc, true);
      perform public.comp_kick(v_m2, 1);
      reset role;
      if exists (select 1 from public.comp_players p where p.match_id = v_m2 and p.user_id = v_e)
         or (select count(*) from public.asyks a where a.owner = v_e and a.locked_match is not null) <> 0 then
        v_ok := false; v_info := v_info || ' [исключение не вернуло ставку]';
      end if;

      -- исключённый по тому же коду больше не входит
      perform set_config('request.jwt.claims', v_je, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_join(v_code2, '2222222222222222', 'Ерлан'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'kicked' then
        v_ok := false; v_info := v_info || ' [исключённый снова вошёл: ' || coalesce(v_msg, 'пустил') || ']';
      end if;

      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      perform public.comp_stake(v_m2);
      perform public.comp_leave(v_m2);
      reset role;
      if (select m.status from public.comp_matches m where m.id = v_m2) <> 'cancelled'
         or (select count(*) from public.asyks a where a.owner = v_c and a.locked_match is not null) <> 0 then
        v_ok := false; v_info := v_info || ' [выход хозяина не отменил матч]';
      end if;
      if char_length(private.comp_clean_name(repeat('я', 40), 'x')) <> 16
         or private.comp_clean_name(E'\u200B \t', 'Гость') <> 'Гость' then
        v_ok := false; v_info := v_info || ' [comp_clean_name]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '18. Лобби: забрать ставку, исключить, выйти'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 19. Сдача в свой ход: ход сразу переходит ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jf, true);
      set local role authenticated;
      v_r := public.comp_forfeit(v_m);
      reset role;
      if not (select p.forfeited from public.comp_players p where p.match_id = v_m and p.user_id = v_first)
         or (select m.current_seat from public.comp_matches m where m.id = v_m) <> 1
         or (select m.throw_no from public.comp_matches m where m.id = v_m) <> 1
         or (select t.kind from public.comp_throws t where t.match_id = v_m and t.throw_no = 1) is distinct from 'skip'
         or (select m.status from public.comp_matches m where m.id = v_m) <> 'active' then
        v_ok := false; v_info := v_info || ' [сдача в свой ход]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '19. Сдача в свой ход'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 20. Реванш: одно новое лобби на двоих, чужим нельзя, до конца матча нельзя ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_rematch(v_m, '0123456789abcdef'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'not_over' then
        v_ok := false; v_info := v_info || ' [реванш до конца матча: ' || coalesce(v_msg, 'прошёл') || ']';
      end if;

      perform private.comp_settle(v_m, 'cleared');
      if (select m.status from public.comp_matches m where m.id = v_m) <> 'settled' then
        raise exception 'подготовка: матч не раздан';
      end if;

      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_rematch(v_m, '1111111111111111'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'not_member' then
        v_ok := false; v_info := v_info || ' [реванш чужого матча: ' || coalesce(v_msg, 'прошёл') || ']';
      end if;

      perform set_config('request.jwt.claims', v_jb, true);
      set local role authenticated;
      v_r := public.comp_rematch(v_m, 'fedcba9876543210');
      perform set_config('request.jwt.claims', v_ja, true);
      v_r2 := public.comp_rematch(v_m, '0123456789abcdef');
      reset role;
      v_m2 := (v_r ->> 'match_id')::uuid;
      if not (v_r ->> 'created')::boolean or (v_r2 ->> 'created')::boolean
         or (v_r2 ->> 'match_id')::uuid <> v_m2
         or (v_r ->> 'lobby_slot')::int <> 0 or (v_r2 ->> 'lobby_slot')::int <> 1 then
        v_ok := false; v_info := v_info || ' [реванш: не одно лобби на двоих: ' || v_r::text || ' / ' || v_r2::text || ']';
      end if;
      if (select m.layout_id from public.comp_matches m where m.id = v_m2)
         <> (select m.layout_id from public.comp_matches m where m.id = v_m)
         or (select m.status from public.comp_matches m where m.id = v_m2) <> 'forming'
         or (select m.host from public.comp_matches m where m.id = v_m2) <> v_b then
        v_ok := false; v_info := v_info || ' [новое лобби: не тот кон, статус или хозяин]';
      end if;
      -- повторное нажатие — то же лобби, без нового матча
      perform set_config('request.jwt.claims', v_jb, true);
      set local role authenticated;
      v_r2 := public.comp_rematch(v_m, 'fedcba9876543210');
      v_x := public.comp_state(v_m);
      reset role;
      if (v_r2 ->> 'match_id')::uuid <> v_m2 or (v_r2 ->> 'created')::boolean then
        v_ok := false; v_info := v_info || ' [повторный реванш создал новый матч]';
      end if;
      if (v_x -> 'match' ->> 'next_code') is distinct from (v_r ->> 'join_code') then
        v_ok := false; v_info := v_info || ' [comp_state старого матча без next_code]';
      end if;
      -- ставка в новом лобби — заново: асыки после раздачи свободны
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_ids := public.comp_stake(v_m2);
      reset role;
      if cardinality(v_ids) <> 5 then
        v_ok := false; v_info := v_info || ' [ставка в реванше не прошла]';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '20. Реванш: одно лобби на двоих'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    -- ——— 21. Смена кона в лобби: только хозяин, только до жребия, только известные коны ———
    v_ok := true; v_info := '';
    begin
      perform set_config('request.jwt.claims', v_jc, true);
      set local role authenticated;
      v_r := public.comp_open('stake-piles', '1111111111111111', 'Сәкен');
      v_m2 := (v_r ->> 'match_id')::uuid;
      v_code2 := v_r ->> 'join_code';
      perform set_config('request.jwt.claims', v_je, true);
      perform public.comp_join(v_code2, '2222222222222222', 'Ерлан');
      v_msg := null;
      begin perform public.comp_set_layout(v_m2, 'stake-romb'); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'not_host' then
        v_ok := false; v_info := v_info || ' [гость сменил кон: ' || coalesce(v_msg, 'прошло') || ']';
      end if;
      perform set_config('request.jwt.claims', v_jc, true);
      perform public.comp_stake(v_m2);
      v_x := public.comp_set_layout(v_m2, 'stake-romb');
      if (v_x -> 'match' ->> 'layout_id') <> 'stake-romb' then
        v_ok := false; v_info := v_info || ' [хозяин не сменил кон]';
      end if;
      v_msg := null;
      begin perform public.comp_set_layout(v_m2, 'ulken-kon'); exception when others then v_msg := sqlerrm; end;
      if v_msg is distinct from 'bad_layout' then
        v_ok := false; v_info := v_info || ' [неизвестный кон: ' || coalesce(v_msg, 'прошло') || ']';
      end if;
      reset role;
      -- после старта кон менять нельзя (основной матч уже идёт; его хозяин — A)
      perform set_config('request.jwt.claims', v_ja, true);
      set local role authenticated;
      v_msg := null;
      begin perform public.comp_set_layout(v_m, 'stake-ring'); exception when others then v_msg := sqlerrm; end;
      reset role;
      if v_msg is distinct from 'not_forming' then
        v_ok := false; v_info := v_info || ' [смена кона после старта: ' || coalesce(v_msg, 'прошла') || ']';
      end if;
      -- неизвестный кон не записать даже владельцу базы: ограничение таблицы
      v_msg := null;
      begin
        update public.comp_matches m set layout_id = 'bogus' where m.id = v_m2;
      exception when others then v_msg := sqlstate;
      end;
      if v_msg is distinct from '23514' then
        v_ok := false; v_info := v_info || ' [ограничение конов не сработало: ' || coalesce(v_msg, 'записалось') || ']';
      end if;
      raise exception 'comp_check_rollback';
    exception when others then
      if sqlerrm <> 'comp_check_rollback' then
        v_ok := false; v_info := v_info || ' ошибка: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end;
    v_names := array_append(v_names, '21. Смена кона в лобби'::text);
    v_oks := array_append(v_oks, v_ok); v_infos := array_append(v_infos, v_info);

    raise exception 'comp_check_rollback'; -- откат всех тестовых данных
  exception when others then
    if sqlerrm <> 'comp_check_rollback' then
      v_crash := sqlstate || ' ' || sqlerrm;
    end if;
  end;

  if v_crash is not null then
    insert into comp_check_results (n, name, ok, info) values (0, '0. Подготовка', false, v_crash);
    raise notice 'FAIL 0. Подготовка: %', v_crash;
  end if;
  for v_i in 1..coalesce(array_length(v_names, 1), 0) loop
    insert into comp_check_results (n, name, ok, info)
    values (v_i, v_names[v_i], v_oks[v_i], nullif(btrim(v_infos[v_i]), ''));
    if v_oks[v_i] then
      raise notice 'PASS %', v_names[v_i];
    else
      raise notice 'FAIL %: %', v_names[v_i], v_infos[v_i];
    end if;
  end loop;
end;
$check$;

do $verdict$
declare
  v_fail text;
  v_total int;
begin
  select count(*) into v_total from comp_check_results;
  select string_agg(r.name || coalesce(' — ' || r.info, ''), '; ' order by r.n) into v_fail
  from comp_check_results r where not r.ok;
  if v_fail is not null then
    raise exception 'competitive.check: FAIL — %', v_fail;
  end if;
  if v_total < 21 then
    raise exception 'competitive.check: FAIL — выполнено сценариев: %', v_total;
  end if;
  raise notice 'ALL PASS';
end;
$verdict$;

select r.n as "№", r.name as "сценарий", case when r.ok then 'PASS' else 'FAIL' end as "итог",
       coalesce(r.info, '') as "подробности"
from comp_check_results r
union all
select 100, 'ИТОГ', 'ALL PASS', 'все сценарии прошли, тестовые данные откатаны'
order by 1;
