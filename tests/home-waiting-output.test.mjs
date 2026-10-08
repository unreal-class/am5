import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.mjs";
const { buildWaitingMemberRows } = await import("../src/lib/waiting-list.ts");
const { generateMatches } = await import("../src/lib/scheduler.ts");

const at = (minute) => new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString();
const now = new Date(at(40)).getTime();

function scenario() {
  const profiles = [
    { id: "kim", display_name: "김민우", gender: "male", is_guest: false, seed_win_rate: 0 },
    { id: "park", display_name: "박준서", gender: "male", is_guest: false, seed_win_rate: 0 },
    { id: "lee", display_name: "이지훈", gender: "male", is_guest: false, seed_win_rate: 0 },
    { id: "choi", display_name: "최서연", gender: "female", is_guest: false, seed_win_rate: 0 },
    { id: "jung", display_name: "정하늘", gender: "female", is_guest: false, seed_win_rate: 0 },
    { id: "playing", display_name: "경기중인원", gender: "male", is_guest: false, seed_win_rate: 0 }
  ];
  const attendances = profiles.map((profile, index) => ({
    id: `attendance-${profile.id}`,
    member_id: profile.id,
    meeting_id: "today",
    checked_in_at: at(index * 5),
    checked_out_at: null
  }));
  return { profiles, attendances };
}

function homeGuide({ waitingPresentCount, availableCourtsNowCount, hasInProgressMatch }) {
  if (hasInProgressMatch) return "현재 모든 코트에서 경기 중입니다";
  if (waitingPresentCount < 4) return `아직 ${4 - waitingPresentCount}명이 부족해 경기를 배정할 수 없습니다. 빨리 오라고 독촉하세요!!`;
  if (availableCourtsNowCount === 0) return "현재 모든 코트에서 경기 중입니다";
  return null;
}

test("home waiting screen example output", () => {
  const { profiles, attendances } = scenario();
  const todayGameCountByMemberId = new Map([
    ["kim", 2],
    ["park", 1],
    ["lee", 0],
    ["choi", 0],
    ["jung", 1]
  ]);
  const activeMatchMemberIds = new Set(["playing"]);

  const rows = buildWaitingMemberRows({
    profiles,
    attendances,
    matches: [],
    players: [],
    meetingId: "today",
    activeMatchMemberIds,
    todayGameCountByMemberId,
    now
  });

  const waitingPresentCount = rows.length;
  const availableCourtsNowCount = 2;
  const guide = homeGuide({ waitingPresentCount, availableCourtsNowCount, hasInProgressMatch: false });

  console.log("\n[홈 화면 - 대기 중 출력 예시]");
  console.log("대기 중입니다");
  if (guide) console.log(guide);
  console.log(`대기 인원 ${waitingPresentCount}명 | 가용 코트 ${availableCourtsNowCount}면`);
  console.log(`현재 대기자            ${rows.length}명`);
  rows.forEach((row, index) => {
    const mine = row.memberId === "lee" ? " (나)" : "";
    console.log(
      `  ${index + 1}. ${row.name}${mine}  경기수 ${row.games}경기  대기시간 ${row.waitingMinutes}분`
    );
  });

  assert.deepEqual(
    rows.map(({ name, games, waitingMinutes }) => ({ name, games, waitingMinutes })),
    [
      { name: "이지훈", games: 0, waitingMinutes: 30 },
      { name: "최서연", games: 0, waitingMinutes: 25 },
      { name: "박준서", games: 1, waitingMinutes: 35 },
      { name: "정하늘", games: 1, waitingMinutes: 20 },
      { name: "김민우", games: 2, waitingMinutes: 40 }
    ]
  );
  assert.equal(waitingPresentCount, 5);
  assert.equal(guide, null);
});

test("home waiting screen asks for more members when fewer than four are waiting", () => {
  const { profiles, attendances } = scenario();
  const rows = buildWaitingMemberRows({
    profiles,
    attendances: attendances.filter((attendance) => ["kim", "park", "lee"].includes(attendance.member_id)),
    matches: [],
    players: [],
    meetingId: "today",
    activeMatchMemberIds: new Set(["playing"]),
    todayGameCountByMemberId: new Map(),
    now
  });

  const guide = homeGuide({
    waitingPresentCount: rows.length,
    availableCourtsNowCount: 3,
    hasInProgressMatch: false
  });

  console.log("\n[홈 화면 - 인원 부족 출력 예시]");
  console.log("대기 중입니다");
  console.log(guide);
  console.log(`대기 인원 ${rows.length}명 | 가용 코트 3면`);

  assert.equal(guide, "아직 1명이 부족해 경기를 배정할 수 없습니다. 빨리 오라고 독촉하세요!!");
});

test("home waiting screen feeds the queue into court assignment", () => {
  const { profiles, attendances } = scenario();
  const input = {
    meetingId: "today",
    profiles,
    attendances,
    matches: [],
    players: [],
    stats: new Map(),
    availableCourts: [1, 2],
    now
  };
  const generated = generateMatches(input);

  console.log("\n[대기열 → 코트 배정 출력 예시]");
  generated.forEach((match, index) => {
    const names = (ids) => ids.map((id) => profiles.find((profile) => profile.id === id).display_name).join(", ");
    console.log(
      `  ${index + 1}. court ${match.court_number}, round ${match.round_number}: ` +
        `A(${names(match.teamA)}) vs B(${names(match.teamB)}), balanceGap=${match.balanceGap.toFixed(2)}`
    );
  });

  assert.equal(generated.length, 1);
  assert.equal(generated[0].court_number, 1);
  assert.equal([...generated[0].teamA, ...generated[0].teamB].length, 4);
});
