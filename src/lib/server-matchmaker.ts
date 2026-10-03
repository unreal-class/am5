import { courtName, type Attendance, type Court, type Match, type MatchPlayer, type Meeting, type Profile } from "@/lib/models";
import { generateMatches, selectReplacement } from "@/lib/scheduler";
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
  waitingMatchCount: number;
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
  // Every candidate in this assignment run is compared at the same fresh
  // server timestamp. A new run always takes a new timestamp and recalculates.
  const assignmentNow = Date.now();
  const stats = buildStats(profiles, meetings, matches, players, "all");
  const availableCourts = courts.filter((court) => court.is_available).map((court) => court.court_number);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const assignedMatches: AssignedMatchSummary[] = [];
  // Preserve each existing team and fill vacancies before creating new games.
  for (const match of matches
    .filter((row) => row.meeting_id === meetingId && !row.ended_at && (row.status === "scheduled" || row.status === "in_progress"))
    .sort((a, b) => a.round_number - b.round_number || a.court_number - b.court_number)) {
    let filled = false;
    for (const team of ["A", "B"] as const) {
      while (players.filter((row) => row.match_id === match.id && row.team === team).length < 2) {
        const replacementId = selectReplacement({
          meetingId, profiles, attendances, matches, players, stats, matchId: match.id, vacantTeam: team,
          now: assignmentNow
        });
        if (!replacementId) break;
        const { data: player, error } = await admin.rpc("fill_match_vacancy", {
          p_match_id: match.id, p_member_id: replacementId, p_team: team
        });
        if (error) throw new Error(error.message);
        if (!player) throw new Error("경기 배정 상태가 변경되었습니다. 다시 시도해주세요.");
        players.push(player as MatchPlayer);
        filled = true;
      }
    }
    if (filled) {
      const teamA = players.filter((row) => row.match_id === match.id && row.team === "A").map((row) => row.member_id);
      const teamB = players.filter((row) => row.match_id === match.id && row.team === "B").map((row) => row.member_id);
      assignedMatches.push({
        id: match.id, courtNumber: match.court_number, courtName: courtName(match.court_number),
        teamA: teamA.map((id) => profileById.get(id)?.display_name ?? "알 수 없음"),
        teamB: teamB.map((id) => profileById.get(id)?.display_name ?? "알 수 없음"),
        includesCurrentUser: [...teamA, ...teamB].includes(currentUserId)
      });
    }
  }
  const generated = generateMatches({
    meetingId,
    profiles,
    attendances,
    matches,
    players,
    stats,
    availableCourts,
    now: assignmentNow
  });
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
  currentUserId,
  confirmReplaceActiveMatch
}: {
  admin: SupabaseClient;
  meetingId: string;
  memberId: string;
  currentUserId: string;
  confirmReplaceActiveMatch: boolean;
}): Promise<CheckoutReassignResult> {
  // Checkout and vacating only this member's seats commit together. Match rows,
  // their times/scores, and every other participant remain untouched.
  const { data: affectedMatchIds, error } = await admin.rpc("checkout_member_preserving_matches", {
    p_meeting_id: meetingId,
    p_member_id: memberId,
    p_confirm_replace: confirmReplaceActiveMatch
  });
  if (error) throw new Error(error.message);

  let assignedMatches: AssignedMatchSummary[] = [];
  let assignmentWarning: string | null = null;
  try {
    assignedMatches = await autoAssignMatches({ admin, meetingId, currentUserId });
  } catch (error) {
    assignmentWarning = error instanceof Error ? error.message : "자동 대진 생성에 실패했습니다.";
  }

  let waitingMatchCount = 0;
  const ids = (affectedMatchIds ?? []) as string[];
  if (ids.length) {
    const { data: remaining, error: lookupError } = await admin.from("match_players").select("match_id").in("match_id", ids);
    if (lookupError) {
      assignmentWarning = assignmentWarning ?? lookupError.message;
    } else {
      waitingMatchCount = ids.filter((id) => (remaining ?? []).filter((row) => row.match_id === id).length < 4).length;
    }
  }
  return { waitingMatchCount, assignedMatches, assignmentWarning };
}
