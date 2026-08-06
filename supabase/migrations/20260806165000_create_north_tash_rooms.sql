create table if not exists public.game_rooms (
  code text primary key check (code ~ '^[0-9]{3}$'),
  host_user_id uuid not null references auth.users(id) on delete cascade,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_room_members (
  room_code text not null references public.game_rooms(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  player_id text not null,
  joined_at timestamptz not null default now(),
  primary key (room_code, user_id),
  unique (room_code, player_id)
);

alter table public.game_rooms enable row level security;
alter table public.game_room_members enable row level security;

grant select, insert, update on public.game_rooms to authenticated;
grant select, insert on public.game_room_members to authenticated;

create policy "Room members can read room snapshots"
  on public.game_rooms for select
  to authenticated
  using (
    exists (
      select 1
      from public.game_room_members member
      where member.room_code = game_rooms.code
        and member.user_id = (select auth.uid())
    )
    or host_user_id = (select auth.uid())
  );

create policy "Authenticated users can create rooms"
  on public.game_rooms for insert
  to authenticated
  with check (host_user_id = (select auth.uid()));

create policy "Room members can update room snapshots"
  on public.game_rooms for update
  to authenticated
  using (
    exists (
      select 1
      from public.game_room_members member
      where member.room_code = game_rooms.code
        and member.user_id = (select auth.uid())
    )
    or host_user_id = (select auth.uid())
  )
  with check (
    exists (
      select 1
      from public.game_room_members member
      where member.room_code = game_rooms.code
        and member.user_id = (select auth.uid())
    )
    or host_user_id = (select auth.uid())
  );

create policy "Players can read their memberships"
  on public.game_room_members for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Players can join a room"
  on public.game_room_members for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create or replace function public.set_game_room_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists game_rooms_updated_at on public.game_rooms;
create trigger game_rooms_updated_at
before update on public.game_rooms
for each row execute function public.set_game_room_updated_at();

alter publication supabase_realtime add table public.game_rooms;
