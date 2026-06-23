import { memberTodayGameCount } from "@/lib/stats";
import {
  ADMIN_DISPLAY_NAME,
  DEFAULT_COURTS,
  type Attendance,
  type GeneratedMatch,
  type Match,
  type MatchPlayer,
  type MemberStats,
  type Profile,
  type Team
} from "@/lib/models";

type GenerateInput = {
  meetingId: string;
  profiles: Profile[];
  attendances: Attendance[];
  matches: Match[];
  players: MatchPlayer[];
  stats: Map<string, MemberStats>;
  availableCourts?: number[];
};

type Candidate = {
  profile: Profile;
  todayGames: number;
  winRate: number;
  waitingMinutes: number;
  checkedInAt: string;
};

function waitingMinutes(attendance: Attendance) {
  return Math.max(0, Math.round((Date.now() - new Date(attendance.checked_in_at).getTime()) / 60000));
}

const ALL_COURTS: number[] = DEFAULT_COURTS.map((court) => court.court_number);

function pairKey(a: string, b: string) {
  return [a, b].sort().join(":");
}

function buildHistory(matches: Match[], players: MatchPlayer[]) {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const playersByMatch = new Map<string, MatchPlayer[]>();

  players.forEach((player) => {
    const list = playersByMatch.get(player.match_id) ?? [];
    list.push(player);
    playersByMatch.set(player.match_id, list);
  });

  matches.forEach((match) => {
    const rows = playersByMatch.get(match.id) ?? [];
    const teamA = rows.filter((row) => row.team === "A").map((row) => row.member_id);
    const teamB = rows.filter((row) => row.team === "B").map((row) => row.member_id);

    if (teamA.length === 2) {
      const key = pairKey(teamA[0], teamA[1]);
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    }

    if (teamB.length === 2) {
      const key = pairKey(teamB[0], teamB[1]);
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    }

    for (const a of teamA) {
      for (const b of teamB) {
        const key = pairKey(a, b);
        opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
      }
    }
  });

  return { partnerCounts, opponentCounts };
}

function isMixed(team: Candidate[]) {
  return team.some((player) => player.profile.gender === "female") && team.some((player) => player.profile.gender === "male");
}

function teamAverage(team: Candidate[]) {
  return team.reduce((sum, player) => sum + player.winRate, 0) / team.length;
}

function isEligibleProfile(profile: Profile) {
  return profile.display_name !== ADMIN_DISPLAY_NAME;
}

function scorePairing(
  teamA: Candidate[],
  teamB: Candidate[],
  partnerCounts: Map<string, number>
) {
  const hasWomen = [...teamA, ...teamB].some((player) => player.profile.gender === "female");

  let genderPenalty = 0;
  if (hasWomen) {
    if (!isMixed(teamA)) genderPenalty += 1;
    if (!isMixed(teamB)) genderPenalty += 1;
  }

  const balance = Math.abs(teamAverage(teamA) - teamAverage(teamB));

  const partnerRepeat =
    (partnerCounts.get(pairKey(teamA[0].profile.id, teamA[1].profile.id)) ?? 0) +
    (partnerCounts.get(pairKey(teamB[0].profile.id, teamB[1].profile.id)) ?? 0);

  return genderPenalty * 100000 + balance * 100 + partnerRepeat;
}

function bestPairing(
  group: Candidate[],
  partnerCounts: Map<string, number>
) {
  const pairings: Array<[Candidate[], Candidate[]]> = [
    [
      [group[0], group[1]],
      [group[2], group[3]]
    ],
    [
      [group[0], group[2]],
      [group[1], group[3]]
    ],
    [
      [group[0], group[3]],
      [group[1], group[2]]
    ]
  ];

  return pairings
    .map(([teamA, teamB]) => ({
      teamA,
      teamB,
      score: scorePairing(teamA, teamB, partnerCounts),
      balanceGap: Math.abs(teamAverage(teamA) - teamAverage(teamB))
    }))
    .sort((a, b) => a.score - b.score)[0];
}

function activePlayerIds(matches: Match[], players: MatchPlayer[], meetingId: string) {
  const activeMatchIds = new Set(
    matches
      .filter((match) => match.meeting_id === meetingId)
      .filter((match) => match.status === "scheduled" || match.status === "in_progress")
      .map((match) => match.id)
  );

  return new Set(players.filter((player) => activeMatchIds.has(player.match_id)).map((player) => player.member_id));
}

function openCourts(matches: Match[], meetingId: string, availableCourts = ALL_COURTS) {
  const occupied = new Set(
    matches
      .filter((match) => match.meeting_id === meetingId)
      .filter((match) => match.status === "scheduled" || match.status === "in_progress")
      .map((match) => match.court_number)
  );

  return availableCourts.filter((court) => !occupied.has(court));
}

export function generateMatches({
  meetingId,
  profiles,
  attendances,
  matches,
  players,
  stats,
  availableCourts: configuredCourts
}: GenerateInput): GeneratedMatch[] {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const occupiedPlayers = activePlayerIds(matches, players, meetingId);
  const availableCourts = openCourts(matches, meetingId, configuredCourts);
  const eligibleMemberIds = attendances
    .filter((attendance) => attendance.meeting_id === meetingId)
    .filter((attendance) => !attendance.checked_out_at)
    .map((attendance) => attendance.member_id)
    .filter((memberId) => !occupiedPlayers.has(memberId));

  const attendanceByMemberId = new Map(attendances.map((att) => [att.member_id, att]));

  let candidates = eligibleMemberIds
    .map((memberId) => profileById.get(memberId))
    .filter((profile): profile is Profile => Boolean(profile))
    .filter(isEligibleProfile)
    .map((profile) => {
      const stat = stats.get(profile.id);
      const winRate = stat && stat.games > 0 ? stat.winRate : profile.is_guest ? profile.seed_win_rate : 0;
      const att = attendanceByMemberId.get(profile.id);

      return {
        profile,
        todayGames: memberTodayGameCount(profile.id, meetingId, matches, players),
        winRate,
        waitingMinutes: att ? waitingMinutes(att) : 0,
        checkedInAt: att?.checked_in_at ?? ""
      };
    })
    .sort((a, b) => {
      if (a.todayGames !== b.todayGames) return a.todayGames - b.todayGames;
      if (b.waitingMinutes !== a.waitingMinutes) return b.waitingMinutes - a.waitingMinutes;
      return a.checkedInAt.localeCompare(b.checkedInAt);
    });

  const { partnerCounts, opponentCounts } = buildHistory(matches, players);
  const generated: GeneratedMatch[] = [];
  const nextRound = Math.max(0, ...matches.filter((match) => match.meeting_id === meetingId).map((match) => match.round_number)) + 1;
  const slots = Math.min(availableCourts.length, Math.floor(candidates.length / 4));

  for (let slot = 0; slot < slots; slot += 1) {
    const group = candidates.slice(0, 4);
    if (group.length < 4) break;

    const pairing = bestPairing(group, partnerCounts);
    const usedIds = new Set(group.map((c) => c.profile.id));

    generated.push({
      court_number: availableCourts[slot],
      round_number: nextRound,
      teamA: pairing.teamA.map((player) => player.profile.id),
      teamB: pairing.teamB.map((player) => player.profile.id),
      balanceGap: pairing.balanceGap
    });

    const registerPair = (team: Candidate[]) => {
      const key = pairKey(team[0].profile.id, team[1].profile.id);
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    };

    registerPair(pairing.teamA);
    registerPair(pairing.teamB);

    for (const a of pairing.teamA) {
      for (const b of pairing.teamB) {
        const key = pairKey(a.profile.id, b.profile.id);
        opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
      }
    }

    candidates = candidates.filter((c) => !usedIds.has(c.profile.id));
  }

  return generated;
}
