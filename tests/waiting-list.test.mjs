import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.mjs";
const { buildWaitingMemberRows } = await import("../src/lib/waiting-list.ts");

const at = (minute) => new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString();

test("waiting list shows every available member with games and live waiting time", () => {
  const profiles = [
    { id: "kim", display_name: "김민우", gender: "male", is_guest: false, seed_win_rate: 0 },
    { id: "park", display_name: "박준서", gender: "male", is_guest: false, seed_win_rate: 0 },
    { id: "lee", display_name: "이지훈", gender: "male", is_guest: false, seed_win_rate: 0 },
    { id: "playing", display_name: "경기중", gender: "male", is_guest: false, seed_win_rate: 0 }
  ];
  const attendances = profiles.map((profile, index) => ({
    id: `attendance-${profile.id}`,
    member_id: profile.id,
    meeting_id: "today",
    checked_in_at: at(index * 5),
    checked_out_at: null
  }));

  const rows = buildWaitingMemberRows({
    profiles,
    attendances,
    matches: [],
    players: [],
    meetingId: "today",
    activeMatchMemberIds: new Set(["playing"]),
    todayGameCountByMemberId: new Map([["kim", 1], ["park", 0], ["lee", 0]]),
    now: new Date(at(40)).getTime()
  });

  assert.deepEqual(rows.map(({ name, games, waitingMinutes }) => ({ name, games, waitingMinutes })), [
    { name: "박준서", games: 0, waitingMinutes: 35 },
    { name: "이지훈", games: 0, waitingMinutes: 30 },
    { name: "김민우", games: 1, waitingMinutes: 40 }
  ]);
});
