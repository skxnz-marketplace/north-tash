create table if not exists public.game_room_actions (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.game_rooms(code) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  base_revision integer not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  result jsonb
);

create index if not exists game_room_actions_pending_idx
  on public.game_room_actions(room_code, processed_at, created_at);

create table if not exists public.game_room_private_hands (
  room_code text not null references public.game_rooms(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  player_id text not null,
  hand jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room_code, user_id)
);

create table if not exists public.game_room_reveals (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.game_rooms(code) on delete cascade,
  request_id text not null,
  viewer_user_id uuid not null references auth.users(id) on delete cascade,
  player_id text not null,
  hand jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (room_code, request_id, viewer_user_id, player_id)
);

alter table public.game_room_actions enable row level security;
alter table public.game_room_private_hands enable row level security;
alter table public.game_room_reveals enable row level security;

grant select, insert, update on public.game_room_actions to authenticated;
grant select, insert, update on public.game_room_private_hands to authenticated;
grant select, insert, delete on public.game_room_reveals to authenticated;

create policy "Room members can submit actions"
  on public.game_room_actions for insert
  to authenticated
  with check (
    actor_user_id = (select auth.uid())
    and exists (
      select 1 from public.game_room_members member
      where member.room_code = game_room_actions.room_code
        and member.user_id = (select auth.uid())
    )
  );

create policy "Players can read their actions"
  on public.game_room_actions for select
  to authenticated
  using (
    actor_user_id = (select auth.uid())
    or exists (
      select 1 from public.game_rooms room
      where room.code = game_room_actions.room_code
        and room.host_user_id = (select auth.uid())
    )
  );

create policy "Hosts can process actions"
  on public.game_room_actions for update
  to authenticated
  using (exists (
    select 1 from public.game_rooms room
    where room.code = game_room_actions.room_code
      and room.host_user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.game_rooms room
    where room.code = game_room_actions.room_code
      and room.host_user_id = (select auth.uid())
  ));

create policy "Players can read their private hand"
  on public.game_room_private_hands for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Hosts can read private hands"
  on public.game_room_private_hands for select
  to authenticated
  using (exists (
    select 1 from public.game_rooms room
    where room.code = game_room_private_hands.room_code
      and room.host_user_id = (select auth.uid())
  ));

create policy "Players and hosts can write private hands"
  on public.game_room_private_hands for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.game_rooms room
      where room.code = game_room_private_hands.room_code
        and room.host_user_id = (select auth.uid())
    )
  );

create policy "Players and hosts can update private hands"
  on public.game_room_private_hands for update
  to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.game_rooms room
      where room.code = game_room_private_hands.room_code
        and room.host_user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.game_rooms room
      where room.code = game_room_private_hands.room_code
        and room.host_user_id = (select auth.uid())
    )
  );

create policy "Players can read their reveals"
  on public.game_room_reveals for select
  to authenticated
  using (viewer_user_id = (select auth.uid()) and expires_at > now());

create policy "Hosts can create reveals"
  on public.game_room_reveals for insert
  to authenticated
  with check (exists (
    select 1 from public.game_rooms room
    where room.code = game_room_reveals.room_code
      and room.host_user_id = (select auth.uid())
  ));

create policy "Players can delete their reveals"
  on public.game_room_reveals for delete
  to authenticated
  using (viewer_user_id = (select auth.uid()));

alter publication supabase_realtime add table public.game_room_actions;
alter publication supabase_realtime add table public.game_room_reveals;
