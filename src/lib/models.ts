export type Gender = "male" | "female" | "other";
export type Role = "member" | "admin";
export type MeetingStatus = "active" | "closed";
export type MatchStatus = "scheduled" | "in_progress" | "finished";
export type Team = "A" | "B";
export type RankingScope = "all" | "month" | "year";
export type CourtName = "A" | "B" | "C";

export const DEFAULT_PASSWORD = "AM5AM5";
export const ADMIN_LOGIN_ID = "admin";
export const ADMIN_DISPLAY_NAME = "관리자";
export const DEFAULT_COURTS = [
  { court_number: 1, court_name: "A" },
  { court_number: 2, court_name: "B" },
  { court_number: 3, court_name: "C" }
] as const;

export function courtName(courtNumber: number) {
  return DEFAULT_COURTS.find((court) => court.court_number === courtNumber)?.court_name ?? String(courtNumber);
}

export type Profile = {
  id: string;
  login_id: string;
  display_name: string;
  phone: string;
  gender: Gender;
  role: Role;
  is_guest: boolean;
  seed_win_rate: number;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
};

export type Meeting = {
  id: string;
  meeting_date: string;
  status: MeetingStatus;
  created_by: string | null;
  created_at: string;
};

export type Attendance = {
  id: string;
  meeting_id: string;
  member_id: string;
  checked_in_at: string;
  checked_out_at: string | null;
  created_at: string;
};

export type Court = {
  court_number: number;
  court_name: CourtName;
  is_available: boolean;
  rental_started_at: string | null;
  rental_ended_at: string | null;
  updated_at: string;
};

export type Match = {
  id: string;
  meeting_id: string;
  court_number: number;
  round_number: number;
  status: MatchStatus;
  started_at: string | null;
  ended_at: string | null;
  team_a_score: number | null;
  team_b_score: number | null;
  winner_team: Team | null;
  created_at: string;
  updated_at: string;
};

export type MatchPlayer = {
  id: string;
  match_id: string;
  member_id: string;
  team: Team;
  created_at: string;
};

export type MemberStats = {
  memberId: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
};

export type RankedMember = MemberStats & {
  rank: number;
  name: string;
  gender: Gender;
};

export type GeneratedMatch = {
  court_number: number;
  round_number: number;
  teamA: string[];
  teamB: string[];
  balanceGap: number;
};
