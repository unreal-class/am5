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
