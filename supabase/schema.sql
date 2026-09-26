create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_id text not null unique,
  display_name text not null,
  phone text not null,
  gender text not null default 'other' check (gender in ('male', 'female', 'other')),
  role text not null default 'member' check (role in ('member', 'admin')),
  is_guest boolean not null default false,
  seed_win_rate numeric(5,2) not null default 50 check (seed_win_rate >= 0 and seed_win_rate <= 100),
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists is_guest boolean not null default false;
alter table public.profiles add column if not exists seed_win_rate numeric(5,2) not null default 50;
alter table public.profiles drop constraint if exists profiles_seed_win_rate_check;
alter table public.profiles add constraint profiles_seed_win_rate_check check (seed_win_rate >= 0 and seed_win_rate <= 100);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  meeting_date date not null unique,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.attendances (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz,
  created_at timestamptz not null default now(),
  check (checked_out_at is null or checked_out_at >= checked_in_at)
);

alter table public.attendances drop constraint if exists attendances_meeting_id_member_id_key;

create table if not exists public.courts (
  court_number integer primary key check (court_number between 1 and 3),
  court_name text not null unique check (court_name in ('1', '2', '3')),
  is_available boolean not null default false,
  rental_started_at timestamptz,
  rental_ended_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.courts drop constraint if exists courts_court_name_check;

update public.courts set court_name = court_number::text;

alter table public.courts add constraint courts_court_name_check check (court_name in ('1', '2', '3'));

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  court_number integer not null check (court_number between 1 and 3),
  round_number integer not null default 1,
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'finished')),
  started_at timestamptz,
  ended_at timestamptz,
  team_a_score integer check (team_a_score is null or team_a_score >= 0),
  team_b_score integer check (team_b_score is null or team_b_score >= 0),
  winner_team text check (winner_team is null or winner_team in ('A', 'B')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or started_at is null or ended_at >= started_at),
  check (
    winner_team is null
    or (
      team_a_score is not null
      and team_b_score is not null
      and team_a_score <> team_b_score
    )
  )
);

alter table public.matches drop constraint if exists matches_court_number_check;
alter table public.matches add constraint matches_court_number_check check (court_number between 1 and 3);

create table if not exists public.match_players (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  team text not null check (team in ('A', 'B')),
  created_at timestamptz not null default now(),
  unique (match_id, member_id)
);

create index if not exists idx_profiles_login_id on public.profiles(login_id);
create index if not exists idx_meetings_date on public.meetings(meeting_date desc);
create index if not exists idx_attendances_meeting on public.attendances(meeting_id);
create index if not exists idx_attendances_member on public.attendances(member_id);
create index if not exists idx_courts_available on public.courts(is_available, court_number);
create index if not exists idx_matches_meeting on public.matches(meeting_id, status);
create index if not exists idx_match_players_match on public.match_players(match_id);
create index if not exists idx_match_players_member on public.match_players(member_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists matches_set_updated_at on public.matches;
create trigger matches_set_updated_at
before update on public.matches
for each row execute function public.set_updated_at();

drop trigger if exists courts_set_updated_at on public.courts;
create trigger courts_set_updated_at
before update on public.courts
for each row execute function public.set_updated_at();

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = new.id and old.role <> new.role and not public.is_admin() then
    raise exception 'Only admins can change roles.';
  end if;

  if auth.uid() = new.id and old.login_id <> new.login_id and not public.is_admin() then
    raise exception 'Only admins can change login ids.';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_prevent_privilege_escalation on public.profiles;
create trigger profiles_prevent_privilege_escalation
before update on public.profiles
for each row execute function public.prevent_profile_privilege_escalation();

alter table public.profiles enable row level security;
alter table public.meetings enable row level security;
alter table public.attendances enable row level security;
alter table public.courts enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;

drop policy if exists "profiles select authenticated" on public.profiles;
create policy "profiles select authenticated"
on public.profiles for select
to authenticated
using (true);

drop policy if exists "profiles insert self" on public.profiles;
create policy "profiles insert self"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles update self or admin" on public.profiles;
create policy "profiles update self or admin"
on public.profiles for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists "profiles delete admin" on public.profiles;
create policy "profiles delete admin"
on public.profiles for delete
to authenticated
using (public.is_admin());

drop policy if exists "meetings select authenticated" on public.meetings;
create policy "meetings select authenticated"
on public.meetings for select
to authenticated
using (true);

drop policy if exists "meetings write admin" on public.meetings;
create policy "meetings write admin"
on public.meetings for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "attendances select authenticated" on public.attendances;
create policy "attendances select authenticated"
on public.attendances for select
to authenticated
using (true);

drop policy if exists "attendances insert self or admin" on public.attendances;
create policy "attendances insert self or admin"
on public.attendances for insert
to authenticated
with check (member_id = auth.uid() or public.is_admin());

drop policy if exists "attendances update self or admin" on public.attendances;
create policy "attendances update self or admin"
on public.attendances for update
to authenticated
using (member_id = auth.uid() or public.is_admin())
with check (member_id = auth.uid() or public.is_admin());

drop policy if exists "attendances delete admin" on public.attendances;
create policy "attendances delete admin"
on public.attendances for delete
to authenticated
using (public.is_admin());

drop policy if exists "courts select authenticated" on public.courts;
create policy "courts select authenticated"
on public.courts for select
to authenticated
using (true);

drop policy if exists "courts write admin" on public.courts;
create policy "courts write admin"
on public.courts for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "matches select authenticated" on public.matches;
create policy "matches select authenticated"
on public.matches for select
to authenticated
using (true);

drop policy if exists "matches write admin" on public.matches;
create policy "matches write admin"
on public.matches for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "match players select authenticated" on public.match_players;
create policy "match players select authenticated"
on public.match_players for select
to authenticated
using (true);

drop policy if exists "match players write admin" on public.match_players;
create policy "match players write admin"
on public.match_players for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- 첫 관리자 지정 예시:
-- update public.profiles set role = 'admin' where login_id = '홍길동';

-- Apply before deploying the corresponding API changes.
-- Only the server service role may perform these atomic attendance/seat writes.
create or replace function public.checkout_member_preserving_matches(
  p_meeting_id uuid,
  p_member_id uuid,
  p_confirm_replace boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_ids uuid[];
begin
  -- Serialize checkout/fill operations with other writes to these tables.
  lock table public.matches, public.attendances, public.match_players in share row exclusive mode;

  if not exists (
    select 1 from public.attendances
    where meeting_id = p_meeting_id and member_id = p_member_id and checked_out_at is null
  ) then
    raise exception '출석 중인 회원이 아닙니다.';
  end if;

  select coalesce(array_agg(distinct m.id), '{}'::uuid[]) into affected_ids
  from public.matches m
  join public.match_players mp on mp.match_id = m.id
  where m.meeting_id = p_meeting_id and mp.member_id = p_member_id
    and m.status in ('scheduled', 'in_progress') and m.ended_at is null;

  if cardinality(affected_ids) > 0 and not coalesce(p_confirm_replace, false) then
    raise exception '참여 중인 경기가 있습니다. 대체 선수 배정 안내를 확인한 후 다시 퇴장해주세요.';
  end if;

  delete from public.match_players
  where match_id = any(affected_ids) and member_id = p_member_id;

  update public.attendances set checked_out_at = now()
  where meeting_id = p_meeting_id and member_id = p_member_id and checked_out_at is null;

  return to_jsonb(affected_ids);
end;
$$;

create or replace function public.fill_match_vacancy(
  p_match_id uuid,
  p_member_id uuid,
  p_team text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.matches%rowtype;
  inserted public.match_players%rowtype;
begin
  lock table public.matches, public.attendances, public.match_players in share row exclusive mode;
  select * into target from public.matches where id = p_match_id;
  if not found or target.status not in ('scheduled', 'in_progress') or target.ended_at is not null then
    raise exception '충원할 수 있는 경기가 아닙니다.';
  end if;
  if p_team is null or p_team not in ('A', 'B') then
    raise exception '팀 정보가 올바르지 않습니다.';
  end if;
  if (select count(*) from public.match_players where match_id = p_match_id and team = p_team) >= 2 then
    raise exception '이미 충원된 자리입니다. 다시 시도해주세요.';
  end if;
  if not exists (
    select 1 from public.attendances a join public.profiles p on p.id = a.member_id
    where a.meeting_id = target.meeting_id and a.member_id = p_member_id
      and a.checked_out_at is null and p.display_name <> '관리자'
  ) then
    raise exception '출석 중인 대체 선수가 아닙니다.';
  end if;
  if exists (
    select 1 from public.match_players mp join public.matches m on m.id = mp.match_id
    where mp.member_id = p_member_id and m.meeting_id = target.meeting_id
      and m.status in ('scheduled', 'in_progress')
  ) then
    raise exception '이미 다른 경기에 배정된 선수입니다. 다시 시도해주세요.';
  end if;

  insert into public.match_players (match_id, member_id, team)
  values (p_match_id, p_member_id, p_team) returning * into inserted;
  return to_jsonb(inserted);
end;
$$;

revoke all on function public.checkout_member_preserving_matches(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.fill_match_vacancy(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.checkout_member_preserving_matches(uuid, uuid, boolean) to service_role;
grant execute on function public.fill_match_vacancy(uuid, uuid, text) to service_role;

-- A waiting roster must not be recorded as a completed doubles result.
create or replace function public.require_full_roster_on_match_end()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (old.ended_at is null and new.ended_at is not null)
    or (old.status <> 'finished' and new.status = 'finished') then
    if (select count(*) from public.match_players where match_id = new.id and team = 'A') <> 2
      or (select count(*) from public.match_players where match_id = new.id and team = 'B') <> 2 then
      raise exception '충원 대기 중인 경기는 종료하거나 결과를 입력할 수 없습니다.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists require_full_roster_on_match_end on public.matches;
create trigger require_full_roster_on_match_end
before update of ended_at, status on public.matches
for each row execute function public.require_full_roster_on_match_end();

-- Team reconfiguration for an already assigned four-player match.
create or replace function public.reconfigure_match_teams(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.matches%rowtype;
  members uuid[];
  current_a uuid[];
  current_pairing integer;
  next_pairing integer;
  result jsonb;
begin
  lock table public.matches, public.match_players in share row exclusive mode;
  select * into target from public.matches where id = p_match_id;
  if not found or target.status not in ('scheduled', 'in_progress') or target.ended_at is not null
    or target.team_a_score is not null or target.team_b_score is not null then
    raise exception '진행 전이거나 진행 중인 경기만 팀을 재구성할 수 있습니다.';
  end if;
  select array_agg(member_id order by created_at, id) into members
  from public.match_players where match_id = p_match_id;
  if cardinality(members) <> 4
    or (select count(*) from public.match_players where match_id = p_match_id and team = 'A') <> 2
    or (select count(*) from public.match_players where match_id = p_match_id and team = 'B') <> 2 then
    raise exception '참여자 4명이 모두 배정된 경기만 팀을 재구성할 수 있습니다.';
  end if;
  select array_agg(member_id order by member_id) into current_a
  from public.match_players where match_id = p_match_id and team = 'A';
  if members[1] = any(current_a) and members[2] = any(current_a) then current_pairing := 0;
  elsif members[1] = any(current_a) and members[3] = any(current_a) then current_pairing := 1;
  elsif members[1] = any(current_a) and members[4] = any(current_a) then current_pairing := 2;
  elsif members[3] = any(current_a) and members[4] = any(current_a) then current_pairing := 0;
  elsif members[2] = any(current_a) and members[4] = any(current_a) then current_pairing := 1;
  else current_pairing := 2;
  end if;
  next_pairing := (current_pairing + 1) % 3;
  update public.match_players set team = case
    when next_pairing = 0 and member_id in (members[1], members[2]) then 'A'
    when next_pairing = 1 and member_id in (members[1], members[3]) then 'A'
    when next_pairing = 2 and member_id in (members[1], members[4]) then 'A'
    else 'B' end
  where match_id = p_match_id;
  select jsonb_build_object('pairingNumber', next_pairing + 1,
    'players', jsonb_agg(to_jsonb(mp) order by mp.team, mp.created_at, mp.id)) into result
  from public.match_players mp where mp.match_id = p_match_id;
  return result;
end;
$$;
revoke all on function public.reconfigure_match_teams(uuid) from public, anon, authenticated;
grant execute on function public.reconfigure_match_teams(uuid) to service_role;
