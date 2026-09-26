-- Apply after the earlier 20260927 migrations.
-- Administrative recovery operations for the current meeting.
create or replace function public.reset_meeting_assignments(p_meeting_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  lock table public.meetings, public.matches, public.match_players in share row exclusive mode;

  if not exists (select 1 from public.meetings where id = p_meeting_id and status = 'active') then
    raise exception '진행 중인 모임을 찾을 수 없습니다.';
  end if;

  with deleted as (
    delete from public.matches
    where meeting_id = p_meeting_id and status in ('scheduled', 'in_progress')
    returning id
  )
  select count(*) into deleted_count from deleted;

  return jsonb_build_object('stoppedMatchCount', deleted_count);
end;
$$;

create or replace function public.close_meeting_operations(p_meeting_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  stopped_count integer;
  checkout_count integer;
  operation_time timestamptz := now();
begin
  lock table public.meetings, public.attendances, public.matches, public.match_players in share row exclusive mode;

  if not exists (select 1 from public.meetings where id = p_meeting_id) then
    raise exception '모임을 찾을 수 없습니다.';
  end if;

  with deleted as (
    delete from public.matches
    where meeting_id = p_meeting_id and status in ('scheduled', 'in_progress')
    returning id
  )
  select count(*) into stopped_count from deleted;

  with checked_out as (
    update public.attendances
    set checked_out_at = operation_time
    where meeting_id = p_meeting_id and checked_out_at is null
    returning id
  )
  select count(*) into checkout_count from checked_out;

  update public.meetings set status = 'closed' where id = p_meeting_id;

  return jsonb_build_object(
    'stoppedMatchCount', stopped_count,
    'checkedOutCount', checkout_count,
    'closedAt', operation_time
  );
end;
$$;

revoke all on function public.reset_meeting_assignments(uuid) from public, anon, authenticated;
revoke all on function public.close_meeting_operations(uuid) from public, anon, authenticated;
grant execute on function public.reset_meeting_assignments(uuid) to service_role;
grant execute on function public.close_meeting_operations(uuid) to service_role;
