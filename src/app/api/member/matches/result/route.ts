import { NextResponse } from "next/server";
import { requireUser } from "@/lib/server-supabase";
import { autoAssignMatches, type AssignedMatchSummary } from "@/lib/server-matchmaker";

export async function POST(request: Request) {
  const gate = await requireUser(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const body = await request.json().catch(() => ({}));
  const matchId = String(body.matchId ?? "");
  const teamAScore = Number(body.teamAScore);
  const teamBScore = Number(body.teamBScore);

  if (!matchId) {
    return NextResponse.json({ message: "경기 ID가 필요합니다." }, { status: 400 });
  }

  if (!Number.isFinite(teamAScore) || !Number.isFinite(teamBScore) || teamAScore < 0 || teamBScore < 0 || teamAScore === teamBScore) {
    return NextResponse.json({ message: "승패가 갈리도록 점수를 입력해주세요." }, { status: 400 });
  }

  const admin = gate.admin;
  const { data: participant, error: participantError } = await admin
    .from("match_players")
    .select("id")
    .eq("match_id", matchId)
    .eq("member_id", gate.user.id)
    .maybeSingle();

  if (participantError) {
    return NextResponse.json({ message: participantError.message }, { status: 400 });
  }

  if (!participant && gate.profile.role !== "admin") {
    return NextResponse.json({ message: "본인 참석 경기만 기록할 수 있습니다." }, { status: 403 });
  }

  const { data: match, error: matchLookupError } = await admin
    .from("matches")
    .select("id, meeting_id, ended_at")
    .eq("id", matchId)
    .single();

  if (matchLookupError || !match) {
    return NextResponse.json({ message: matchLookupError?.message ?? "경기를 확인할 수 없습니다." }, { status: 400 });
  }

  const { error } = await admin
    .from("matches")
    .update({
      status: "finished",
      ended_at: match.ended_at ?? new Date().toISOString(),
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      winner_team: teamAScore > teamBScore ? "A" : "B"
    })
    .eq("id", matchId);

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }

  let assignedMatches: AssignedMatchSummary[] = [];

  try {
    assignedMatches = await autoAssignMatches({
      admin,
      meetingId: match.meeting_id,
      currentUserId: gate.user.id
    });
  } catch {
    assignedMatches = [];
  }

  return NextResponse.json({ ok: true, assignedMatches });
}
