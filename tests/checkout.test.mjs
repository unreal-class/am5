import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import "./register-typescript.mjs";

const { autoAssignMatches, checkoutMemberAndReassign } = await import("../src/lib/server-matchmaker.ts");
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const migration = readFileSync(new URL("../supabase/migrations/202609270001_preserve_match_on_checkout.sql", import.meta.url), "utf8");
const reconfigureMigration = readFileSync(new URL("../supabase/migrations/202609270002_reconfigure_match_teams.sql", import.meta.url), "utf8");

// Exercise the actual server orchestration and migration against PostgreSQL.
// This adapter implements only the Supabase query interface used by this module.
function client(db) {
  return {
    async rpc(name, args) {
      try {
        const params = Object.keys(args).map((key, i) => `${key} => $${i + 1}`).join(", ");
        const result = await db.query(`select public.${name}(${params}) as data`, Object.values(args));
        return { data: result.rows[0].data, error: null };
      } catch (error) { return { data: null, error }; }
    },
    from(table) {
      let columns = "*", single = false, inserted;
      const filters = [], values = [], ordering = [];
      const bind = (value) => { values.push(value); return `$${values.length}`; };
      const query = {
        select(value = "*") { columns = value; return query; },
        eq(key, value) { filters.push(`${key} = ${bind(value)}`); return query; },
        in(key, list) { filters.push(`${key} in (${list.map(bind).join(",")})`); return query; },
        order(key, options) { ordering.push(`${key} ${options.ascending ? "asc" : "desc"}`); return query; },
        insert(rows) { inserted = Array.isArray(rows) ? rows : [rows]; return query; },
        single() { single = true; return query; },
        async then(resolve, reject) {
          try {
            let sql;
            if (inserted) {
              const keys = Object.keys(inserted[0]);
              sql = `insert into ${table} (${keys.join(",")}) values ${inserted.map((row) => `(${keys.map((key) => bind(row[key])).join(",")})`).join(",")} returning ${columns}`;
            } else {
              sql = `select ${columns} from ${table}${filters.length ? ` where ${filters.join(" and ")}` : ""}${ordering.length ? ` order by ${ordering.join(",")}` : ""}`;
            }
            const result = await db.query(sql, values);
            // PostgREST serializes PostgreSQL timestamps as JSON strings.
            const rows = JSON.parse(JSON.stringify(result.rows));
            return resolve({ data: single ? rows[0] : rows, error: null });
          } catch (error) { return resolve({ data: null, error }); }
        }
      };
      return query;
    }
  };
}

async function setup(t, memberCount = 5) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table profiles (id uuid primary key, display_name text, gender text default 'male', is_guest boolean default true, seed_win_rate float default 50);
    create table meetings (id uuid primary key, meeting_date date default current_date);
    create table attendances (id uuid primary key default gen_random_uuid(), meeting_id uuid, member_id uuid, checked_in_at timestamptz default now(), checked_out_at timestamptz);
    create table courts (court_number integer primary key, is_available boolean default true);
    create table matches (id uuid primary key default gen_random_uuid(), meeting_id uuid, court_number integer, round_number integer, status text,
      started_at timestamptz, ended_at timestamptz, team_a_score integer, team_b_score integer, winner_team text);
    create table match_players (id uuid primary key default gen_random_uuid(), match_id uuid references matches(id) on delete cascade,
      member_id uuid references profiles(id), team text check (team in ('A', 'B')), created_at timestamptz default now(), unique(match_id, member_id));
    insert into meetings(id) values ('${uuid(100)}');
    insert into courts(court_number) values (1), (2);
    insert into matches(id, meeting_id, court_number, round_number, status, started_at)
      values ('${uuid(200)}', '${uuid(100)}', 1, 1, 'in_progress', now() - interval '30 minutes');
  `);
  await db.exec(migration);
  await db.exec(reconfigureMigration);
  for (let i = 1; i <= memberCount; i++) {
    await db.query("insert into profiles(id, display_name) values ($1, $2)", [uuid(i), `Member ${i}`]);
    await db.query("insert into attendances(meeting_id, member_id, checked_in_at) values ($1, $2, now() - interval '1 hour' + $3 * interval '1 minute')", [uuid(100), uuid(i), i]);
    if (i <= 4) await db.query("insert into match_players(match_id, member_id, team) values ($1, $2, $3)", [uuid(200), uuid(i), i <= 2 ? "A" : "B"]);
  }
  const admin = client(db);
  return {
    db, admin,
    checkout: (member = 1, confirmed = true) => checkoutMemberAndReassign({
      admin, meetingId: uuid(100), memberId: uuid(member), currentUserId: uuid(member), confirmReplaceActiveMatch: confirmed
    }),
    assign: () => autoAssignMatches({ admin, meetingId: uuid(100), currentUserId: uuid(1) }),
    roster: async () => (await db.query("select * from match_players where match_id = $1 order by member_id", [uuid(200)])).rows
  };
}

test("checkout replaces only the departing seat and preserves match, other rows, and team", async (t) => {
  const { db, checkout, roster } = await setup(t);
  const beforeMatch = (await db.query("select * from matches")).rows;
  const beforePlayers = await roster();
  const result = await checkout();
  assert.equal(result.waitingMatchCount, 0);
  assert.equal(result.assignmentWarning, null);
  const after = await roster();
  assert.deepEqual(after.filter((row) => row.member_id !== uuid(5)), beforePlayers.filter((row) => row.member_id !== uuid(1)));
  assert.equal(after.find((row) => row.member_id === uuid(5)).team, "A");
  assert.deepEqual((await db.query("select * from matches")).rows, beforeMatch);
  assert.ok((await db.query("select checked_out_at from attendances where member_id = $1", [uuid(1)])).rows[0].checked_out_at);
});

test("without a substitute, checkout preserves three players; later arrival fills that same match first", async (t) => {
  const { db, checkout, roster, assign } = await setup(t, 4);
  const result = await checkout();
  assert.equal(result.waitingMatchCount, 1);
  assert.equal((await roster()).length, 3);
  await assert.rejects(db.query("update matches set ended_at = now() where id = $1", [uuid(200)]), /충원 대기/);
  await assert.rejects(db.query("update matches set status = 'finished' where id = $1", [uuid(200)]), /충원 대기/);
  for (let i = 5; i <= 8; i++) {
    await db.query("insert into profiles(id, display_name) values ($1, $2)", [uuid(i), `Member ${i}`]);
    await db.query("insert into attendances(meeting_id, member_id, checked_in_at) values ($1, $2, now() + $3 * interval '1 minute')", [uuid(100), uuid(i), i]);
  }
  await assign();
  assert.equal((await roster()).find((row) => row.member_id === uuid(5)).team, "A");
  assert.equal((await db.query("select * from matches")).rows.length, 1, "vacancy gets a player before a new four-person match");
  await db.query("update matches set ended_at = now() where id = $1", [uuid(200)]);
});

test("repeated departures retain the other seats and multiple vacancies remain fillable", async (t) => {
  const { db, checkout, roster, assign } = await setup(t, 4);
  await checkout(1);
  await checkout(2);
  assert.deepEqual((await roster()).map((row) => row.member_id), [uuid(3), uuid(4)]);
  for (let i = 5; i <= 6; i++) {
    await db.query("insert into profiles(id, display_name) values ($1, $2)", [uuid(i), `Member ${i}`]);
    await db.query("insert into attendances(meeting_id, member_id) values ($1, $2)", [uuid(100), uuid(i)]);
  }
  await assign();
  assert.deepEqual((await roster()).filter((row) => row.team === "A").map((row) => row.member_id), [uuid(5), uuid(6)]);
});

test("checkout without confirmation changes neither attendance nor match roster", async (t) => {
  const { db, checkout, roster } = await setup(t);
  const before = await roster();
  await assert.rejects(checkout(1, false), /대체 선수/);
  assert.deepEqual(await roster(), before);
  assert.equal((await db.query("select checked_out_at from attendances where member_id = $1", [uuid(1)])).rows[0].checked_out_at, null);
});

test("fill RPC rejects occupied players, checked-out players and filled teams", async (t) => {
  const { db, admin } = await setup(t, 6);
  await db.query("delete from match_players where member_id = $1", [uuid(1)]);
  const fill = (member, team = "A") => admin.rpc("fill_match_vacancy", { p_match_id: uuid(200), p_member_id: uuid(member), p_team: team });
  assert.match((await fill(2)).error.message, /이미 다른 경기/);
  await db.query("update attendances set checked_out_at = now() where member_id = $1", [uuid(5)]);
  assert.match((await fill(5)).error.message, /출석 중인 대체/);
  assert.match((await fill(6, "B")).error.message, /이미 충원/);
  assert.equal((await fill(6)).error, null);
  assert.match((await fill(1)).error.message, /이미 충원/);
  assert.equal((await db.query("select count(*) from match_players")).rows[0].count, 4);
});

test("checkout preserves ended participants awaiting result entry", async (t) => {
  const { db, checkout, roster } = await setup(t, 4);
  await db.query("update matches set ended_at = now() where id = $1", [uuid(200)]);
  const before = await roster();
  await checkout(1, false);
  assert.deepEqual(await roster(), before);
});

test("RPC permissions permit service role and deny direct authenticated calls", async (t) => {
  const { db } = await setup(t);
  const { rows } = await db.query(`select
    has_function_privilege('authenticated', 'checkout_member_preserving_matches(uuid,uuid,boolean)', 'EXECUTE') as user_checkout,
    has_function_privilege('anon', 'fill_match_vacancy(uuid,uuid,text)', 'EXECUTE') as anon_fill,
    has_function_privilege('service_role', 'fill_match_vacancy(uuid,uuid,text)', 'EXECUTE') as server_fill,
    has_function_privilege('authenticated', 'reconfigure_match_teams(uuid)', 'EXECUTE') as user_reconfigure,
    has_function_privilege('service_role', 'reconfigure_match_teams(uuid)', 'EXECUTE') as server_reconfigure`);
  assert.deepEqual(rows[0], {
    user_checkout: false, anon_fill: false, server_fill: true,
    user_reconfigure: false, server_reconfigure: true
  });
});

test("attendance write failure rolls back removal of the departing seat", async (t) => {
  const { db, checkout, roster } = await setup(t);
  const before = await roster();
  await db.exec(`create function fail_attendance_update() returns trigger language plpgsql as $$
    begin raise exception 'simulated attendance failure'; end; $$;
    create trigger fail_attendance before update on attendances for each row execute function fail_attendance_update();`);
  await assert.rejects(checkout(), /simulated attendance failure/);
  assert.deepEqual(await roster(), before);
  assert.equal((await db.query("select checked_out_at from attendances where member_id = $1", [uuid(1)])).rows[0].checked_out_at, null);
});

test("failed filling leaves a completed checkout and intact waiting roster", async (t) => {
  const { db, admin, roster } = await setup(t);
  const rpc = admin.rpc;
  admin.rpc = (name, args) => name === "fill_match_vacancy"
    ? Promise.resolve({ data: null, error: new Error("simulated filling failure") }) : rpc(name, args);
  const result = await checkoutMemberAndReassign({
    admin, meetingId: uuid(100), memberId: uuid(1), currentUserId: uuid(1), confirmReplaceActiveMatch: true
  });
  assert.equal(result.waitingMatchCount, 1);
  assert.match(result.assignmentWarning, /simulated filling failure/);
  assert.deepEqual((await roster()).map((row) => row.member_id), [uuid(2), uuid(3), uuid(4)]);
  assert.ok((await db.query("select checked_out_at from attendances where member_id = $1", [uuid(1)])).rows[0].checked_out_at);
});

test("scheduled matches preserve their status and fixed teams during replacement", async (t) => {
  const { db, checkout, roster } = await setup(t);
  await db.query("update matches set status = 'scheduled', started_at = null where id = $1", [uuid(200)]);
  await checkout(3);
  assert.equal((await roster()).find((row) => row.member_id === uuid(5)).team, "B");
  const { rows } = await db.query("select status, started_at from matches where id = $1", [uuid(200)]);
  assert.deepEqual(rows[0], { status: "scheduled", started_at: null });
});

function pairingKey(rows) {
  const teams = ["A", "B"].map((team) => rows.filter((row) => row.team === team)
    .map((row) => row.member_id).sort().join(","));
  return teams.sort().join("|");
}

test("team reconfiguration cycles all three pairings and returns to the original", async (t) => {
  const { admin, roster } = await setup(t, 4);
  const original = pairingKey(await roster());
  const seen = new Set([original]);
  for (let press = 0; press < 3; press++) {
    const result = await admin.rpc("reconfigure_match_teams", { p_match_id: uuid(200) });
    assert.equal(result.error, null);
    const current = pairingKey(await roster());
    if (press < 2) assert.ok(!seen.has(current), "each of the first three choices must be distinct");
    seen.add(current);
  }
  assert.equal(seen.size, 3);
  assert.equal(pairingKey(await roster()), original);
});

test("team reconfiguration preserves the match and all four participant rows", async (t) => {
  const { db, admin, roster } = await setup(t, 4);
  const matchBefore = (await db.query("select * from matches where id = $1", [uuid(200)])).rows[0];
  const playersBefore = await roster();
  await admin.rpc("reconfigure_match_teams", { p_match_id: uuid(200) });
  const playersAfter = await roster();
  assert.deepEqual((await db.query("select * from matches where id = $1", [uuid(200)])).rows[0], matchBefore);
  assert.deepEqual(playersAfter.map((row) => ({ ...row, team: undefined })), playersBefore.map((row) => ({ ...row, team: undefined })));
});

test("team reconfiguration rejects an incomplete, ended, or scored match", async (t) => {
  const { db, admin } = await setup(t, 4);
  const reconfigure = () => admin.rpc("reconfigure_match_teams", { p_match_id: uuid(200) });
  await db.query("delete from match_players where member_id = $1", [uuid(1)]);
  assert.match((await reconfigure()).error.message, /참여자 4명/);
  await db.query("insert into match_players(match_id, member_id, team) values ($1, $2, 'A')", [uuid(200), uuid(1)]);
  await db.query("update matches set ended_at = now() where id = $1", [uuid(200)]);
  assert.match((await reconfigure()).error.message, /진행 전이거나 진행 중/);
  await db.query("update matches set ended_at = null, team_a_score = 6, team_b_score = 4 where id = $1", [uuid(200)]);
  assert.match((await reconfigure()).error.message, /진행 전이거나 진행 중/);
});
