import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { generateMatches } from "../../src/lib/scheduler";
import { ADMIN_DISPLAY_NAME, type Attendance, type Court, type Match, type MatchPlayer, type Meeting, type Profile } from "../../src/lib/models";
import { buildStats } from "../../src/lib/stats";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  const text = readFileSync(envPath, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] = process.env[key] ?? value;
  }
}

function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function activeAttendance(attendances: Attendance[]) {
  return attendances.filter((attendance) => !attendance.checked_out_at);
}

function syntheticAttendances(meetingId: string, profiles: Profile[]): Attendance[] {
  const base = Date.now() - profiles.length * 60000;

  return profiles
    .filter((profile) => profile.display_name !== ADMIN_DISPLAY_NAME)
    .map((profile, index) => ({
      id: `dry-run-attendance-${profile.id}`,
      meeting_id: meetingId,
      member_id: profile.id,
      checked_in_at: new Date(base + index * 60000).toISOString(),
      checked_out_at: null,
      created_at: new Date(base + index * 60000).toISOString()
    }));
}

function names(ids: string[], profileById: Map<string, Profile>) {
  return ids.map((id) => profileById.get(id)?.display_name ?? "알 수 없음").join(", ");
}

function groupKey(ids: string[]) {
  return [...ids].sort().join(":");
}

function createRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomDurationMinutes(random: () => number) {
  return 16 + Math.round(random() * 8);
}

function minutesBetween(start: number, end: number) {
  return Math.max(0, Math.round((end - start) / 60000));
}

function formatClock(time: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(time));
}

function simulateRounds({
  meetingId,
  profiles,
  attendances,
  matches,
  players,
  stats,
  availableCourts,
  profileById,
  rounds
}: {
  meetingId: string;
  profiles: Profile[];
  attendances: Attendance[];
  matches: Match[];
  players: MatchPlayer[];
  stats: ReturnType<typeof buildStats>;
  availableCourts: number[];
  profileById: Map<string, Profile>;
  rounds: number;
}) {
  const localMatches = [...matches];
  const localPlayers = [...players];
  const seenGroups = new Map<string, number>();

  console.log(`\n[multi-round dry run] rounds=${rounds}`);

  for (let round = 1; round <= rounds; round += 1) {
    const generated = generateMatches({
      meetingId,
      profiles,
      attendances,
      matches: localMatches,
      players: localPlayers,
      stats,
      availableCourts
    });

    console.log(`round ${round}: generated=${generated.length}`);

    generated.forEach((match, index) => {
      const ids = [...match.teamA, ...match.teamB];
      const key = groupKey(ids);
      const previousCount = seenGroups.get(key) ?? 0;
      seenGroups.set(key, previousCount + 1);

      console.log(
        `  ${index + 1}. court ${match.court_number}: A(${names(match.teamA, profileById)}) vs B(${names(match.teamB, profileById)})` +
          (previousCount > 0 ? ` [repeated group ${previousCount + 1}x]` : "")
      );

      const matchId = `dry-run-match-${round}-${index}`;
      localMatches.push({
        id: matchId,
        meeting_id: meetingId,
        court_number: match.court_number,
        round_number: round,
        status: "finished",
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        team_a_score: 6,
        team_b_score: 4,
        winner_team: "A",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      localPlayers.push(
        ...match.teamA.map((memberId) => ({
          id: `dry-run-player-${matchId}-${memberId}`,
          match_id: matchId,
          member_id: memberId,
          team: "A" as const,
          created_at: new Date().toISOString()
        })),
        ...match.teamB.map((memberId) => ({
          id: `dry-run-player-${matchId}-${memberId}`,
          match_id: matchId,
          member_id: memberId,
          team: "B" as const,
          created_at: new Date().toISOString()
        }))
      );
    });
  }
}

function simulateTimedRun({
  meetingId,
  profiles,
  attendances,
  matches,
  players,
  stats,
  availableCourts,
  profileById,
  targetCompletedMatches
}: {
  meetingId: string;
  profiles: Profile[];
  attendances: Attendance[];
  matches: Match[];
  players: MatchPlayer[];
  stats: ReturnType<typeof buildStats>;
  availableCourts: number[];
  profileById: Map<string, Profile>;
  targetCompletedMatches: number;
}) {
  const random = createRandom(20260704);
  const localMatches = [...matches];
  const localPlayers = [...players];
  const activeMatchIds = new Set<string>();
  const seenGroups = new Map<string, number>();
  const activeMembers = new Set(attendances.filter((attendance) => !attendance.checked_out_at).map((attendance) => attendance.member_id));
  const attendanceByMemberId = new Map(attendances.map((attendance) => [attendance.member_id, attendance]));
  const firstCheckIn = Math.min(...attendances.map((attendance) => new Date(attendance.checked_in_at).getTime()));
  const waitStartedAt = new Map<string, number>();
  const totalWaitingMs = new Map<string, number>();
  const scheduledFinishes: Array<{ matchId: string; endAt: number }> = [];

  activeMembers.forEach((memberId) => {
    waitStartedAt.set(memberId, new Date(attendanceByMemberId.get(memberId)?.checked_in_at ?? firstCheckIn).getTime());
    totalWaitingMs.set(memberId, 0);
  });

  let now = firstCheckIn;
  let completed = 0;

  console.log(`\n[timed dry run] targetCompletedMatches=${targetCompletedMatches}, duration=random 16-24m(avg~20m)`);

  while (completed < targetCompletedMatches) {
    const generated = generateMatches({
      meetingId,
      profiles,
      attendances,
      matches: localMatches,
      players: localPlayers,
      stats,
      availableCourts,
      now
    });

    generated.forEach((match) => {
      const ids = [...match.teamA, ...match.teamB];
      const matchId = `timed-dry-run-match-${localMatches.length + 1}`;
      const duration = randomDurationMinutes(random);
      const endAt = now + duration * 60000;
      const key = groupKey(ids);
      const previousCount = seenGroups.get(key) ?? 0;
      seenGroups.set(key, previousCount + 1);

      ids.forEach((memberId) => {
        const startedAt = waitStartedAt.get(memberId) ?? now;
        totalWaitingMs.set(memberId, (totalWaitingMs.get(memberId) ?? 0) + Math.max(0, now - startedAt));
        waitStartedAt.delete(memberId);
      });

      localMatches.push({
        id: matchId,
        meeting_id: meetingId,
        court_number: match.court_number,
        round_number: match.round_number,
        status: "in_progress",
        started_at: new Date(now).toISOString(),
        ended_at: null,
        team_a_score: null,
        team_b_score: null,
        winner_team: null,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      });

      localPlayers.push(
        ...match.teamA.map((memberId) => ({
          id: `timed-dry-run-player-${matchId}-${memberId}`,
          match_id: matchId,
          member_id: memberId,
          team: "A" as const,
          created_at: new Date(now).toISOString()
        })),
        ...match.teamB.map((memberId) => ({
          id: `timed-dry-run-player-${matchId}-${memberId}`,
          match_id: matchId,
          member_id: memberId,
          team: "B" as const,
          created_at: new Date(now).toISOString()
        }))
      );

      activeMatchIds.add(matchId);
      scheduledFinishes.push({ matchId, endAt });
      scheduledFinishes.sort((a, b) => a.endAt - b.endAt);

      console.log(
        `start ${formatClock(now)} court ${match.court_number} ${duration}m: A(${names(match.teamA, profileById)}) vs B(${names(match.teamB, profileById)})` +
          (previousCount > 0 ? ` [repeated group ${previousCount + 1}x]` : "")
      );
    });

    if (scheduledFinishes.length === 0) break;

    const finished = scheduledFinishes.shift();
    if (!finished) break;

    now = finished.endAt;
    const match = localMatches.find((row) => row.id === finished.matchId);
    if (!match || !activeMatchIds.has(finished.matchId)) continue;

    match.status = "finished";
    match.ended_at = new Date(now).toISOString();
    match.team_a_score = 6;
    match.team_b_score = 4;
    match.winner_team = "A";
    match.updated_at = new Date(now).toISOString();
    activeMatchIds.delete(finished.matchId);
    completed += 1;

    localPlayers
      .filter((player) => player.match_id === finished.matchId)
      .forEach((player) => {
        waitStartedAt.set(player.member_id, now);
      });

    console.log(`end   ${formatClock(now)} court ${match.court_number}: completed=${completed}/${targetCompletedMatches}`);
  }

  activeMembers.forEach((memberId) => {
    const startedAt = waitStartedAt.get(memberId);
    if (startedAt !== undefined) {
      totalWaitingMs.set(memberId, (totalWaitingMs.get(memberId) ?? 0) + Math.max(0, now - startedAt));
    }
  });

  console.log(`\n[member total waiting time] until ${formatClock(now)}`);
  [...activeMembers]
    .map((memberId) => ({
      name: profileById.get(memberId)?.display_name ?? "알 수 없음",
      minutes: minutesBetween(0, totalWaitingMs.get(memberId) ?? 0)
    }))
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, "ko"))
    .forEach((row) => {
      console.log(`${row.name}: ${row.minutes}m`);
    });
}

async function main() {
  loadEnv();

  const supabase = createClient(assertEnv("NEXT_PUBLIC_SUPABASE_URL"), assertEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  const meetingDate = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? todayKey();
  const [profilesResult, meetingsResult, attendancesResult, matchesResult, playersResult, courtsResult] = await Promise.all([
    supabase.from("profiles").select("*").order("display_name", { ascending: true }),
    supabase.from("meetings").select("*"),
    supabase.from("attendances").select("*"),
    supabase.from("matches").select("*"),
    supabase.from("match_players").select("*"),
    supabase.from("courts").select("*").order("court_number", { ascending: true })
  ]);

  for (const result of [profilesResult, meetingsResult, attendancesResult, matchesResult, playersResult, courtsResult]) {
    if (result.error) throw result.error;
  }

  const profiles = (profilesResult.data ?? []) as Profile[];
  const meetings = (meetingsResult.data ?? []) as Meeting[];
  const attendances = (attendancesResult.data ?? []) as Attendance[];
  const matches = (matchesResult.data ?? []) as Match[];
  const players = (playersResult.data ?? []) as MatchPlayer[];
  const courts = (courtsResult.data ?? []) as Court[];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const stats = buildStats(profiles, meetings, matches, players, "all");
  const availableCourts = courts.filter((court) => court.is_available).map((court) => court.court_number);
  const meeting = meetings.find((row) => row.meeting_date === meetingDate);
  const membersOnly = process.argv.includes("--members-only");
  const timed = process.argv.includes("--timed");
  const targetCompletedMatches = Number(process.argv.find((arg) => arg.startsWith("--matches="))?.split("=")[1] ?? 8);
  const regularMembers = profiles.filter((profile) => profile.display_name !== ADMIN_DISPLAY_NAME && (!membersOnly || !profile.is_guest));

  console.log(`meetingDate=${meetingDate}`);
  console.log(`mode=${membersOnly ? "members-only" : "members-and-guests"}`);
  console.log(`members=${regularMembers.length}, availableCourts=${availableCourts.join(", ") || "none"}`);

  if (meeting) {
    const todayAttendances = attendances.filter((attendance) => attendance.meeting_id === meeting.id);
    const generated = generateMatches({
      meetingId: meeting.id,
      profiles,
      attendances: todayAttendances,
      matches,
      players,
      stats,
      availableCourts
    });

    console.log(`\n[actual active attendance] active=${activeAttendance(todayAttendances).length}, generated=${generated.length}`);
    generated.forEach((match, index) => {
      console.log(
        `${index + 1}. court ${match.court_number}, round ${match.round_number}: A(${names(match.teamA, profileById)}) vs B(${names(match.teamB, profileById)}), balanceGap=${match.balanceGap.toFixed(2)}`
      );
    });
  } else {
    console.log("\n[actual active attendance] no meeting found for this date");
  }

  const syntheticMeetingId = meeting?.id ?? "dry-run-meeting";
  const synthetic = syntheticAttendances(syntheticMeetingId, regularMembers);
  const syntheticMatches = meeting ? matches : matches.filter((match) => match.meeting_id !== syntheticMeetingId);
  const generated = generateMatches({
    meetingId: syntheticMeetingId,
    profiles,
    attendances: synthetic,
    matches: syntheticMatches,
    players,
    stats,
    availableCourts
  });

  console.log(`\n[all current members simulated as checked in] active=${synthetic.length}, generated=${generated.length}`);
  generated.forEach((match, index) => {
    console.log(
      `${index + 1}. court ${match.court_number}, round ${match.round_number}: A(${names(match.teamA, profileById)}) vs B(${names(match.teamB, profileById)}), balanceGap=${match.balanceGap.toFixed(2)}`
    );
  });

  simulateRounds({
    meetingId: syntheticMeetingId,
    profiles,
    attendances: synthetic,
    matches: meeting ? matches : [],
    players: meeting ? players : [],
    stats,
    availableCourts,
    profileById,
    rounds: 4
  });

  if (timed) {
    simulateTimedRun({
      meetingId: syntheticMeetingId,
      profiles,
      attendances: synthetic,
      matches: meeting ? matches : [],
      players: meeting ? players : [],
      stats,
      availableCourts,
      profileById,
      targetCompletedMatches
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
