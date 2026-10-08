import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.mjs";
const { accumulatedWaitingMinutes, generateMatches, selectReplacement } = await import("../src/lib/scheduler.ts");
const at = (minute) => new Date(Date.UTC(2026, 8, 27, 6, minute)).toISOString();
function fixture(count = 4) {
  const profiles = Array.from({ length: count }, (_, i) => ({
    id: String(i), display_name: `Member ${i}`, gender: "male", is_guest: true, seed_win_rate: 0
  }));
  return {
    meetingId: "today", profiles, stats: new Map(), matches: [], players: [],
    attendances: profiles.map((profile, i) => ({
      id: `attendance-${i}`, member_id: profile.id, meeting_id: "today",
      checked_in_at: at(i), checked_out_at: null
    })),
    availableCourts: [1], now: new Date(at(60)).getTime()
  };
}
function addHistory(input, teamA, teamB, extra = {}) {
  const id = `match-${input.matches.length}`;
  input.matches.push({ id, meeting_id: "today", court_number: 1, round_number: input.matches.length + 1,
    status: "finished", started_at: at(10), ended_at: at(20), ...extra });
  for (const [team, members] of [["A", teamA], ["B", teamB]]) {
    input.players.push(...members.map((member_id) => ({ match_id: id, member_id, team })));
  }
}
const key = (match) => [match.teamA.slice().sort().join(","), match.teamB.slice().sort().join(",")].sort().join("|");
const members = (matches) => matches.flatMap((match) => [...match.teamA, ...match.teamB]);

test("re-entry uses the active session regardless of attendance order or other meetings", () => {
  const input = fixture(5);
  input.attendances[0].checked_in_at = at(59);
  const expected = generateMatches(input);
  assert.ok(!members(expected).includes("0"));
  const old = { ...input.attendances[0], id: "old", checked_in_at: at(-120), checked_out_at: at(30) };
  const other = { ...old, id: "other", meeting_id: "yesterday", checked_out_at: null };
  for (const attendances of [[old, other, ...input.attendances], [...input.attendances, old, other]]) {
    assert.deepEqual(generateMatches({ ...input, attendances }), expected);
  }
});

test("returned members can play, checked-out and occupied members cannot", () => {
  const input = fixture();
  input.attendances.unshift({ ...input.attendances[0], id: "old", checked_out_at: at(5) });
  assert.equal(members(generateMatches(input)).filter((id) => id === "0").length, 1);
  input.attendances.at(-1).checked_out_at = at(30);
  assert.deepEqual(generateMatches(input), []);
  input.attendances.at(-1).checked_out_at = null;
  addHistory(input, ["0", "1"], ["2", "3"], { status: "in_progress" });
  input.availableCourts = [1, 2];
  assert.deepEqual(generateMatches(input), []);
});

test("duplicate active attendance cannot assign a member twice or invent a fourth player", () => {
  const input = fixture(3);
  input.attendances.push({ ...input.attendances[0], id: "duplicate", checked_in_at: at(50) });
  assert.deepEqual(generateMatches(input), []);
});

test("all three pairings are used before repeating despite unequal win rates", () => {
  const input = fixture();
  input.profiles.forEach((profile, i) => { profile.seed_win_rate = [100, 0, 70, 30][i]; });
  const seen = new Set();
  for (let round = 0; round < 3; round++) {
    const [match] = generateMatches(input);
    assert.ok(!seen.has(key(match)));
    seen.add(key(match));
    addHistory(input, match.teamB.slice().reverse(), match.teamA.slice().reverse());
  }
  assert.equal(generateMatches(input).length, 1, "exhausted combinations must not stop scheduling");
});

test("mixed doubles rotate the two mixed pairings before reuse", () => {
  const input = fixture();
  input.profiles.forEach((profile, i) => {
    profile.gender = i < 2 ? "male" : "female";
    profile.seed_win_rate = [100, 0, 100, 0][i];
  });
  const seen = new Set();
  for (let round = 0; round < 4; round++) {
    const [match] = generateMatches(input);
    for (const team of [match.teamA, match.teamB]) {
      assert.equal(new Set(team.map((id) => input.profiles[Number(id)].gender)).size, 2);
    }
    if (round < 2) assert.ok(!seen.has(key(match)));
    seen.add(key(match));
    addHistory(input, match.teamA, match.teamB);
  }
  assert.equal(seen.size, 2);
});

test("re-entry preserves daily game counts and uses the latest check-in for the early bonus", () => {
  const input = fixture(8);
  for (let round = 0; round < 3; round++) {
    addHistory(input, ["0", "1"], ["2", "3"]);
    addHistory(input, ["4", "5"], ["6", "7"]);
  }
  input.attendances[0].checked_in_at = at(59);
  input.attendances.push({ ...input.attendances[0], id: "old", checked_in_at: at(-60), checked_out_at: at(30) });
  assert.equal(members(generateMatches(input)).length, 4);
  assert.ok(!members(generateMatches(input)).includes("0"));
});

test("multiple courts use distinct players and only unoccupied available courts", () => {
  const input = fixture(12);
  addHistory(input, ["0", "1"], ["2", "3"], { status: "scheduled" });
  input.availableCourts = [1, 2, 3];
  const matches = generateMatches(input);
  assert.deepEqual(matches.map((match) => match.court_number), [2, 3]);
  assert.equal(new Set(members(matches)).size, 8);
  assert.ok(members(matches).every((id) => Number(id) >= 4));
});

function vacancyFixture(count = 6) {
  const input = fixture(count);
  addHistory(input, ["0", "1"], ["2", "3"], { status: "in_progress", ended_at: null });
  return { ...input, matchId: "match-0", departingMemberId: "0" };
}

test("replacement selects a waiting member, preserving the existing seats", () => {
  const input = vacancyFixture();
  const original = structuredClone(input.players);
  assert.equal(selectReplacement(input), "4");
  assert.deepEqual(input.players, original);
  input.attendances[4].checked_out_at = at(40);
  assert.equal(selectReplacement(input), "5");
  input.attendances[5].checked_out_at = at(40);
  assert.equal(selectReplacement(input), null);
});

test("replacement excludes members in other scheduled or active matches", () => {
  const input = vacancyFixture(10);
  addHistory(input, ["4", "5"], ["6", "7"], { status: "scheduled", ended_at: null, court_number: 2 });
  assert.equal(selectReplacement(input), "8");
});

test("replacement prioritizes fewer daily games and latest re-entry time", () => {
  const input = vacancyFixture(7);
  addHistory(input, ["4", "outside-1"], ["outside-2", "outside-3"]);
  assert.equal(selectReplacement(input), "5");
  input.attendances[5].checked_in_at = at(59);
  input.attendances.push({ ...input.attendances[5], checked_in_at: at(-100), checked_out_at: at(20) });
  assert.equal(selectReplacement(input), "6");
});

test("replacement never lets an early arrival get more than one game ahead", () => {
  const input = vacancyFixture();
  for (let i = 0; i < 4; i++) addHistory(input, ["4", "x"], ["y", "z"]);
  for (let i = 0; i < 3; i++) addHistory(input, ["5", "x"], ["y", "z"]);
  assert.equal(selectReplacement(input), "5");
});

test("early arrivals can be one game ahead, but not two", () => {
  const input = fixture(8);
  input.attendances.forEach((attendance, i) => { attendance.checked_in_at = at(i < 4 ? i : 30 + i - 4); });
  for (let i = 0; i < 4; i++) addHistory(input, [String(i), `outside-a-${i}`], [`outside-b-${i}`, `outside-c-${i}`]);
  assert.deepEqual(members(generateMatches(input)).sort(), ["0", "1", "2", "3"]);
  addHistory(input, ["0", "outside-d"], ["outside-e", "outside-f"]);
  assert.ok(!members(generateMatches(input)).includes("0"));
});

test("the 30-minute cutoff is exact and applies after three games", () => {
  const input = fixture(5);
  input.attendances.forEach((attendance, i) => { attendance.checked_in_at = at(i === 4 ? 30 : i); });
  for (let i = 0; i < 5; i++) {
    for (let round = 0; round < (i === 4 ? 3 : 4); round++) {
      addHistory(input, [String(i), `outside-a-${i}-${round}`], [`outside-b-${i}-${round}`, `outside-c-${i}-${round}`]);
    }
  }
  assert.deepEqual(members(generateMatches(input)).sort(), ["0", "1", "2", "3"]);
  input.attendances[4].checked_in_at = at(29);
  assert.ok(members(generateMatches(input)).includes("4"));
});

test("replacement breaks attendance ties using the fixed teams' mixed doubles fit", () => {
  const input = vacancyFixture();
  input.attendances[5].checked_in_at = input.attendances[4].checked_in_at;
  input.profiles[3].gender = "female";
  input.profiles[5].gender = "female";
  assert.equal(selectReplacement(input), "5");
});

test("vacancies can be filled later without freeing the remaining participants", () => {
  const input = vacancyFixture();
  input.players = input.players.filter((row) => row.member_id !== "0");
  input.attendances[0].checked_out_at = at(40);
  delete input.departingMemberId;
  input.vacantTeam = "A";
  assert.equal(selectReplacement(input), "4");
  assert.equal(selectReplacement({ ...input, vacantTeam: "B" }), null);
  assert.deepEqual(generateMatches({ ...input, availableCourts: [1, 2] }), []);
  input.players = input.players.filter((row) => row.member_id !== "1");
  input.attendances[1].checked_out_at = at(40);
  assert.equal(selectReplacement(input), "4", "multiple missing seats remain fillable");
});

test("ended matches cannot have their participants replaced", () => {
  const input = vacancyFixture();
  input.matches[0].ended_at = at(50);
  assert.equal(selectReplacement(input), null);
});

test("waiting time starts at the first completed match and accumulates between later games", () => {
  const input = fixture();
  addHistory(input, ["0", "outside-1"], ["outside-2", "outside-3"], {
    started_at: at(10), ended_at: at(20)
  });
  addHistory(input, ["0", "outside-4"], ["outside-5", "outside-6"], {
    started_at: at(30), ended_at: at(40)
  });
  const attendance = input.attendances[0];
  assert.equal(accumulatedWaitingMinutes("0", attendance, input.matches, input.players, "today", new Date(at(60)).getTime()), 30);
  assert.equal(accumulatedWaitingMinutes("0", attendance, input.matches, input.players, "today", new Date(at(75)).getTime()), 45);

  const reentered = { ...attendance, checked_in_at: at(50) };
  assert.equal(accumulatedWaitingMinutes("0", reentered, input.matches, input.players, "today", new Date(at(60)).getTime()), 10);
});

test("replacement recalculates accumulated waiting from each candidate's completed games", () => {
  const input = vacancyFixture();
  input.attendances[4].checked_in_at = at(31);
  input.attendances[5].checked_in_at = at(30);
  addHistory(input, ["4", "outside-1"], ["outside-2", "outside-3"], {
    started_at: at(31), ended_at: at(32)
  });
  addHistory(input, ["5", "outside-4"], ["outside-5", "outside-6"], {
    started_at: at(50), ended_at: at(51)
  });

  assert.equal(selectReplacement(input), "4", "28 minutes currently waiting beats 9 minutes");
  input.matches[1].ended_at = at(59);
  assert.equal(selectReplacement(input), "5", "a newly completed game resets current waiting time");
});
