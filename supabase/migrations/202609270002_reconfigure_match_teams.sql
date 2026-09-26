-- Apply after 202609270001_preserve_match_on_checkout.sql.
-- Cycles a complete active match through its three possible doubles pairings.
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
  if not found
    or target.status not in ('scheduled', 'in_progress')
    or target.ended_at is not null
    or target.team_a_score is not null
    or target.team_b_score is not null then
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

  if members[1] = any(current_a) and members[2] = any(current_a) then
    current_pairing := 0;
  elsif members[1] = any(current_a) and members[3] = any(current_a) then
    current_pairing := 1;
  elsif members[1] = any(current_a) and members[4] = any(current_a) then
    current_pairing := 2;
  else
    -- A/B may have been exchanged. Identify the same pairing from team B.
    if members[3] = any(current_a) and members[4] = any(current_a) then
      current_pairing := 0;
    elsif members[2] = any(current_a) and members[4] = any(current_a) then
      current_pairing := 1;
    else
      current_pairing := 2;
    end if;
  end if;

  next_pairing := (current_pairing + 1) % 3;

  update public.match_players
  set team = case
    when next_pairing = 0 and member_id in (members[1], members[2]) then 'A'
    when next_pairing = 1 and member_id in (members[1], members[3]) then 'A'
    when next_pairing = 2 and member_id in (members[1], members[4]) then 'A'
    else 'B'
  end
  where match_id = p_match_id;

  select jsonb_build_object(
    'pairingNumber', next_pairing + 1,
    'players', jsonb_agg(to_jsonb(mp) order by mp.team, mp.created_at, mp.id)
  ) into result
  from public.match_players mp where mp.match_id = p_match_id;

  return result;
end;
$$;

revoke all on function public.reconfigure_match_teams(uuid) from public, anon, authenticated;
grant execute on function public.reconfigure_match_teams(uuid) to service_role;
