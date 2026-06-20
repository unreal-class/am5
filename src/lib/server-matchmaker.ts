import { courtName, type Attendance, type Court, type Match, type MatchPlayer, type Meeting, type Profile } from "@/lib/models";
import { generateMatches } from "@/lib/scheduler";
import { buildStats } from "@/lib/stats";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AssignedMatchSummary = {
  id: string;
  courtNumber: number;
  courtName: string;
  teamA: string[];
  teamB: string[];
  includesCurrentUser: boolean;
};

export type CheckoutReassignResult = {
  canceledMatchCount: number;
  assignedMatches: AssignedMatchSummary[];
  assignmentWarning: string | null;
};

export async function autoAssignMatches({
  admin,
  meetingId,
  currentUserId
}: {
  admin: SupabaseClient;
  meetingId: string;
  currentUserId: string;
}) {
  const [profilesResult, meetingsResult, attendancesResult, matchesResult, playersResult, courtsResult] = await Promise.all([
    admin.from("profiles").select("*").order("display_name", { ascending: true }),
    admin.from("meetings").select("*"),
    admin.from("attendances").select("*").eq("meeting_id", meetingId),
    admin.from("matches").select("*"),
    admin.from("match_players").select("*"),
    admin.from("courts").select("*").order("court_number", { ascending: true })
  ]);

  for (const result of [profilesResult, meetingsResult, attendancesResult, matchesResult, playersResult, courtsResult]) {
    if (result.error) {
      throw result.error;
    }
  }

  const profiles = (profilesResult.data ?? []) as Profile[];
  const meetings = (meetingsResult.data ?? []) as Meeting[];
  const attendances = (attendancesResult.data ?? []) as Attendance[];
  const matches = (matchesResult.data ?? []) as Match[];
  const players = (playersResult.data ?? []) as MatchPlayer[];
  const courts = (courtsResult.data ?? []) as Court[];
  const stats = buildStats(profiles, meetings, matches, players, "all");
  const availableCourts = courts.filter((court) => court.is_available).map((court) => court.court_number);
  const generated = generateMatches({
    meetingId,
    profiles,
    attendances,
    matches,
    players,
    stats,
    availableCourts
  });
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const assignedMatches: AssignedMatchSummary[] = [];

  for (const generatedMatch of generated) {
    const { data: match, error: matchError } = await admin
      .from("matches")
      .insert({
        meeting_id: meetingId,
        court_number: generatedMatch.court_number,
        round_number: generatedMatch.round_number,
        status: "in_progress",
        started_at: new Date().toISOString()
      })
      .select("*")
      .single();

    if (matchError || !match) {
      throw matchError ?? new Error("경기 생성에 실패했습니다.");
    }

    const rows = [
      ...generatedMatch.teamA.map((memberId) => ({ match_id: match.id, member_id: memberId, team: "A" })),
      ...generatedMatch.teamB.map((memberId) => ({ match_id: match.id, member_id: memberId, team: "B" }))
    ];
    const { error: playerError } = await admin.from("match_players").insert(rows);

    if (playerError) {
      throw playerError;
    }

    assignedMatches.push({
      id: match.id,
      courtNumber: generatedMatch.court_number,
      courtName: courtName(generatedMatch.court_number),
      teamA: generatedMatch.teamA.map((id) => profileById.get(id)?.display_name ?? "알 수 없음"),
      teamB: generatedMatch.teamB.map((id) => profileById.get(id)?.display_name ?? "알 수 없음"),
      includesCurrentUser: [...generatedMatch.teamA, ...generatedMatch.teamB].includes(currentUserId)
    });
  }

  return assignedMatches;
}

export async function checkoutMemberAndReassign({
  admin,
  meetingId,
  memberId,
  currentUserId
}: {
  admin: SupabaseClient;
  meetingId: string;
  memberId: string;
  currentUserId: string;
}): Promise<CheckoutReassignResult> {
  const { data: activeAttendance, error: activeAttendanceError } = await admin
    .from("attendances")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("member_id", memberId)
    .is("checked_out_at", null)
    .maybeSingle();

  if (activeAttendanceError) {
    throw new Error(activeAttendanceError.message);
  }

  if (!activeAttendance) {
    throw new Error("출석 중인 회원이 아닙니다.");
  }

  const { data: activeMatches, error: activeMatchError } = await admin
    .from("matches")
    .select("id, status")
    .eq("meeting_id", meetingId)
    .in("status", ["scheduled", "in_progress"]);

  if (activeMatchError) {
    throw new Error(activeMatchError.message);
  }

  const matchById = new Map(((activeMatches ?? []) as Pick<Match, "id" | "status">[]).map((match) => [match.id, match]));
  const activeMatchIds = Array.from(matchById.keys());
  let scheduledMatchIds: string[] = [];

  if (activeMatchIds.length > 0) {
    const { data: activePlayers, error: activePlayerError } = await admin
      .from("match_players")
      .select("match_id")
      .eq("member_id", memberId)
      .in("match_id", activeMatchIds);

    if (activePlayerError) {
      throw new Error(activePlayerError.message);
    }

    const memberActivePlayers = (activePlayers ?? []) as Pick<MatchPlayer, "match_id">[];
    const inProgressMatch = memberActivePlayers.some((player) => matchById.get(player.match_id)?.status === "in_progress");

    if (inProgressMatch) {
      throw new Error("진행 중인 경기가 있습니다. 먼저 경기 종료와 결과 입력을 완료한 뒤 퇴장해주세요.");
    }

    scheduledMatchIds = Array.from(
      new Set(
        memberActivePlayers
          .filter((player) => matchById.get(player.match_id)?.status === "scheduled")
          .map((player) => player.match_id)
      )
    );
  }

  if (scheduledMatchIds.length > 0) {
    const { error: cancelError } = await admin.from("matches").delete().in("id", scheduledMatchIds);

    if (cancelError) {
      throw new Error(cancelError.message);
    }
  }

  const { data: attendance, error: attendanceError } = await admin
    .from("attendances")
    .update({ checked_out_at: new Date().toISOString() })
    .eq("id", activeAttendance.id)
    .select("id")
    .maybeSingle();

  if (attendanceError) {
    throw new Error(attendanceError.message);
  }

  if (!attendance) {
    throw new Error("퇴장 처리할 출석 기록을 찾을 수 없습니다.");
  }

  let assignedMatches: AssignedMatchSummary[] = [];
  let assignmentWarning: string | null = null;

  try {
    assignedMatches = await autoAssignMatches({
      admin,
      meetingId,
      currentUserId
    });
  } catch (error) {
    assignmentWarning = error instanceof Error ? error.message : "자동 대진 생성에 실패했습니다.";
  }

  return {
    canceledMatchCount: scheduledMatchIds.length,
    assignedMatches,
    assignmentWarning
  };
}
