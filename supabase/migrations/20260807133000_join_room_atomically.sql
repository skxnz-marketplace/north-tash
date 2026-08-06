create or replace function public.join_game_room(
  p_code text,
  p_player jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state jsonb;
  v_players jsonb;
  v_player jsonb;
  v_player_id text := p_player ->> 'id';
  v_player_name text := left(trim(coalesce(p_player ->> 'name', 'Player')), 40);
  v_chips integer := greatest(6, least(20, coalesce((p_player ->> 'chips')::integer, 20)));
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication is required.';
  end if;

  if p_code !~ '^[0-9]{3}$' then
    raise exception 'A valid 3-digit room code is required.';
  end if;

  if v_player_id <> 'p-' || (select auth.uid())::text then
    raise exception 'Player identity does not match the signed-in user.';
  end if;

  if v_player_name = '' then
    v_player_name := 'Player';
  end if;

  begin
    insert into public.game_room_members (room_code, user_id, player_id, last_seen_at)
    values (p_code, (select auth.uid()), v_player_id, now())
    on conflict (room_code, user_id) do update
      set player_id = excluded.player_id,
          last_seen_at = excluded.last_seen_at;
  exception
    when foreign_key_violation then
      raise exception 'Room % was not found.', p_code;
  end;

  select room.state
  into v_state
  from public.game_rooms as room
  where room.code = p_code
  for update;

  if v_state is null then
    raise exception 'Room % was not found.', p_code;
  end if;

  v_players := coalesce(v_state #> '{room,players}', '[]'::jsonb);

  if jsonb_typeof(v_players) <> 'array' then
    raise exception 'Room player data is invalid.';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_players) as player
    where player ->> 'id' = v_player_id
  ) then
    if jsonb_array_length(v_players) >= 7 then
      raise exception 'Room is full.';
    end if;

    v_player := jsonb_build_object(
      'id', v_player_id,
      'name', v_player_name,
      'chips', v_chips,
      'isHost', false,
      'isBot', false
    );
    v_state := jsonb_set(
      v_state,
      '{room,players}',
      v_players || jsonb_build_array(v_player),
      true
    );

    update public.game_rooms
    set state = v_state
    where code = p_code;
  end if;

  return v_state;
end;
$$;

revoke execute on function public.join_game_room(text, jsonb) from public, anon;
grant execute on function public.join_game_room(text, jsonb) to authenticated;
