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
alter table public.courts add constraint courts_court_name_check check (court_name in ('1', '2', '3'));

insert into public.courts (court_number, court_name, is_available)
values
  (1, '1', false),
  (2, '2', false),
  (3, '3', false)
on conflict (court_number) do update
set court_name = excluded.court_name;

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
