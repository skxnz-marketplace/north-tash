alter table public.game_room_members
  add column if not exists last_seen_at timestamptz not null default now();

grant update, delete on public.game_room_members to authenticated;
grant delete on public.game_rooms to authenticated;

drop policy if exists "Players can update their memberships" on public.game_room_members;
create policy "Players can update their memberships"
  on public.game_room_members for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Players can leave their memberships" on public.game_room_members;
create policy "Players can leave their memberships"
  on public.game_room_members for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Hosts can close rooms" on public.game_rooms;
create policy "Hosts can close rooms"
  on public.game_rooms for delete
  to authenticated
  using (host_user_id = (select auth.uid()));
