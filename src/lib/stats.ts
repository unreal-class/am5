import {
  currentMonthKey,
  currentYearKey
} from "@/lib/date";
import type {
  Match,
  MatchPlayer,
  Meeting,
  MemberStats,
  Profile,
  RankedMember,
  RankingScope,
  Team
} from "@/lib/models";

function emptyStats(memberId: string): MemberStats {
  return {
    memberId,
    games: 0,
    wins: 0,
    losses: 0,
    winRate: 0
  };
}

function matchDate(match: Match, meetingById: Map<string, Meeting>) {
  const meetingDate = meetingById.get(match.meeting_id)?.meeting_date;
  if (meetingDate) return meetingDate;
  return (match.ended_at ?? match.started_at ?? match.created_at).slice(0, 10);
}

function isInScope(match: Match, meetings: Map<string, Meeting>, scope: RankingScope) {
  const date = matchDate(match, meetings);
  if (scope === "month") return date.startsWith(currentMonthKey());
  if (scope === "year") return date.startsWith(currentYearKey());
  return true;
}

function resolveWinner(match: Match): Team | null {
  if (match.winner_team) return match.winner_team;
  if (match.team_a_score === null || match.team_b_score === null) return null;
  if (match.team_a_score === match.team_b_score) return null;
  return match.team_a_score > match.team_b_score ? "A" : "B";
}

export function buildStats(
  profiles: Profile[],
  meetings: Meeting[],
  matches: Match[],
  players: MatchPlayer[],
  scope: RankingScope
) {
  const stats = new Map<string, MemberStats>();
  const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  const playersByMatch = new Map<string, MatchPlayer[]>();

  profiles.forEach((profile) => {
    stats.set(profile.id, emptyStats(profile.id));
  });

  players.forEach((player) => {
    const list = playersByMatch.get(player.match_id) ?? [];
    list.push(player);
    playersByMatch.set(player.match_id, list);
  });

  matches
    .filter((match) => match.status === "finished")
    .filter((match) => isInScope(match, meetingById, scope))
    .forEach((match) => {
      const winner = resolveWinner(match);
      if (!winner) return;

      for (const player of playersByMatch.get(match.id) ?? []) {
        const row = stats.get(player.member_id) ?? emptyStats(player.member_id);
        row.games += 1;
        if (player.team === winner) row.wins += 1;
        else row.losses += 1;
        row.winRate = row.games > 0 ? (row.wins / row.games) * 100 : 0;
        stats.set(player.member_id, row);
      }
    });

  return stats;
}

export function getRankings(
  profiles: Profile[],
  meetings: Meeting[],
  matches: Match[],
  players: MatchPlayer[],
  scope: RankingScope
): RankedMember[] {
  const stats = buildStats(profiles, meetings, matches, players, scope);

  return profiles
    .map((profile) => ({
      ...(stats.get(profile.id) ?? emptyStats(profile.id)),
      rank: 0,
      name: profile.display_name,
      gender: profile.gender
    }))
    .sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.games !== a.games) return b.games - a.games;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.name.localeCompare(b.name, "ko");
    })
    .map((row, index, rows) => {
      const previous = rows[index - 1];
      const tied =
        previous &&
        previous.winRate === row.winRate &&
        previous.games === row.games &&
        previous.wins === row.wins;

      return {
        ...row,
        rank: tied ? previous.rank : index + 1
      };
    });
}

export function memberTodayGameCount(memberId: string, meetingId: string, matches: Match[], players: MatchPlayer[]) {
  const todayMatchIds = new Set(matches.filter((match) => match.meeting_id === meetingId).map((match) => match.id));
  return players.filter((player) => player.member_id === memberId && todayMatchIds.has(player.match_id)).length;
}
