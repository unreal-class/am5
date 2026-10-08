import { ADMIN_DISPLAY_NAME, type Attendance, type Match, type MatchPlayer, type Profile } from "@/lib/models";
import { accumulatedWaitingMinutes } from "@/lib/scheduler";

export type WaitingMemberRow = {
  memberId: string;
  name: string;
  games: number;
  waitingMinutes: number;
  checkedInAt: string;
};

export function buildWaitingMemberRows({
  profiles,
  attendances,
  matches,
  players,
  meetingId,
  activeMatchMemberIds,
  todayGameCountByMemberId,
  now
}: {
  profiles: Profile[];
  attendances: Attendance[];
  matches: Match[];
  players: MatchPlayer[];
  meetingId: string;
  activeMatchMemberIds: Set<string>;
  todayGameCountByMemberId: Map<string, number>;
  now: number;
}): WaitingMemberRow[] {
  if (!meetingId) return [];

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const activeAttendanceByMemberId = new Map<string, Attendance>();

  attendances.forEach((attendance) => {
    if (attendance.meeting_id !== meetingId || attendance.checked_out_at) return;
    const current = activeAttendanceByMemberId.get(attendance.member_id);
    if (!current || attendance.checked_in_at > current.checked_in_at) {
      activeAttendanceByMemberId.set(attendance.member_id, attendance);
    }
  });

  return [...activeAttendanceByMemberId.entries()]
    .filter(([memberId]) => !activeMatchMemberIds.has(memberId))
    .map(([memberId, attendance]) => {
      const member = profileById.get(memberId);
      if (!member || member.display_name === ADMIN_DISPLAY_NAME) return null;

      return {
        memberId,
        name: member.display_name,
        games: todayGameCountByMemberId.get(memberId) ?? 0,
        waitingMinutes: Math.floor(accumulatedWaitingMinutes(
          memberId,
          attendance,
          matches,
          players,
          meetingId,
          now
        )),
        checkedInAt: attendance.checked_in_at
      };
    })
    .filter((row): row is WaitingMemberRow => row !== null)
    .sort((a, b) =>
      a.games - b.games ||
      b.waitingMinutes - a.waitingMinutes ||
      a.checkedInAt.localeCompare(b.checkedInAt) ||
      a.name.localeCompare(b.name, "ko")
    );
}
