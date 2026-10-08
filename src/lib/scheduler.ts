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
  now?: number;
};

type Candidate = {
  profile: Profile;
  todayGames: number;
  priorityGames: number;
  winRate: number;
  waitingMinutes: number;
  checkedInAt: string;
  queueRank: number;
  checkInRank: number;
};

export function accumulatedWaitingMinutes(
  memberId: string,
  attendance: Attendance,
  matches: Match[],
  players: MatchPlayer[],
  meetingId: string,
  now: number
) {
  const checkedInAt = new Date(attendance.checked_in_at).getTime();
  if (!Number.isFinite(checkedInAt) || checkedInAt >= now) return 0;

  const todayMatchIds = new Set(matches.filter((match) => match.meeting_id === meetingId).map((match) => match.id));
  const memberMatchIds = new Set(
    players
      .filter((player) => player.member_id === memberId)
      .filter((player) => todayMatchIds.has(player.match_id))
      .map((player) => player.match_id)
  );
  const completedIntervals = matches
    .filter((match) => memberMatchIds.has(match.id))
    .filter((match) => match.status === "finished" && match.started_at && match.ended_at)
    .map((match) => ({
      startedAt: new Date(match.started_at as string).getTime(),
      endedAt: new Date(match.ended_at as string).getTime()
    }))
    .filter(({ startedAt, endedAt }) =>
      Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= checkedInAt && endedAt <= now && endedAt >= startedAt
    )
    .sort((a, b) => a.endedAt - b.endedAt || a.startedAt - b.startedAt);

  if (completedIntervals.length === 0) {
    return Math.max(0, (now - checkedInAt) / 60000);
  }

  // The accumulated clock starts when the first completed game ends. Later
  // game intervals pause that clock; overlapping intervals are merged so time
  // can never be subtracted twice because of malformed or duplicate records.
  const accumulationStartedAt = completedIntervals[0].endedAt;
  const pausedIntervals = completedIntervals
    .map(({ startedAt, endedAt }) => ({
      startedAt: Math.max(accumulationStartedAt, startedAt),
      endedAt: Math.min(now, endedAt)
    }))
    .filter(({ startedAt, endedAt }) => endedAt > startedAt)
    .sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
  let pausedMs = 0;
  let pausedStart = 0;
  let pausedEnd = 0;

  for (const interval of pausedIntervals) {
    if (interval.startedAt > pausedEnd) {
      pausedMs += Math.max(0, pausedEnd - pausedStart);
      pausedStart = interval.startedAt;
      pausedEnd = interval.endedAt;
    } else {
      pausedEnd = Math.max(pausedEnd, interval.endedAt);
    }
  }
  pausedMs += Math.max(0, pausedEnd - pausedStart);

  // Keep fractional minutes internally so candidates who differ by seconds do
  // not become an artificial tie. Formatting can round only for display.
  return Math.max(0, (now - accumulationStartedAt - pausedMs) / 60000);
}

const ALL_COURTS: number[] = DEFAULT_COURTS.map((court) => court.court_number);
const GROUP_POOL_SIZE = 12;
const EARLY_CHECK_IN_WINDOW_MS = 30 * 60 * 1000;
const TODAY_GAMES_WEIGHT = 10000;
const QUEUE_RANK_WEIGHT = 100;
const GROUP_REPEAT_WEIGHT = 4000;
const SKILL_SPREAD_WEIGHT = 400;
const WAITING_RELIEF_WEIGHT = 300;

function pairKey(a: string, b: string) {
  return [a, b].sort().join(":");
}

function matchupKey(teamA: string[], teamB: string[]) {
  return [pairKey(teamA[0], teamA[1]), pairKey(teamB[0], teamB[1])].sort().join("|");
}

function buildHistory(matches: Match[], players: MatchPlayer[]) {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const matchupCounts = new Map<string, number>();
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

    if (teamA.length === 2 && teamB.length === 2) {
      const key = matchupKey(teamA, teamB);
      matchupCounts.set(key, (matchupCounts.get(key) ?? 0) + 1);
    }

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

  return { partnerCounts, opponentCounts, matchupCounts };
}

function isMixed(team: Candidate[]) {
  return team.some((player) => player.profile.gender === "female") && team.some((player) => player.profile.gender === "male");
}

function teamAverage(team: Candidate[]) {
  return team.reduce((sum, player) => sum + player.winRate, 0) / team.length;
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];

  const [head, ...tail] = items;
  return [
    ...combinations(tail, size - 1).map((group) => [head, ...group]),
    ...combinations(tail, size)
  ];
}

function skillSpread(group: Candidate[]) {
  const rates = group.map((player) => player.winRate);
  return Math.max(...rates) - Math.min(...rates);
}

function groupRepeatCount(
  group: Candidate[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
) {
  let total = 0;

  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const key = pairKey(group[i].profile.id, group[j].profile.id);
      total += (partnerCounts.get(key) ?? 0) + (opponentCounts.get(key) ?? 0);
    }
  }

  return total;
}

function scoreGroup(
  group: Candidate[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
) {
  const todayGamesTotal = group.reduce((sum, player) => sum + player.priorityGames, 0);
  const queueRankTotal = group.reduce((sum, player) => sum + player.queueRank, 0);
  const repeatCount = groupRepeatCount(group, partnerCounts, opponentCounts);
  const spread = skillSpread(group);
  const waitingRelief = group.reduce((sum, player) => sum + player.waitingMinutes, 0);

  return (
    todayGamesTotal * TODAY_GAMES_WEIGHT +
    queueRankTotal * QUEUE_RANK_WEIGHT +
    repeatCount * GROUP_REPEAT_WEIGHT +
    spread * SKILL_SPREAD_WEIGHT -
    waitingRelief * WAITING_RELIEF_WEIGHT
  );
}

function checkInRankTotal(group: Candidate[]) {
  return group.reduce((sum, player) => sum + player.checkInRank, 0);
}

function bestGroup(
  candidates: Candidate[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
) {
  const minGames = Math.min(...candidates.map((candidate) => candidate.priorityGames));

  const lowestGameCandidates = candidates.filter((candidate) => candidate.priorityGames === minGames);
  const required = [...lowestGameCandidates]
    .sort((a, b) => {
      if (b.waitingMinutes !== a.waitingMinutes) return b.waitingMinutes - a.waitingMinutes;
      return a.checkedInAt.localeCompare(b.checkedInAt);
    })
    .slice(0, Math.min(2, lowestGameCandidates.length));
  const requiredIds = new Set(required.map((candidate) => candidate.profile.id));
  const poolCandidates = candidates
    .filter((candidate) => candidate.priorityGames === minGames)
    .concat(candidates.filter((candidate) => candidate.priorityGames > minGames))
    .slice(0, Math.max(GROUP_POOL_SIZE, 4));
  const poolById = new Map(poolCandidates.map((candidate) => [candidate.profile.id, candidate]));

  required.forEach((candidate) => {
    poolById.set(candidate.profile.id, candidate);
  });

  return combinations([...poolById.values()], 4)
    .filter((group) => [...requiredIds].every((id) => group.some((candidate) => candidate.profile.id === id)))
    .filter((group) => {
      const lowestGameCount = group.filter((candidate) => candidate.priorityGames === minGames).length;
      return lowestGameCount === Math.min(4, lowestGameCandidates.length);
    })
    .map((group) => ({
      group,
      score: scoreGroup(group, partnerCounts, opponentCounts),
      checkInRankTotal: checkInRankTotal(group)
    }))
    .sort((a, b) => a.score - b.score || a.checkInRankTotal - b.checkInRankTotal)[0]?.group ?? [];
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

  return { genderPenalty, balance, partnerRepeat };
}

function bestPairing(
  group: Candidate[],
  partnerCounts: Map<string, number>,
  matchupCounts: Map<string, number>
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
      repeats: matchupCounts.get(matchupKey(
        teamA.map((player) => player.profile.id),
        teamB.map((player) => player.profile.id)
      )) ?? 0,
      balanceGap: Math.abs(teamAverage(teamA) - teamAverage(teamB))
    }))
    .sort((a, b) =>
      a.score.genderPenalty - b.score.genderPenalty ||
      a.repeats - b.repeats ||
      a.score.partnerRepeat - b.score.partnerRepeat ||
      a.score.balance - b.score.balance
    )[0];
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

function waitingCandidates({
  meetingId,
  profiles,
  attendances,
  matches,
  players,
  stats,
  now = Date.now()
}: GenerateInput): Candidate[] {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const occupiedPlayers = activePlayerIds(matches, players, meetingId);
  // Re-entry creates another row. Never let an old checkout (or another
  // meeting's attendance) overwrite the current session, regardless of order.
  const attendanceByMemberId = new Map<string, Attendance>();
  for (const attendance of attendances) {
    if (attendance.meeting_id !== meetingId || attendance.checked_out_at) continue;
    const current = attendanceByMemberId.get(attendance.member_id);
    if (!current || new Date(attendance.checked_in_at).getTime() > new Date(current.checked_in_at).getTime()) {
      attendanceByMemberId.set(attendance.member_id, attendance);
    }
  }
  const eligibleMemberIds = [...attendanceByMemberId.keys()]
    .filter((memberId) => !occupiedPlayers.has(memberId));
  const firstCheckIn = Math.min(...[...attendanceByMemberId.values()]
    .filter((attendance) => {
      const profile = profileById.get(attendance.member_id);
      return profile && isEligibleProfile(profile);
    })
    .map((attendance) => new Date(attendance.checked_in_at).getTime())
    .filter(Number.isFinite));

  return eligibleMemberIds
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
        priorityGames: 0,
        winRate,
        waitingMinutes: att ? accumulatedWaitingMinutes(profile.id, att, matches, players, meetingId, now) : 0,
        checkedInAt: att?.checked_in_at ?? "",
        queueRank: 0,
        checkInRank: 0
      };
    })
    .map((candidate) => ({
      ...candidate,
      priorityGames: candidate.todayGames -
        (new Date(candidate.checkedInAt).getTime() - firstCheckIn < EARLY_CHECK_IN_WINDOW_MS ? 1 : 0)
    }))
    .map((candidate, _index, rows) => ({
      ...candidate,
      checkInRank: [...rows]
        .sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt))
        .findIndex((row) => row.profile.id === candidate.profile.id)
    }))
    .sort((a, b) => {
      if (a.priorityGames !== b.priorityGames) return a.priorityGames - b.priorityGames;
      if (b.waitingMinutes !== a.waitingMinutes) return b.waitingMinutes - a.waitingMinutes;
      return a.checkedInAt.localeCompare(b.checkedInAt);
    })
    .map((candidate, queueRank) => ({ ...candidate, queueRank }));
}

// Only the departing player's seat may change. Select one waiting member
// using the same attendance/game priorities, then break ties by team fit.
export function selectReplacement(
  input: GenerateInput & { matchId: string; departingMemberId?: string; vacantTeam?: Team }
): string | null {
  const match = input.matches.find((row) => row.id === input.matchId && row.meeting_id === input.meetingId);
  if (!match || match.ended_at || (match.status !== "scheduled" && match.status !== "in_progress")) return null;
  const seats = input.players.filter((row) => row.match_id === match.id);
  const departing = seats.find((row) => row.member_id === input.departingMemberId);
  const vacantTeam = departing?.team ?? input.vacantTeam;
  const remaining = seats.filter((row) => row !== departing);
  if (!vacantTeam || (input.departingMemberId && !departing) ||
    new Set(remaining.map((row) => row.member_id)).size !== remaining.length ||
    remaining.filter((row) => row.team === vacantTeam).length >= 2 ||
    remaining.filter((row) => row.team !== vacantTeam).length > 2) return null;

  const candidates = waitingCandidates(input).filter((row) => row.profile.id !== input.departingMemberId);
  if (!candidates.length) return null;
  const history = buildHistory(input.matches.filter((row) => row.id !== match.id), input.players);
  const profileById = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const fixed = remaining.map((seat) => {
    const profile = profileById.get(seat.member_id);
    if (!profile) throw new Error("기존 경기 참여자 정보를 찾을 수 없습니다.");
    const stat = input.stats.get(profile.id);
    return {
      team: seat.team,
      candidate: {
        profile, winRate: stat && stat.games > 0 ? stat.winRate : profile.is_guest ? profile.seed_win_rate : 0,
        todayGames: 0, priorityGames: 0, waitingMinutes: 0, checkedInAt: "", queueRank: 0, checkInRank: 0
      }
    };
  });

  return candidates.map((candidate) => {
    const team = (side: Team) => [
      ...fixed.filter((row) => row.team === side).map((row) => row.candidate),
      ...(vacantTeam === side ? [candidate] : [])
    ];
    const teamA = team("A");
    const teamB = team("B");
    return {
      candidate,
      score: remaining.length === 3 ? scorePairing(teamA, teamB, history.partnerCounts) : { genderPenalty: 0, partnerRepeat: 0, balance: 0 },
      repeats: remaining.length === 3 ? history.matchupCounts.get(matchupKey(
        teamA.map((row) => row.profile.id), teamB.map((row) => row.profile.id)
      )) ?? 0 : 0
    };
  }).sort((a, b) =>
    a.candidate.priorityGames - b.candidate.priorityGames ||
    b.candidate.waitingMinutes - a.candidate.waitingMinutes ||
    a.candidate.checkedInAt.localeCompare(b.candidate.checkedInAt) ||
    a.score.genderPenalty - b.score.genderPenalty ||
    a.repeats - b.repeats ||
    a.score.partnerRepeat - b.score.partnerRepeat ||
    a.score.balance - b.score.balance ||
    a.candidate.profile.id.localeCompare(b.candidate.profile.id)
  )[0].candidate.profile.id;
}

export function generateMatches(input: GenerateInput): GeneratedMatch[] {
  const { meetingId, matches, players, availableCourts: configuredCourts } = input;
  const availableCourts = openCourts(matches, meetingId, configuredCourts);
  let candidates = waitingCandidates(input);

  const { partnerCounts, opponentCounts, matchupCounts } = buildHistory(matches, players);
  const generated: GeneratedMatch[] = [];
  const nextRound = Math.max(0, ...matches.filter((match) => match.meeting_id === meetingId).map((match) => match.round_number)) + 1;
  const slots = Math.min(availableCourts.length, Math.floor(candidates.length / 4));

  for (let slot = 0; slot < slots; slot += 1) {
    const group = bestGroup(candidates, partnerCounts, opponentCounts);
    if (group.length < 4) break;

    const pairing = bestPairing(group, partnerCounts, matchupCounts);
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
