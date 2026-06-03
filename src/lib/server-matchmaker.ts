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
        status: "scheduled"
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
