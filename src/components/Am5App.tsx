"use client";

import {
  Activity,
  CalendarPlus,
  CheckCircle2,
  ClipboardList,
  DoorOpen,
  Home,
  KeyRound,
  ListChecks,
  LogOut,
  Medal,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  SquarePen,
  StopCircle,
  Trash2,
  Trophy,
  User,
  UserPlus,
  Users
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { loginIdToEmail, normalizeLoginId } from "@/lib/auth-id";
import {
  currentMonthKey,
  currentYearKey,
  elapsedMinutes,
  formatDate,
  formatRate,
  formatTime,
  todayKey
} from "@/lib/date";
import {
  DEFAULT_COURTS,
  DEFAULT_PASSWORD,
  courtName,
  type Attendance,
  type Court,
  type Gender,
  type Match,
  type MatchPlayer,
  type Meeting,
  type Profile,
  type RankingScope,
  type Role,
  type Team
} from "@/lib/models";
import { generateMatches } from "@/lib/scheduler";
import { buildStats, getRankings } from "@/lib/stats";
import { hasSupabaseConfig, supabase } from "@/lib/supabase";

type Tab = "today" | "draw" | "results" | "ranking" | "me" | "admin" | "members" | "monitor" | "test" | "courts";
type Draft = Pick<Profile, "display_name" | "phone" | "gender" | "role" | "seed_win_rate">;
type TestMatchStatus = "scheduled" | "in_progress" | "awaiting_result" | "finished";
type TestUser = {
  id: string;
  name: string;
  gender: Gender;
  present: boolean;
  enteredAt: string | null;
  leftAt: string | null;
  games: number;
  wins: number;
  losses: number;
  seedRate: number;
};

type TestMatch = {
  id: string;
  courtNumber: number;
  status: TestMatchStatus;
  teamA: string[];
  teamB: string[];
  assignedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  teamAScore: number | null;
  teamBScore: number | null;
  winnerTeam: Team | null;
};

type TestCourt = {
  courtNumber: number;
  match: TestMatch | null;
};

const genderLabels: Record<Gender, string> = {
  male: "남성",
  female: "여성",
  other: "기타"
};

const roleLabels: Record<Role, string> = {
  member: "회원",
  admin: "관리자"
};

const scopeLabels: Record<RankingScope, string> = {
  all: "전체",
  month: "월간",
  year: "연간"
};

const TEST_COURTS = [1, 2, 3];
const TEST_NAMES = [
  "테스트 김민준",
  "테스트 이서연",
  "테스트 박지훈",
  "테스트 최하은",
  "테스트 정우진",
  "테스트 한소윤",
  "테스트 강도윤",
  "테스트 윤지아",
  "테스트 오현우",
  "테스트 임나연",
  "테스트 서준호",
  "테스트 문채원"
];

function classNames(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

function winnerLabel(winner: Team | null) {
  if (!winner) return "-";
  return winner === "A" ? "A팀" : "B팀";
}

function statusLabel(status: Match["status"]) {
  if (status === "scheduled") return "예정";
  if (status === "in_progress") return "진행 중";
  return "종료";
}

function matchDisplayStatus(match: Match) {
  if (match.status === "finished" && match.winner_team) return "종료";
  if (match.ended_at && !match.winner_team) return "결과 입력";
  return statusLabel(match.status);
}

function testMatchStatusLabel(status: TestMatchStatus) {
  if (status === "scheduled") return "배정됨";
  if (status === "in_progress") return "진행 중";
  if (status === "awaiting_result") return "결과 입력";
  return "종료";
}

function testUserRate(user: TestUser) {
  return user.games > 0 ? (user.wins / user.games) * 100 : user.seedRate;
}

function testCombinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [head, ...tail] = items;
  return [
    ...testCombinations(tail, size - 1).map((group) => [head, ...group]),
    ...testCombinations(tail, size)
  ];
}

function testTeamAverage(team: TestUser[]) {
  return team.reduce((sum, user) => sum + testUserRate(user), 0) / team.length;
}

function testIsMixed(team: TestUser[]) {
  return team.some((user) => user.gender === "female") && team.some((user) => user.gender === "male");
}

function makeTempUsers(startIndex: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const offset = startIndex + index;
    const name = TEST_NAMES[offset % TEST_NAMES.length];
    const number = offset + 1;

    return {
      id: `temp-${number}`,
      name: `${name} ${number}`,
      gender: offset % 2 === 0 ? "male" : "female",
      present: false,
      enteredAt: null,
      leftAt: null,
      games: 0,
      wins: 0,
      losses: 0,
      seedRate: 35 + ((offset * 7) % 45)
    } satisfies TestUser;
  });
}

function TestConsole({ showToast }: { showToast: (message: string) => void }) {
  const [testUsers, setTestUsers] = useState<TestUser[]>(() => makeTempUsers(0, 8));
  const [testCourts, setTestCourts] = useState<TestCourt[]>(() => TEST_COURTS.map((courtNumber) => ({ courtNumber, match: null })));
  const [matchSeq, setMatchSeq] = useState(1);
  const [scores, setScores] = useState<Record<string, { a: string; b: string }>>({});

  const userById = useMemo(() => new Map(testUsers.map((user) => [user.id, user])), [testUsers]);
  const activePlayerIds = useMemo(() => {
    const ids = new Set<string>();
    testCourts.forEach((court) => {
      if (!court.match || court.match.status === "finished") return;
      [...court.match.teamA, ...court.match.teamB].forEach((id) => ids.add(id));
    });
    return ids;
  }, [testCourts]);
  const presentCount = testUsers.filter((user) => user.present).length;
  const availableCount = testUsers.filter((user) => user.present && !activePlayerIds.has(user.id)).length;

  function names(ids: string[]) {
    return ids.map((id) => userById.get(id)?.name ?? "알 수 없음").join(" · ");
  }

  function addTempUsers(count: number) {
    setTestUsers((users) => [...users, ...makeTempUsers(users.length, count)]);
    showToast(`임시 사용자 ${count}명을 추가했습니다.`);
  }

  function setAllPresent() {
    const now = new Date().toISOString();
    setTestUsers((users) =>
      users.map((user) => ({
        ...user,
        present: true,
        enteredAt: user.enteredAt ?? now,
        leftAt: null
      }))
    );
    showToast("모든 임시 사용자를 입장 처리했습니다.");
  }

  function togglePresence(userId: string) {
    if (activePlayerIds.has(userId)) {
      showToast("경기 중인 사용자는 퇴장 처리할 수 없습니다.");
      return;
    }

    const now = new Date().toISOString();
    setTestUsers((users) =>
      users.map((user) => {
        if (user.id !== userId) return user;
        return {
          ...user,
          present: !user.present,
          enteredAt: user.present ? user.enteredAt : now,
          leftAt: user.present ? now : null
        };
      })
    );
  }

  function clearTest() {
    setTestUsers(makeTempUsers(0, 8));
    setTestCourts(TEST_COURTS.map((courtNumber) => ({ courtNumber, match: null })));
    setMatchSeq(1);
    setScores({});
    showToast("테스트 콘솔을 초기화했습니다.");
  }

  function bestPairing(group: TestUser[]) {
    const pairings: Array<[TestUser[], TestUser[]]> = [
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
      .map(([teamA, teamB]) => {
        const balanceGap = Math.abs(testTeamAverage(teamA) - testTeamAverage(teamB));
        const hasWomen = [...teamA, ...teamB].some((user) => user.gender === "female");
        const mixedPenalty = hasWomen ? (testIsMixed(teamA) ? 0 : 8) + (testIsMixed(teamB) ? 0 : 8) : 0;

        return {
          teamA,
          teamB,
          balanceGap,
          score: balanceGap + mixedPenalty
        };
      })
      .sort((a, b) => a.score - b.score)[0];
  }

  function assignCourt(courtNumber: number) {
    const targetCourt = testCourts.find((court) => court.courtNumber === courtNumber);
    if (targetCourt?.match && targetCourt.match.status !== "finished") {
      showToast("이 코트는 아직 경기가 끝나지 않았습니다.");
      return;
    }

    const eligible = testUsers
      .filter((user) => user.present)
      .filter((user) => !activePlayerIds.has(user.id))
      .sort((a, b) => {
        if (a.games !== b.games) return a.games - b.games;
        if (testUserRate(a) !== testUserRate(b)) return testUserRate(a) - testUserRate(b);
        return a.name.localeCompare(b.name, "ko");
      });

    if (eligible.length < 4) {
      showToast("입장 중이고 대기 중인 사용자가 4명 이상 필요합니다.");
      return;
    }

    const candidates = testCombinations(eligible.slice(0, 12), 4)
      .map((group) => {
        const pairing = bestPairing(group);
        const fairness = group.reduce((sum, user) => sum + user.games, 0) * 50;

        return {
          group,
          pairing,
          score: fairness + pairing.score
        };
      })
      .sort((a, b) => a.score - b.score);

    const best = candidates[0];
    if (!best) return;

    const match: TestMatch = {
      id: `test-match-${matchSeq}`,
      courtNumber,
      status: "scheduled",
      teamA: best.pairing.teamA.map((user) => user.id),
      teamB: best.pairing.teamB.map((user) => user.id),
      assignedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      teamAScore: null,
      teamBScore: null,
      winnerTeam: null
    };

    setMatchSeq((seq) => seq + 1);
    setScores((rows) => ({ ...rows, [match.id]: { a: "", b: "" } }));
    setTestCourts((courts) => courts.map((court) => (court.courtNumber === courtNumber ? { ...court, match } : court)));
    showToast(`코트 ${courtName(courtNumber)}에 테스트 경기를 배정했습니다.`);
  }

  function startTestMatch(matchId: string) {
    setTestCourts((courts) =>
      courts.map((court) =>
        court.match?.id === matchId
          ? {
              ...court,
              match: {
                ...court.match,
                status: "in_progress",
                startedAt: court.match.startedAt ?? new Date().toISOString()
              }
            }
          : court
      )
    );
  }

  function finishTestMatch(matchId: string) {
    setTestCourts((courts) =>
      courts.map((court) =>
        court.match?.id === matchId
          ? {
              ...court,
              match: {
                ...court.match,
                status: "awaiting_result",
                endedAt: court.match.endedAt ?? new Date().toISOString()
              }
            }
          : court
      )
    );
  }

  function saveTestResult(match: TestMatch) {
    const score = scores[match.id] ?? { a: "", b: "" };
    const teamAScore = Number(score.a);
    const teamBScore = Number(score.b);

    if (!Number.isFinite(teamAScore) || !Number.isFinite(teamBScore) || teamAScore === teamBScore) {
      showToast("승패가 갈리도록 점수를 입력해주세요.");
      return;
    }

    const winnerTeam = teamAScore > teamBScore ? "A" : "B";
    const winnerIds = winnerTeam === "A" ? match.teamA : match.teamB;
    const loserIds = winnerTeam === "A" ? match.teamB : match.teamA;
    const winnerSet = new Set(winnerIds);
    const loserSet = new Set(loserIds);

    setTestUsers((users) =>
      users.map((user) => {
        if (winnerSet.has(user.id)) {
          return { ...user, games: user.games + 1, wins: user.wins + 1 };
        }
        if (loserSet.has(user.id)) {
          return { ...user, games: user.games + 1, losses: user.losses + 1 };
        }
        return user;
      })
    );

    setTestCourts((courts) =>
      courts.map((court) =>
        court.match?.id === match.id
          ? {
              ...court,
              match: {
                ...court.match,
                status: "finished",
                teamAScore,
                teamBScore,
                winnerTeam
              }
            }
          : court
      )
    );
    showToast("테스트 경기 결과를 저장했습니다.");
  }

  function clearCourt(courtNumber: number) {
    setTestCourts((courts) => courts.map((court) => (court.courtNumber === courtNumber ? { ...court, match: null } : court)));
  }

  return (
    <div className="screen">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">관리자 테스트</p>
          <h1>3코트 시뮬레이션</h1>
        </div>
        <span className="attendance-badge active">입장 {presentCount}</span>
      </section>

      <section className="test-toolbar">
        <button className="full-button primary" type="button" onClick={() => addTempUsers(4)}>
          <UserPlus size={18} />
          임시 4명 추가
        </button>
        <button className="full-button" type="button" onClick={setAllPresent}>
          <CheckCircle2 size={18} />
          전체 입장
        </button>
        <button className="full-button danger" type="button" onClick={clearTest}>
          <RotateCcw size={18} />
          초기화
        </button>
      </section>

      <section className="summary-grid">
        <div className="metric">
          <span>임시 사용자</span>
          <strong>{testUsers.length}</strong>
        </div>
        <div className="metric">
          <span>대기 가능</span>
          <strong>{availableCount}</strong>
        </div>
        <div className="metric">
          <span>코트</span>
          <strong>3</strong>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>임시 사용자 입퇴장</h2>
          <span className="count-chip">{availableCount}명 대기</span>
        </div>
        <div className="test-user-grid">
          {testUsers.map((user) => {
            const inActiveMatch = activePlayerIds.has(user.id);
            return (
              <article className={classNames("test-user-card", user.present && "present")} key={user.id}>
                <div>
                  <strong>{user.name}</strong>
                  <small>
                    {genderLabels[user.gender]} · {user.games}전 {user.wins}승 {user.losses}패 · {formatRate(testUserRate(user))}
                  </small>
                  <small>{user.present ? `입장 ${formatTime(user.enteredAt)}` : user.leftAt ? `퇴장 ${formatTime(user.leftAt)}` : "미입장"}</small>
                </div>
                <button
                  className={classNames("small-button", user.present ? "danger" : "primary")}
                  disabled={inActiveMatch}
                  type="button"
                  onClick={() => togglePresence(user.id)}
                >
                  {user.present ? <DoorOpen size={16} /> : <CheckCircle2 size={16} />}
                  {user.present ? "퇴장" : "입장"}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <section className="test-court-grid">
        {testCourts.map((court) => {
          const match = court.match;
          const score = match ? scores[match.id] ?? { a: "", b: "" } : { a: "", b: "" };
          const minutes = match ? elapsedMinutes(match.startedAt, match.endedAt) : null;

          return (
            <article className="test-court-card" key={court.courtNumber}>
              <div className="match-head">
                <div>
                  <p className="eyebrow">코트 {courtName(court.courtNumber)}</p>
                  <h2>{match ? testMatchStatusLabel(match.status) : "비어 있음"}</h2>
                </div>
                <button
                  className="small-button primary"
                  disabled={Boolean(match && match.status !== "finished")}
                  type="button"
                  onClick={() => assignCourt(court.courtNumber)}
                >
                  <Users size={16} />
                  경기 배정
                </button>
              </div>

              {match ? (
                <>
                  <div className="teams">
                    <div className="team-row">
                      <span>A</span>
                      <strong>{names(match.teamA)}</strong>
                    </div>
                    <div className="team-row">
                      <span>B</span>
                      <strong>{names(match.teamB)}</strong>
                    </div>
                  </div>

                  <div className="match-meta">
                    <span>배정 {formatTime(match.assignedAt)}</span>
                    <span>시작 {formatTime(match.startedAt)}</span>
                    <span>종료 {formatTime(match.endedAt)}</span>
                    <span>{minutes === null ? "소요 -" : `${minutes}분`}</span>
                  </div>

                  {match.status === "scheduled" && (
                    <button className="full-button primary" type="button" onClick={() => startTestMatch(match.id)}>
                      <Play size={18} />
                      경기 시작
                    </button>
                  )}

                  {match.status === "in_progress" && (
                    <button className="full-button" type="button" onClick={() => finishTestMatch(match.id)}>
                      <StopCircle size={18} />
                      경기 종료
                    </button>
                  )}

                  {match.status === "awaiting_result" && (
                    <form
                      className="score-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveTestResult(match);
                      }}
                    >
                      <label>
                        A팀
                        <input
                          inputMode="numeric"
                          min={0}
                          required
                          type="number"
                          value={score.a}
                          onChange={(event) =>
                            setScores((rows) => ({ ...rows, [match.id]: { ...score, a: event.target.value } }))
                          }
                        />
                      </label>
                      <label>
                        B팀
                        <input
                          inputMode="numeric"
                          min={0}
                          required
                          type="number"
                          value={score.b}
                          onChange={(event) =>
                            setScores((rows) => ({ ...rows, [match.id]: { ...score, b: event.target.value } }))
                          }
                        />
                      </label>
                      <button className="icon-button primary" title="테스트 결과 저장" type="submit">
                        <Save size={18} />
                      </button>
                    </form>
                  )}

                  {match.status === "finished" && (
                    <>
                      <div className="score-line">
                        <strong>
                          {match.teamAScore} : {match.teamBScore}
                        </strong>
                        <span>{winnerLabel(match.winnerTeam)} 승</span>
                      </div>
                      <button className="full-button" type="button" onClick={() => clearCourt(court.courtNumber)}>
                        코트 비우기
                      </button>
                    </>
                  )}
                </>
              ) : (
                <p className="empty">현재 입장해 있고 다른 코트에 배정되지 않은 사용자 4명을 자동으로 고릅니다.</p>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function CourtManagement({
  courts,
  busy,
  tableReady,
  onStartRental,
  onEndRental
}: {
  courts: Court[];
  busy: boolean;
  tableReady: boolean;
  onStartRental: (court: Court) => Promise<void>;
  onEndRental: (court: Court) => Promise<void>;
}) {
  const courtRows = DEFAULT_COURTS.map((defaultCourt) => {
    const stored = courts.find((court) => court.court_number === defaultCourt.court_number);

    return (
      stored ?? {
        court_number: defaultCourt.court_number,
        court_name: defaultCourt.court_name,
        is_available: false,
        rental_started_at: null,
        rental_ended_at: null,
        updated_at: new Date(0).toISOString()
      }
    );
  });
  const availableCount = courtRows.filter((court) => court.is_available).length;

  return (
    <div className="screen">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">관리자</p>
          <h1>가용 코트 관리</h1>
        </div>
        <span className={classNames("attendance-badge", availableCount > 0 && "active")}>가용 {availableCount}/3</span>
      </section>

      <section className="summary-grid">
        <div className="metric">
          <span>총 코트</span>
          <strong>3</strong>
        </div>
        <div className="metric">
          <span>가용</span>
          <strong>{availableCount}</strong>
        </div>
        <div className="metric">
          <span>사용 불가</span>
          <strong>{3 - availableCount}</strong>
        </div>
      </section>

      <section className="court-grid">
        {courtRows.map((court) => (
          <article className={classNames("court-card", court.is_available && "available")} key={court.court_number}>
            <div className="match-head">
              <div>
                <p className="eyebrow">코트 {court.court_name}</p>
                <h2>{court.is_available ? "가용 중" : "사용 불가"}</h2>
              </div>
              <span className={classNames("status-pill", court.is_available ? "finished" : "scheduled")}>
                {court.is_available ? "가용" : "불가"}
              </span>
            </div>

            <div className="court-time-list">
              <div>
                <span>대여 시작</span>
                <strong>{formatTime(court.rental_started_at)}</strong>
              </div>
              <div>
                <span>대여 종료</span>
                <strong>{formatTime(court.rental_ended_at)}</strong>
              </div>
            </div>

            <div className="match-actions">
              <button className="small-button primary" disabled={busy || !tableReady || court.is_available} type="button" onClick={() => onStartRental(court)}>
                <Play size={16} />
                대여 시작
              </button>
              <button className="small-button danger" disabled={busy || !tableReady || !court.is_available} type="button" onClick={() => onEndRental(court)}>
                <StopCircle size={16} />
                대여 종료
              </button>
            </div>
          </article>
        ))}
      </section>

      <p className="helper-text">
        {tableReady
          ? "대여 시작한 코트만 실제 대진 생성 대상에 포함됩니다."
          : "Supabase SQL Editor에서 supabase/schema.sql을 다시 실행해 courts 테이블을 추가해주세요."}
      </p>
    </div>
  );
}

function ResultForm({
  match,
  onSave,
  disabled
}: {
  match: Match;
  onSave: (match: Match, teamAScore: number, teamBScore: number) => Promise<void>;
  disabled: boolean;
}) {
  const [teamAScore, setTeamAScore] = useState(match.team_a_score?.toString() ?? "");
  const [teamBScore, setTeamBScore] = useState(match.team_b_score?.toString() ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(match, Number(teamAScore), Number(teamBScore));
  }

  return (
    <form className="score-form" onSubmit={submit}>
      <label>
        A팀
        <input
          inputMode="numeric"
          min={0}
          required
          type="number"
          value={teamAScore}
          onChange={(event) => setTeamAScore(event.target.value)}
        />
      </label>
      <label>
        B팀
        <input
          inputMode="numeric"
          min={0}
          required
          type="number"
          value={teamBScore}
          onChange={(event) => setTeamBScore(event.target.value)}
        />
      </label>
      <button className="icon-button primary" disabled={disabled} title="결과 저장" type="submit">
        <Save size={18} />
      </button>
    </form>
  );
}

function AuthScreen({
  onLoginComplete
}: {
  onLoginComplete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<Gender>("male");
  const [registerLoginId, setRegisterLoginId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasSupabaseConfig) return;

    fetch("/api/system/ensure-admin", { method: "POST" }).catch(() => {
      setMessage("관리자 자동 생성에 실패했습니다. Supabase 설정을 확인해주세요.");
    });
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    const { error } = await supabase.auth.signInWithPassword({
      email: loginIdToEmail(loginId),
      password
    });

    if (error) {
      setMessage("아이디 또는 비밀번호를 확인해주세요.");
      setBusy(false);
      return;
    }

    await onLoginComplete();
    setBusy(false);
  }

  async function submitRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    const effectiveLoginId = normalizeLoginId(registerLoginId || displayName);
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName,
        phone,
        gender,
        loginId: effectiveLoginId
      })
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setMessage(body.message ?? "회원가입에 실패했습니다.");
      setBusy(false);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: loginIdToEmail(effectiveLoginId),
      password: DEFAULT_PASSWORD
    });

    if (error) {
      setMessage("회원가입이 완료되었습니다. 기본 비밀번호로 로그인해주세요.");
      setMode("login");
      setLoginId(effectiveLoginId);
      setPassword(DEFAULT_PASSWORD);
      setBusy(false);
      return;
    }

    await onLoginComplete();
    setBusy(false);
  }

  if (!hasSupabaseConfig) {
    return (
      <main className="auth-layout">
        <section className="auth-card">
          <div className="brand-mark">AM5</div>
          <h1>환경 변수 필요</h1>
          <p className="muted">`.env.local`에 Supabase URL과 key를 설정하면 앱이 연결됩니다.</p>
          <div className="setup-list">
            <code>NEXT_PUBLIC_SUPABASE_URL</code>
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
            <code>SUPABASE_SERVICE_ROLE_KEY</code>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-layout">
      <section className="auth-card">
        <div className="brand-row">
          <div className="brand-mark">AM5</div>
          <div>
            <h1>경기 관리</h1>
            <p className="muted">테니스 모임 운영</p>
          </div>
        </div>

        <div className="segmented">
          <button className={mode === "login" ? "active" : ""} type="button" onClick={() => setMode("login")}>
            로그인
          </button>
          <button className={mode === "register" ? "active" : ""} type="button" onClick={() => setMode("register")}>
            회원가입
          </button>
        </div>

        {mode === "login" ? (
          <form className="stack-form" onSubmit={submitLogin}>
            <label>
              로그인 아이디
              <input autoComplete="username" required value={loginId} onChange={(event) => setLoginId(event.target.value)} />
            </label>
            <label>
              비밀번호
              <input
                autoComplete="current-password"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="full-button primary" disabled={busy} type="submit">
              <KeyRound size={18} />
              로그인
            </button>
          </form>
        ) : (
          <form className="stack-form" onSubmit={submitRegister}>
            <label>
              이름
              <input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <label>
              전화번호
              <input inputMode="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>
            <label>
              로그인 아이디
              <input
                placeholder={displayName || "이름"}
                value={registerLoginId}
                onChange={(event) => setRegisterLoginId(event.target.value)}
              />
            </label>
            <label>
              성별
              <select value={gender} onChange={(event) => setGender(event.target.value as Gender)}>
                <option value="male">남성</option>
                <option value="female">여성</option>
                <option value="other">기타</option>
              </select>
            </label>
            <button className="full-button primary" disabled={busy} type="submit">
              <UserPlus size={18} />
              가입
            </button>
          </form>
        )}

        {message && <p className="form-message">{message}</p>}
      </section>
    </main>
  );
}

function PasswordChangeScreen({
  profile,
  onChanged
}: {
  profile: Profile;
  onChanged: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    if (password.length < 6) {
      setMessage("비밀번호는 6자 이상으로 입력해주세요.");
      return;
    }

    if (password !== confirmPassword) {
      setMessage("비밀번호가 서로 다릅니다.");
      return;
    }

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setMessage(error.message);
      setBusy(false);
      return;
    }

    await supabase.from("profiles").update({ must_change_password: false }).eq("id", profile.id);
    await onChanged();
    setBusy(false);
  }

  return (
    <main className="auth-layout">
      <section className="auth-card">
        <div className="brand-row">
          <div className="brand-mark">AM5</div>
          <div>
            <h1>비밀번호 변경</h1>
            <p className="muted">{profile.display_name}</p>
          </div>
        </div>
        <form className="stack-form" onSubmit={submit}>
          <label>
            새 비밀번호
            <input autoComplete="new-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <label>
            새 비밀번호 확인
            <input
              autoComplete="new-password"
              required
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <button className="full-button primary" disabled={busy} type="submit">
            <Save size={18} />
            저장
          </button>
        </form>
        {message && <p className="form-message">{message}</p>}
      </section>
    </main>
  );
}

export function Am5App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [attendances, setAttendances] = useState<Attendance[]>([]);
  const [courts, setCourts] = useState<Court[]>(
    DEFAULT_COURTS.map((court) => ({
      court_number: court.court_number,
      court_name: court.court_name,
      is_available: false,
      rental_started_at: null,
      rental_ended_at: null,
      updated_at: new Date(0).toISOString()
    }))
  );
  const [courtTableReady, setCourtTableReady] = useState(true);
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchPlayers, setMatchPlayers] = useState<MatchPlayer[]>([]);
  const [tab, setTab] = useState<Tab>("today");
  const [resultMeetingId, setResultMeetingId] = useState("");
  const [rankingScope, setRankingScope] = useState<RankingScope>("month");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [memberDrafts, setMemberDrafts] = useState<Record<string, Draft>>({});
  const [newMemberDraft, setNewMemberDraft] = useState({
    kind: "member" as "member" | "guest",
    displayName: "",
    phone: "",
    loginId: "",
    gender: "male" as Gender,
    seedWinRate: 50
  });

  const today = todayKey();
  const todayMeeting = useMemo(() => meetings.find((meeting) => meeting.meeting_date === today) ?? null, [meetings, today]);
  const profileById = useMemo(() => new Map(profiles.map((row) => [row.id, row])), [profiles]);
  const regularProfiles = useMemo(() => profiles.filter((row) => !row.is_guest), [profiles]);

  const todayAttendances = useMemo(
    () => attendances.filter((attendance) => attendance.meeting_id === todayMeeting?.id),
    [attendances, todayMeeting?.id]
  );
  const todayActiveAttendanceByMemberId = useMemo(
    () => new Map(todayAttendances.filter((attendance) => !attendance.checked_out_at).map((attendance) => [attendance.member_id, attendance])),
    [todayAttendances]
  );
  const todayLatestAttendanceByMemberId = useMemo(() => {
    const latest = new Map<string, Attendance>();
    const sorted = [...todayAttendances].sort(
      (a, b) => new Date(b.checked_in_at).getTime() - new Date(a.checked_in_at).getTime()
    );

    sorted.forEach((attendance) => {
      if (!latest.has(attendance.member_id)) {
        latest.set(attendance.member_id, attendance);
      }
    });

    return latest;
  }, [todayAttendances]);
  const todayMatches = useMemo(
    () =>
      matches
        .filter((match) => match.meeting_id === todayMeeting?.id)
        .sort((a, b) => a.round_number - b.round_number || a.court_number - b.court_number),
    [matches, todayMeeting?.id]
  );
  const myAttendance = useMemo(
    () => todayAttendances.find((attendance) => attendance.member_id === profile?.id && !attendance.checked_out_at) ?? null,
    [profile?.id, todayAttendances]
  );
  const isPresent = Boolean(myAttendance && !myAttendance.checked_out_at);

  const statsAll = useMemo(() => buildStats(profiles, meetings, matches, matchPlayers, "all"), [profiles, meetings, matches, matchPlayers]);
  const myStatsAll = profile ? statsAll.get(profile.id) : null;
  const myStatsMonth = useMemo(
    () => (profile ? buildStats(profiles, meetings, matches, matchPlayers, "month").get(profile.id) : null),
    [profile, profiles, meetings, matches, matchPlayers]
  );
  const myStatsYear = useMemo(
    () => (profile ? buildStats(profiles, meetings, matches, matchPlayers, "year").get(profile.id) : null),
    [profile, profiles, meetings, matches, matchPlayers]
  );
  const rankingRows = useMemo(
    () => getRankings(profiles, meetings, matches, matchPlayers, rankingScope),
    [profiles, meetings, matches, matchPlayers, rankingScope]
  );
  const meetingDateById = useMemo(() => new Map(meetings.map((meeting) => [meeting.id, meeting.meeting_date])), [meetings]);
  const selectedResultMeetingId = resultMeetingId || meetings[0]?.id || "";
  const resultMatches = useMemo(
    () =>
      matches
        .filter((match) => match.meeting_id === selectedResultMeetingId)
        .filter((match) => match.status === "finished")
        .filter((match) => match.team_a_score !== null && match.team_b_score !== null)
        .sort((a, b) => a.round_number - b.round_number || a.court_number - b.court_number),
    [matches, selectedResultMeetingId]
  );
  const allFinishedMatches = useMemo(
    () =>
      matches
        .filter((match) => match.status === "finished")
        .filter((match) => match.team_a_score !== null && match.team_b_score !== null),
    [matches]
  );

  const myMatchIds = useMemo(
    () => new Set(matchPlayers.filter((row) => row.member_id === profile?.id).map((row) => row.match_id)),
    [matchPlayers, profile?.id]
  );
  const todayGameCountByMemberId = useMemo(() => {
    const counts = new Map<string, number>();
    const todayMatchIds = new Set(todayMatches.map((match) => match.id));

    matchPlayers.forEach((player) => {
      if (!todayMatchIds.has(player.match_id)) return;
      counts.set(player.member_id, (counts.get(player.member_id) ?? 0) + 1);
    });

    return counts;
  }, [todayMatches, matchPlayers]);
  const myCurrentMatch = useMemo(
    () => todayMatches.find((match) => myMatchIds.has(match.id) && match.status === "in_progress") ?? null,
    [todayMatches, myMatchIds]
  );
  const myNextMatch = useMemo(
    () => todayMatches.find((match) => myMatchIds.has(match.id) && match.status === "scheduled") ?? null,
    [todayMatches, myMatchIds]
  );
  const currentMatches = todayMatches.filter((match) => match.status === "in_progress");
  const otherCurrentMatches = useMemo(
    () => currentMatches.filter((match) => !myMatchIds.has(match.id)),
    [currentMatches, myMatchIds]
  );
  const courtProgressRows = useMemo(
    () =>
      DEFAULT_COURTS.map((court) => {
        const courtMatches = todayMatches.filter((match) => match.court_number === court.court_number);
        const inProgressMatch = courtMatches.find((match) => match.status === "in_progress") ?? null;
        const nextScheduledMatch = courtMatches.find((match) => match.status === "scheduled") ?? null;

        return {
          courtNumber: court.court_number,
          inProgressMatch,
          nextScheduledMatch,
          inProgressCount: courtMatches.filter((match) => match.status === "in_progress").length,
          scheduledCount: courtMatches.filter((match) => match.status === "scheduled").length,
          finishedCount: courtMatches.filter((match) => match.status === "finished").length,
          totalCount: courtMatches.length
        };
      }),
    [todayMatches]
  );
  const todayFinishedMatches = useMemo(
    () =>
      todayMatches
        .filter((match) => match.status === "finished")
        .filter((match) => match.team_a_score !== null && match.team_b_score !== null)
        .sort((a, b) => {
          const left = new Date(b.ended_at ?? b.updated_at ?? b.created_at).getTime();
          const right = new Date(a.ended_at ?? a.updated_at ?? a.created_at).getTime();
          return left - right;
        }),
    [todayMatches]
  );

  useEffect(() => {
    if (!meetings.length) return;
    if (resultMeetingId) return;
    setResultMeetingId(meetings[0].id);
  }, [meetings, resultMeetingId]);

  const isAdmin = profile?.role === "admin";
  const availableCourtNumbers = useMemo(
    () => courts.filter((court) => court.is_available).map((court) => court.court_number),
    [courts]
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const loadData = useCallback(async () => {
    if (!hasSupabaseConfig) {
      setLoading(false);
      return;
    }

    const [profileResponse, meetingsResponse, attendanceResponse, courtResponse, matchesResponse, playerResponse] = await Promise.all([
      supabase.from("profiles").select("*").order("display_name", { ascending: true }),
      supabase.from("meetings").select("*").order("meeting_date", { ascending: false }),
      supabase.from("attendances").select("*").order("checked_in_at", { ascending: false }),
      supabase.from("courts").select("*").order("court_number", { ascending: true }),
      supabase.from("matches").select("*").order("created_at", { ascending: false }),
      supabase.from("match_players").select("*")
    ]);

    if (profileResponse.error) throw profileResponse.error;
    if (meetingsResponse.error) throw meetingsResponse.error;
    if (attendanceResponse.error) throw attendanceResponse.error;
    if (courtResponse.error) {
      setCourtTableReady(false);
      setCourts(
        DEFAULT_COURTS.map((court) => ({
          court_number: court.court_number,
          court_name: court.court_name,
          is_available: false,
          rental_started_at: null,
          rental_ended_at: null,
          updated_at: new Date(0).toISOString()
        }))
      );
    } else {
      setCourtTableReady(true);
      setCourts((courtResponse.data ?? []) as Court[]);
    }
    if (matchesResponse.error) throw matchesResponse.error;
    if (playerResponse.error) throw playerResponse.error;

    setProfiles((profileResponse.data ?? []) as Profile[]);
    setMeetings((meetingsResponse.data ?? []) as Meeting[]);
    setAttendances((attendanceResponse.data ?? []) as Attendance[]);
    setMatches((matchesResponse.data ?? []) as Match[]);
    setMatchPlayers((playerResponse.data ?? []) as MatchPlayer[]);
  }, []);

  const hydrate = useCallback(async () => {
    setLoading(true);
    if (hasSupabaseConfig) {
      await fetch("/api/system/ensure-admin", { method: "POST" }).catch(() => undefined);
    }

    const {
      data: { session: freshSession }
    } = await supabase.auth.getSession();
    setSession(freshSession);

    if (!freshSession?.user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase.from("profiles").select("*").eq("id", freshSession.user.id).single();

    if (error) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setProfile(data as Profile);
    await loadData();
    setLoading(false);
  }, [loadData]);

  useEffect(() => {
    hydrate();
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) setProfile(null);
    });

    return () => subscription.unsubscribe();
  }, [hydrate]);

  useEffect(() => {
    const drafts = Object.fromEntries(
      profiles.map((row) => [
        row.id,
        {
          display_name: row.display_name,
          phone: row.phone,
          gender: row.gender,
          role: row.role,
          seed_win_rate: row.seed_win_rate
        }
      ])
    );
    setMemberDrafts(drafts);
  }, [profiles]);

  async function guarded(action: () => Promise<void>, success?: string) {
    setBusy(true);
    try {
      await action();
      await loadData();
      if (success) showToast(success);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "처리에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function adminFetch(url: string, init?: RequestInit) {
    if (!session?.access_token) throw new Error("세션을 확인할 수 없습니다.");
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        ...(init?.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message ?? "관리자 작업에 실패했습니다.");
    return body;
  }

  async function memberFetch(url: string, init?: RequestInit) {
    if (!session?.access_token) throw new Error("세션을 확인할 수 없습니다.");
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        ...(init?.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message ?? "요청 처리에 실패했습니다.");
    return body;
  }

  async function createTodayMeeting() {
    await guarded(async () => {
      const { error } = await supabase.from("meetings").upsert(
        {
          meeting_date: today,
          status: "active",
          created_by: profile?.id ?? null
        },
        { onConflict: "meeting_date" }
      );
      if (error) throw error;
    }, "오늘 모임을 준비했습니다.");
  }

  async function startCourtRental(court: Court) {
    await guarded(async () => {
      const { error } = await supabase.from("courts").upsert(
        {
          court_number: court.court_number,
          court_name: court.court_name,
          is_available: true,
          rental_started_at: new Date().toISOString(),
          rental_ended_at: null
        },
        { onConflict: "court_number" }
      );
      if (error) throw error;
    }, `코트 ${court.court_name} 대여를 시작했습니다.`);
  }

  async function endCourtRental(court: Court) {
    await guarded(async () => {
      const { error } = await supabase
        .from("courts")
        .update({
          is_available: false,
          rental_ended_at: new Date().toISOString()
        })
        .eq("court_number", court.court_number);
      if (error) throw error;
    }, `코트 ${court.court_name} 대여를 종료했습니다.`);
  }

  async function checkIn() {
    if (!profile) return;
    setBusy(true);
    try {
      const body = await memberFetch("/api/member/check-in", {
        method: "POST",
        body: JSON.stringify({ meetingDate: today })
      });
      await loadData();

      const assignedMatches = (body.assignedMatches ?? []) as Array<{
        courtName: string;
        teamA: string[];
        teamB: string[];
        includesCurrentUser: boolean;
      }>;
      const myMatch = assignedMatches.find((match) => match.includesCurrentUser);

      if (body.assignmentWarning) {
        showToast(`출석했습니다. 자동 대진 보류: ${body.assignmentWarning}`);
      } else if (myMatch) {
        showToast(`출석했습니다. 코트 ${myMatch.courtName}에 배정되었습니다.`);
      } else if (assignedMatches.length > 0) {
        showToast(`출석했습니다. 새 대진 ${assignedMatches.length}건이 생성되었습니다.`);
      } else {
        showToast("출석했습니다.");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "출석 처리에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function checkoutToastMessage(
    baseMessage: string,
    body: {
      canceledMatchCount?: number;
      assignedMatches?: Array<{ courtName: string; includesCurrentUser: boolean }>;
      assignmentWarning?: string | null;
    }
  ) {
    const canceledMatchCount = Number(body.canceledMatchCount ?? 0);
    const assignedMatches = body.assignedMatches ?? [];
    const details: string[] = [];

    if (canceledMatchCount > 0) {
      details.push(`배정 경기 ${canceledMatchCount}건을 취소했습니다.`);
    }

    if (assignedMatches.length > 0) {
      details.push(`다른 멤버 대진 ${assignedMatches.length}건을 새로 생성했습니다.`);
    }

    if (body.assignmentWarning) {
      details.push(`자동 대진 보류: ${body.assignmentWarning}`);
    }

    return [baseMessage, ...details].join(" ");
  }

  async function checkOut(memberId = profile?.id) {
    if (!todayMeeting || !memberId) return;

    const memberMatchIds = new Set(matchPlayers.filter((player) => player.member_id === memberId).map((player) => player.match_id));
    const inProgressMatch = todayMatches.find((match) => memberMatchIds.has(match.id) && match.status === "in_progress");

    if (inProgressMatch) {
      showToast("현재 진행 중인 경기가 있습니다. 먼저 경기 종료와 결과 입력을 완료한 뒤 퇴장해주세요.");
      return;
    }

    setBusy(true);
    try {
      const body = await memberFetch("/api/member/check-out", {
        method: "POST",
        body: JSON.stringify({ meetingDate: today })
      });
      await loadData();
      showToast(checkoutToastMessage("퇴장 처리했습니다.", body));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "퇴장 처리에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function setMemberAttendance(member: Profile, action: "check-in" | "check-out") {
    const isCheckedIn = todayActiveAttendanceByMemberId.has(member.id);
    const memberMatchIds = new Set(matchPlayers.filter((player) => player.member_id === member.id).map((player) => player.match_id));
    const inProgressMatch = todayMatches.find((match) => memberMatchIds.has(match.id) && match.status === "in_progress");

    if (action === "check-in" && isCheckedIn) {
      showToast(`${member.display_name}님은 이미 출석 중입니다.`);
      return;
    }

    if (action === "check-out" && !isCheckedIn) {
      showToast(`${member.display_name}님은 출석 중이 아닙니다.`);
      return;
    }

    if (action === "check-out" && inProgressMatch) {
      showToast(`${member.display_name}님은 진행 중인 경기가 있습니다. 먼저 경기 종료와 결과 입력을 완료해주세요.`);
      return;
    }

    setBusy(true);
    try {
      const body = await adminFetch(`/api/admin/members/${member.id}/attendance`, {
        method: "POST",
        body: JSON.stringify({ action, meetingDate: today })
      });
      await loadData();

      if (action === "check-out") {
        showToast(checkoutToastMessage(`${member.display_name}님을 퇴장 처리했습니다.`, body));
        return;
      }

      const assignedMatches = (body.assignedMatches ?? []) as Array<{
        courtName: string;
        includesCurrentUser: boolean;
      }>;
      const memberMatch = assignedMatches.find((match) => match.includesCurrentUser);

      if (body.assignmentWarning) {
        showToast(`${member.display_name}님을 출석 처리했습니다. 자동 대진 보류: ${body.assignmentWarning}`);
      } else if (memberMatch) {
        showToast(`${member.display_name}님을 출석 처리했습니다. 코트 ${memberMatch.courtName}에 배정됐습니다.`);
      } else if (assignedMatches.length > 0) {
        showToast(`${member.display_name}님을 출석 처리했습니다. 새 대진 ${assignedMatches.length}건이 생성됐습니다.`);
      } else {
        showToast(`${member.display_name}님을 출석 처리했습니다.`);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "회원 출석 처리에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function createDraw() {
    if (!todayMeeting) return;
    await guarded(async () => {
      if (availableCourtNumbers.length === 0) {
        throw new Error("현재 대여 시작된 가용 코트가 없습니다.");
      }

      const generated = generateMatches({
        meetingId: todayMeeting.id,
        profiles,
        attendances: todayAttendances,
        matches,
        players: matchPlayers,
        stats: statsAll,
        availableCourts: availableCourtNumbers
      });

      if (generated.length === 0) {
        throw new Error("대진을 만들 수 있는 인원이 부족하거나 코트가 모두 사용 중입니다.");
      }

      for (const generatedMatch of generated) {
        const { data, error } = await supabase
          .from("matches")
          .insert({
            meeting_id: todayMeeting.id,
            court_number: generatedMatch.court_number,
            round_number: generatedMatch.round_number,
            status: "scheduled"
          })
          .select("id")
          .single();

        if (error || !data) throw error ?? new Error("경기 생성에 실패했습니다.");

        const rows = [
          ...generatedMatch.teamA.map((memberId) => ({ match_id: data.id, member_id: memberId, team: "A" as Team })),
          ...generatedMatch.teamB.map((memberId) => ({ match_id: data.id, member_id: memberId, team: "B" as Team }))
        ];
        const { error: playerError } = await supabase.from("match_players").insert(rows);
        if (playerError) throw playerError;
      }
    }, "대진표를 생성했습니다.");
  }

  async function startMatch(match: Match) {
    setBusy(true);
    try {
      await memberFetch("/api/member/matches/start", {
        method: "POST",
        body: JSON.stringify({ matchId: match.id })
      });
      await loadData();
      showToast("경기를 시작했습니다.");
    } catch (error) {
      await loadData();
      showToast(error instanceof Error ? error.message : "경기 시작에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function finishMatch(match: Match) {
    await guarded(async () => {
      await memberFetch("/api/member/matches/finish", {
        method: "POST",
        body: JSON.stringify({ matchId: match.id })
      });
    }, "경기를 종료했습니다.");
  }

  async function saveResult(match: Match, teamAScore: number, teamBScore: number, options: { autoAssign?: boolean } = {}) {
    if (!Number.isFinite(teamAScore) || !Number.isFinite(teamBScore) || teamAScore === teamBScore) {
      showToast("승패가 갈리도록 점수를 입력해주세요.");
      return;
    }

    setBusy(true);
    try {
      const body = await memberFetch("/api/member/matches/result", {
        method: "POST",
        body: JSON.stringify({ matchId: match.id, teamAScore, teamBScore, autoAssign: options.autoAssign !== false })
      });
      await loadData();

      const assignedMatches = (body.assignedMatches ?? []) as Array<{
        courtName: string;
        includesCurrentUser: boolean;
      }>;
      const myMatch = assignedMatches.find((row) => row.includesCurrentUser);

      if (myMatch) {
        showToast(`결과를 저장했습니다. 다음 경기: 코트 ${myMatch.courtName}`);
      } else if (assignedMatches.length > 0) {
        showToast(`결과를 저장했습니다. 새 대진 ${assignedMatches.length}건이 생성되었습니다.`);
      } else {
        showToast("결과를 저장했습니다.");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "결과 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function updateMember(memberId: string) {
    const draft = memberDrafts[memberId];
    if (!draft) return;

    if (!Number.isFinite(draft.seed_win_rate) || draft.seed_win_rate < 0 || draft.seed_win_rate > 100) {
      showToast("기준 승률은 0~100 사이 값으로 입력해주세요.");
      return;
    }

    await guarded(async () => {
      const body = await adminFetch(`/api/admin/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify(draft)
      });
      if (body.profile?.id === profile?.id) setProfile(body.profile as Profile);
    }, "회원 정보를 저장했습니다.");
  }

  async function createMember() {
    const isGuest = newMemberDraft.kind === "guest";
    const displayName = newMemberDraft.displayName.trim();
    const phone = newMemberDraft.phone.trim() || (isGuest ? "게스트" : "");
    const loginId = normalizeLoginId(newMemberDraft.loginId || displayName);
    const seedWinRate = Number(newMemberDraft.seedWinRate);

    if (!displayName || !phone || (!isGuest && !loginId)) {
      showToast("이름, 전화번호, 로그인 아이디를 확인해주세요.");
      return;
    }

    if (!Number.isFinite(seedWinRate) || seedWinRate < 0 || seedWinRate > 100) {
      showToast("기준 승률은 0~100 사이 값으로 입력해주세요.");
      return;
    }

    if (isGuest && !todayMeeting) {
      showToast("당일 모임이 생성된 상태에서만 게스트를 추가할 수 있습니다.");
      return;
    }

    setBusy(true);
    try {
      const body = await adminFetch("/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          displayName,
          phone,
          gender: newMemberDraft.gender,
          loginId,
          isGuest,
          seedWinRate,
          todayMeetingId: todayMeeting?.id ?? null
        })
      });

      setNewMemberDraft({
        kind: "member",
        displayName: "",
        phone: "",
        loginId: "",
        gender: "male",
        seedWinRate: 50
      });
      await loadData();

      if (isGuest) {
        showToast(`${body.displayName ?? displayName} 게스트를 추가했습니다. 기준 승률 ${seedWinRate.toFixed(1)}%로 출석 처리되었습니다.`);
      } else {
        showToast(`회원을 추가했습니다. 초기 비밀번호는 ${DEFAULT_PASSWORD} 입니다.`);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "회원 추가에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function setMemberRole(member: Profile, role: Role) {
    if (member.role === role) return;

    if (member.id === profile?.id && role !== "admin") {
      showToast("본인의 관리자 권한은 삭제할 수 없습니다.");
      return;
    }

    await guarded(async () => {
      const body = await adminFetch(`/api/admin/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      if (body.profile?.id === profile?.id) setProfile(body.profile as Profile);
    }, role === "admin" ? `${member.display_name}님에게 관리자 권한을 부여했습니다.` : `${member.display_name}님의 관리자 권한을 삭제했습니다.`);
  }

  async function resetPassword(memberId: string) {
    await guarded(async () => {
      await adminFetch("/api/admin/reset-password", {
        method: "POST",
        body: JSON.stringify({ memberId })
      });
    }, `비밀번호를 ${DEFAULT_PASSWORD}로 초기화했습니다.`);
  }

  async function deleteMember(memberId: string) {
    if (memberId === profile?.id) {
      showToast("본인 계정은 삭제할 수 없습니다.");
      return;
    }

    if (!window.confirm("회원 계정을 삭제할까요?")) return;

    await guarded(async () => {
      await adminFetch(`/api/admin/members/${memberId}`, { method: "DELETE" });
    }, "회원을 삭제했습니다.");
  }

  async function deleteMatchRecord(match: Match) {
    const matchDate = formatDate(meetingDateById.get(match.meeting_id) ?? "");

    if (!window.confirm(`${matchDate} 코트 ${courtName(match.court_number)} 라운드 ${match.round_number} 경기 기록을 삭제할까요?`)) return;

    await guarded(async () => {
      await adminFetch(`/api/admin/matches/${match.id}`, { method: "DELETE" });
    }, "경기 기록을 삭제했습니다.");
  }

  async function deleteAllFinishedMatchRecords() {
    const recordCount = allFinishedMatches.length;

    if (recordCount === 0) {
      showToast("삭제할 경기 기록이 없습니다.");
      return;
    }

    if (!window.confirm(`완료된 전체 경기 기록 ${recordCount}건을 모두 삭제할까요?\n삭제하면 랭킹과 전적에서도 제외됩니다.`)) return;

    setBusy(true);
    try {
      const body = await adminFetch("/api/admin/matches", {
        method: "DELETE",
        body: JSON.stringify({ confirmAllFinishedMatches: true })
      });
      await loadData();
      showToast(`${body.deletedCount ?? recordCount}건의 경기 기록을 삭제했습니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "경기 기록 삭제에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setTab("today");
  }

  function matchTeam(matchId: string, team: Team) {
    return matchPlayers.filter((row) => row.match_id === matchId && row.team === team).map((row) => row.member_id);
  }

  function names(ids: string[], includeTodayStats = false) {
    return ids
      .map((id) => {
        const name = profileById.get(id)?.display_name ?? "알 수 없음";
        if (!includeTodayStats) return name;

        const todayGames = todayGameCountByMemberId.get(id) ?? 0;
        const winRate = statsAll.get(id)?.winRate ?? 0;
        return `${name} (${todayGames}경기 · ${formatRate(winRate)})`;
      })
      .join(" · ");
  }

  function teamAverageWinRate(ids: string[]) {
    if (!ids.length) return 0;
    const total = ids.reduce((sum, id) => sum + (statsAll.get(id)?.winRate ?? 0), 0);
    return total / ids.length;
  }

  function renderNamesWithStats(ids: string[]) {
    return ids.map((id, index) => {
      const name = profileById.get(id)?.display_name ?? "알 수 없음";
      const todayGames = todayGameCountByMemberId.get(id) ?? 0;
      const winRate = statsAll.get(id)?.winRate ?? 0;

      return (
        <span className="member-inline" key={id}>
          <span className="member-name">{name}</span>
          <small className="member-meta">
            {todayGames}경기 · {formatRate(winRate)}
          </small>
          {index < ids.length - 1 && <span className="member-sep"> · </span>}
        </span>
      );
    });
  }

  function renderMatchCard(match: Match, includeTodayStats = false) {
    const teamA = matchTeam(match.id, "A");
    const teamB = matchTeam(match.id, "B");
    const teamAAvg = teamAverageWinRate(teamA);
    const teamBAvg = teamAverageWinRate(teamB);
    const minutes = elapsedMinutes(match.started_at, match.ended_at);
    const mine = profile ? [...teamA, ...teamB].includes(profile.id) : false;
    const canManageMatch = isAdmin || mine;
    const canStartMatch = canManageMatch && match.status === "scheduled" && availableCourtNumbers.includes(match.court_number);
    const canFinishMatch = canManageMatch && !match.ended_at && match.status !== "finished";
    const canRecordResult =
      canManageMatch &&
      Boolean(match.ended_at) &&
      (isAdmin || (match.team_a_score === null && match.team_b_score === null));

    return (
      <article className={classNames("match-card", mine && "mine")} key={match.id}>
        <div className="match-head">
          <div>
            <span className="eyebrow">코트 {courtName(match.court_number)}</span>
            <h3>{matchDisplayStatus(match)}</h3>
          </div>
          <span className={classNames("status-pill", match.status)}>{matchDisplayStatus(match)}</span>
        </div>

        <div className="teams">
          <div className={classNames("team-row", includeTodayStats && "with-stats")}>
            <span>A</span>
            {includeTodayStats && <small className="team-avg">평균 {formatRate(teamAAvg)}</small>}
            <strong>{includeTodayStats ? renderNamesWithStats(teamA) : names(teamA)}</strong>
          </div>
          <div className={classNames("team-row", includeTodayStats && "with-stats")}>
            <span>B</span>
            {includeTodayStats && <small className="team-avg">평균 {formatRate(teamBAvg)}</small>}
            <strong>{includeTodayStats ? renderNamesWithStats(teamB) : names(teamB)}</strong>
          </div>
        </div>

        <div className="match-meta">
          <span>시작 {formatTime(match.started_at)}</span>
          <span>종료 {formatTime(match.ended_at)}</span>
          <span>{minutes === null ? "소요 -" : `${minutes}분`}</span>
        </div>

        {match.team_a_score !== null && match.team_b_score !== null && (
          <div className="score-line">
            <strong>
              {match.team_a_score} : {match.team_b_score}
            </strong>
            <span>{winnerLabel(match.winner_team)} 승</span>
          </div>
        )}

        {canManageMatch && (
          <>
            <div className="match-actions">
              <button className="small-button" disabled={busy || !canStartMatch} type="button" onClick={() => startMatch(match)}>
                <Play size={16} />
                시작
              </button>
              <button className="small-button" disabled={busy || !canFinishMatch} type="button" onClick={() => finishMatch(match)}>
                <StopCircle size={16} />
                종료
              </button>
            </div>
            {canRecordResult && <ResultForm disabled={busy} match={match} onSave={saveResult} />}
          </>
        )}
      </article>
    );
  }

  if (loading) {
    return (
      <main className="splash">
        <div className="brand-mark">AM5</div>
        <p>불러오는 중</p>
      </main>
    );
  }

  if (!session || !profile) {
    return <AuthScreen onLoginComplete={hydrate} />;
  }

  if (profile.must_change_password) {
    return <PasswordChangeScreen profile={profile} onChanged={hydrate} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="plain-brand" type="button" onClick={() => setTab("today")}>
          AM5
        </button>
        <div className="top-actions">
          {isAdmin && (
            <>
              <button className={classNames("icon-button", tab === "members" && "active")} title="회원" type="button" onClick={() => setTab("members")}>
                <Users size={19} />
              </button>
              <button className={classNames("icon-button", tab === "monitor" && "active")} title="현황" type="button" onClick={() => setTab("monitor")}>
                <Activity size={19} />
              </button>
              <button className={classNames("icon-button", tab === "test" && "active")} title="테스트" type="button" onClick={() => setTab("test")}>
                <SquarePen size={19} />
              </button>
              <button className={classNames("icon-button", tab === "courts" && "active")} title="코트" type="button" onClick={() => setTab("courts")}>
                <Medal size={19} />
              </button>
              <button className={classNames("icon-button", tab === "admin" && "active")} title="관리" type="button" onClick={() => setTab("admin")}>
                <Shield size={19} />
              </button>
            </>
          )}
          <button className="icon-button" title="로그아웃" type="button" onClick={signOut}>
            <LogOut size={19} />
          </button>
        </div>
      </header>

      <section className="content">
        {tab === "today" && (
          <div className="screen">
            <section className="hero-panel">
              <div>
                <p className="eyebrow">{formatDate(today)}</p>
                <div className="today-title-row">
                  <h1>{todayMeeting ? "오늘 모임" : "모임 없음"}</h1>
                  <button className="small-button primary today-refresh-button" disabled={busy} type="button" onClick={() => guarded(loadData, "업데이트했습니다.")}>
                    <RefreshCw size={18} />
                    업데이트
                  </button>
                </div>
              </div>
              <span className={classNames("attendance-badge", isPresent && "active")}>{isPresent ? "출석 중" : "미출석"}</span>
            </section>

            <div className="quick-actions">
              <button className="full-button primary" disabled={isPresent || busy} type="button" onClick={checkIn}>
                <CheckCircle2 size={19} />
                출석하기
              </button>
              <button className="full-button danger" disabled={!isPresent || busy} type="button" onClick={() => checkOut()}>
                <DoorOpen size={19} />
                퇴장하기
              </button>
            </div>

            <section className="summary-grid">
              <div className="metric">
                <span>오늘 출석</span>
                <strong>{todayAttendances.filter((row) => !row.checked_out_at).length}</strong>
              </div>
              <div className="metric">
                <span>진행 경기</span>
                <strong>{currentMatches.length}</strong>
              </div>
              <div className="metric">
                <span>내 승률</span>
                <strong>{formatRate(myStatsAll?.winRate ?? 0)}</strong>
              </div>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>내 경기</h2>
              </div>
              {myCurrentMatch ? renderMatchCard(myCurrentMatch) : <p className="empty">진행 중인 내 경기가 없습니다.</p>}
              {myNextMatch ? renderMatchCard(myNextMatch) : <p className="empty">예정된 내 경기가 없습니다.</p>}
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>진행 중 다른 경기</h2>
              </div>
              {otherCurrentMatches.length ? (
                otherCurrentMatches.map((match) => renderMatchCard(match, false))
              ) : (
                <p className="empty">진행 중인 다른 경기가 없습니다.</p>
              )}
            </section>
          </div>
        )}

        {tab === "draw" && (
          <div className="screen">
            <div className="section-head">
              <div>
                <p className="eyebrow">{todayMeeting ? formatDate(todayMeeting.meeting_date) : formatDate(today)}</p>
                <h1>대진표</h1>
              </div>
              {isAdmin && (
                <button className="small-button primary" disabled={!todayMeeting || busy} type="button" onClick={createDraw}>
                  <ListChecks size={16} />
                  생성
                </button>
              )}
            </div>
            {todayMatches.length ? todayMatches.map((match) => renderMatchCard(match, true)) : <p className="empty large">오늘 생성된 대진이 없습니다.</p>}
          </div>
        )}

        {tab === "results" && (
          <div className="screen">
            <div className="section-head">
              <div>
                <p className="eyebrow">공용 조회</p>
                <h1>모임 결과</h1>
              </div>
            </div>

            <section className="panel">
              <label>
                모임 날짜 선택
                <select value={selectedResultMeetingId} onChange={(event) => setResultMeetingId(event.target.value)}>
                  {meetings.length ? (
                    meetings.map((meeting) => (
                      <option key={meeting.id} value={meeting.id}>
                        {formatDate(meeting.meeting_date)}
                      </option>
                    ))
                  ) : (
                    <option value="">모임 기록 없음</option>
                  )}
                </select>
              </label>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>{formatDate(meetingDateById.get(selectedResultMeetingId) ?? "")}</h2>
                <span className="count-chip">{resultMatches.length}</span>
              </div>
              {resultMatches.length ? (
                <div className="ranking-list">
                  {resultMatches.map((match) => {
                    const teamA = matchTeam(match.id, "A");
                    const teamB = matchTeam(match.id, "B");
                    const minutes = elapsedMinutes(match.started_at, match.ended_at);

                    return (
                      <article className="match-card" key={match.id}>
                        <div className="match-head">
                          <div>
                            <span className="eyebrow">코트 {courtName(match.court_number)}</span>
                            <h3>라운드 {match.round_number}</h3>
                          </div>
                          <div className="match-head-actions">
                            <span className={classNames("status-pill", "finished")}>종료</span>
                            {isAdmin && (
                              <button
                                className="icon-button danger"
                                disabled={busy}
                                title="경기 기록 삭제"
                                type="button"
                                onClick={() => deleteMatchRecord(match)}
                              >
                                <Trash2 size={17} />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="teams">
                          <div className="team-row">
                            <span>A</span>
                            <strong>{names(teamA)}</strong>
                          </div>
                          <div className="team-row">
                            <span>B</span>
                            <strong>{names(teamB)}</strong>
                          </div>
                        </div>

                        <div className="score-line">
                          <strong>
                            {match.team_a_score} : {match.team_b_score}
                          </strong>
                          <span>{winnerLabel(match.winner_team)} 승</span>
                        </div>

                        <div className="match-meta">
                          <span>시작 {formatTime(match.started_at)}</span>
                          <span>종료 {formatTime(match.ended_at)}</span>
                          <span>{minutes === null ? "소요 -" : `${minutes}분`}</span>
                        </div>

                        {isAdmin && (
                          <ResultForm
                            disabled={busy}
                            match={match}
                            onSave={(targetMatch, teamAScore, teamBScore) =>
                              saveResult(targetMatch, teamAScore, teamBScore, { autoAssign: false })
                            }
                          />
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="empty">선택한 날짜에 기록된 경기 결과가 없습니다.</p>
              )}
            </section>
          </div>
        )}

        {tab === "ranking" && (
          <div className="screen">
            <div className="section-head">
              <div>
                <p className="eyebrow">
                  {rankingScope === "month" ? currentMonthKey() : rankingScope === "year" ? currentYearKey() : "누적"}
                </p>
                <h1>랭킹</h1>
              </div>
            </div>
            <div className="segmented compact">
              {(["month", "year", "all"] as RankingScope[]).map((scope) => (
                <button className={rankingScope === scope ? "active" : ""} key={scope} type="button" onClick={() => setRankingScope(scope)}>
                  {scopeLabels[scope]}
                </button>
              ))}
            </div>
            <div className="ranking-list">
              {rankingRows.map((row) => (
                <article className="ranking-row" key={row.memberId}>
                  <span className="rank-number">{row.rank}</span>
                  <div>
                    <strong>{row.name}</strong>
                    <small>{genderLabels[row.gender]}</small>
                  </div>
                  <div className="rank-stats">
                    <strong>{formatRate(row.winRate)}</strong>
                    <small>
                      {row.games}전 {row.wins}승 {row.losses}패
                    </small>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}

        {tab === "me" && (
          <div className="screen">
            <section className="profile-panel">
              <div className="avatar">{profile.display_name.slice(0, 1)}</div>
              <div>
                <h1>{profile.display_name}</h1>
                <p className="muted">
                  {genderLabels[profile.gender]} · {roleLabels[profile.role]}
                </p>
              </div>
            </section>

            <section className="summary-grid">
              <div className="metric">
                <span>전체</span>
                <strong>{formatRate(myStatsAll?.winRate ?? 0)}</strong>
              </div>
              <div className="metric">
                <span>월간</span>
                <strong>{formatRate(myStatsMonth?.winRate ?? 0)}</strong>
              </div>
              <div className="metric">
                <span>연간</span>
                <strong>{formatRate(myStatsYear?.winRate ?? 0)}</strong>
              </div>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>내 전적</h2>
              </div>
              <div className="record-table">
                {[
                  ["전체", myStatsAll],
                  ["월간", myStatsMonth],
                  ["연간", myStatsYear]
                ].map(([label, stats]) => {
                  const row = stats as typeof myStatsAll;
                  return (
                    <div className="record-row" key={label as string}>
                      <span>{label as string}</span>
                      <strong>
                        {row?.games ?? 0}전 {row?.wins ?? 0}승 {row?.losses ?? 0}패
                      </strong>
                      <span>{formatRate(row?.winRate ?? 0)}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <button className="full-button" type="button" onClick={() => setProfile({ ...profile, must_change_password: true })}>
              <KeyRound size={18} />
              비밀번호 변경
            </button>
          </div>
        )}

        {tab === "admin" && isAdmin && (
          <div className="screen">
            <div className="section-head">
              <div>
                <p className="eyebrow">관리자</p>
                <h1>오늘 운영</h1>
              </div>
            </div>

            <div className="admin-actions">
              <button className="full-button primary" disabled={busy} type="button" onClick={createTodayMeeting}>
                <CalendarPlus size={18} />
                모임 생성
              </button>
              <button className="full-button" disabled={!todayMeeting || busy} type="button" onClick={createDraw}>
                <ClipboardList size={18} />
                대진 생성
              </button>
            </div>

            <section className="panel">
              <div className="section-head">
                <h2>회원 출석/퇴장</h2>
                <span className="count-chip">{todayAttendances.filter((row) => !row.checked_out_at).length}</span>
              </div>
              <div className="member-list">
                {profiles.map((member) => {
                  const latestAttendance = todayLatestAttendanceByMemberId.get(member.id);
                  const isCheckedIn = todayActiveAttendanceByMemberId.has(member.id);

                  return (
                    <article className="member-card" key={member.id}>
                      <div className="member-status-row">
                        <div>
                          <strong>{member.display_name}</strong>
                          <small>
                            {isCheckedIn
                              ? `출석 ${formatTime(latestAttendance?.checked_in_at)}`
                              : latestAttendance?.checked_out_at
                                ? `최근 퇴장 ${formatTime(latestAttendance.checked_out_at)}`
                                : "오늘 출석 기록 없음"}
                          </small>
                        </div>
                        <span className={classNames("status-pill", isCheckedIn && "in_progress")}>
                          {isCheckedIn ? "출석 중" : latestAttendance?.checked_out_at ? "퇴장 완료" : "미출석"}
                        </span>
                      </div>
                      <div className="member-attendance-actions">
                        <button
                          className="small-button primary"
                          disabled={busy || isCheckedIn}
                          type="button"
                          onClick={() => setMemberAttendance(member, "check-in")}
                        >
                          <CheckCircle2 size={16} />
                          출석
                        </button>
                        <button
                          className="small-button danger"
                          disabled={busy || !isCheckedIn}
                          type="button"
                          onClick={() => setMemberAttendance(member, "check-out")}
                        >
                          <DoorOpen size={16} />
                          퇴장
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "members" && isAdmin && (
          <div className="screen">
            <div className="section-head">
              <div>
                <p className="eyebrow">관리자</p>
                <h1>회원 관리</h1>
              </div>
            </div>

            <section className="panel">
              <div className="section-head">
                <h2>회원 추가</h2>
              </div>
              <div className="segmented compact">
                <button
                  className={newMemberDraft.kind === "member" ? "active" : ""}
                  type="button"
                  onClick={() => setNewMemberDraft((draft) => ({ ...draft, kind: "member", seedWinRate: 50 }))}
                >
                  정회원
                </button>
                <button
                  className={newMemberDraft.kind === "guest" ? "active" : ""}
                  type="button"
                  onClick={() => setNewMemberDraft((draft) => ({ ...draft, kind: "guest" }))}
                >
                  게스트
                </button>
                <button className="active" disabled type="button">
                  {newMemberDraft.kind === "guest" ? (todayMeeting ? "당일 모임 확인됨" : "당일 모임 필요") : "일반 등록"}
                </button>
              </div>
              <div className="member-form">
                <label>
                  이름
                  <input
                    value={newMemberDraft.displayName}
                    onChange={(event) =>
                      setNewMemberDraft((draft) => ({
                        ...draft,
                        displayName: event.target.value
                      }))
                    }
                  />
                </label>
                <label>
                  전화번호
                  <input
                    inputMode="tel"
                    value={newMemberDraft.phone}
                    onChange={(event) =>
                      setNewMemberDraft((draft) => ({
                        ...draft,
                        phone: event.target.value
                      }))
                    }
                  />
                </label>
                {newMemberDraft.kind === "member" ? (
                  <label>
                    로그인 아이디
                    <input
                      placeholder={newMemberDraft.displayName || "이름"}
                      value={newMemberDraft.loginId}
                      onChange={(event) =>
                        setNewMemberDraft((draft) => ({
                          ...draft,
                          loginId: event.target.value
                        }))
                      }
                    />
                  </label>
                ) : (
                  <label>
                    게스트 기준 승률 (%)
                    <input
                      inputMode="decimal"
                      max={100}
                      min={0}
                      step={0.1}
                      type="number"
                      value={newMemberDraft.seedWinRate}
                      onChange={(event) =>
                        setNewMemberDraft((draft) => ({
                          ...draft,
                          seedWinRate: Number(event.target.value)
                        }))
                      }
                    />
                  </label>
                )}
                <label>
                  성별
                  <select
                    value={newMemberDraft.gender}
                    onChange={(event) =>
                      setNewMemberDraft((draft) => ({
                        ...draft,
                        gender: event.target.value as Gender
                      }))
                    }
                  >
                    <option value="male">남성</option>
                    <option value="female">여성</option>
                    <option value="other">기타</option>
                  </select>
                </label>
              </div>
              <button className="full-button primary" disabled={busy || (newMemberDraft.kind === "guest" && !todayMeeting)} type="button" onClick={createMember}>
                <UserPlus size={18} />
                {newMemberDraft.kind === "guest" ? "게스트 추가" : "회원 추가"}
              </button>
              {newMemberDraft.kind === "guest" && !todayMeeting && (
                <p className="helper-text">당일 모임이 생성된 상태에서만 게스트를 추가할 수 있습니다.</p>
              )}
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>회원 목록</h2>
                <span className="count-chip">{regularProfiles.length}</span>
              </div>
              <div className="member-list">
                {regularProfiles.map((member) => {
                  const draft = memberDrafts[member.id] ?? {
                    display_name: member.display_name,
                    phone: member.phone,
                    gender: member.gender,
                    role: member.role,
                    seed_win_rate: member.seed_win_rate
                  };
                  const nextRole = member.role === "admin" ? "member" : "admin";

                  return (
                    <article className="member-card" key={member.id}>
                      <div className="section-head">
                        <h3>회원</h3>
                      </div>
                      <div className="member-form">
                        <label>
                          이름
                          <input
                            value={draft.display_name}
                            onChange={(event) =>
                              setMemberDrafts((rows) => ({
                                ...rows,
                                [member.id]: { ...draft, display_name: event.target.value }
                              }))
                            }
                          />
                        </label>
                        <label>
                          전화번호
                          <input
                            inputMode="tel"
                            value={draft.phone}
                            onChange={(event) =>
                              setMemberDrafts((rows) => ({
                                ...rows,
                                [member.id]: { ...draft, phone: event.target.value }
                              }))
                            }
                          />
                        </label>
                        <label>
                          성별
                          <select
                            value={draft.gender}
                            onChange={(event) =>
                              setMemberDrafts((rows) => ({
                                ...rows,
                                [member.id]: { ...draft, gender: event.target.value as Gender }
                              }))
                            }
                          >
                            <option value="male">남성</option>
                            <option value="female">여성</option>
                            <option value="other">기타</option>
                          </select>
                        </label>
                        <label>
                          권한
                          <select
                            value={draft.role}
                            onChange={(event) =>
                              setMemberDrafts((rows) => ({
                                ...rows,
                                [member.id]: { ...draft, role: event.target.value as Role }
                              }))
                            }
                          >
                            <option value="member">회원</option>
                            <option value="admin">관리자</option>
                          </select>
                        </label>
                        <label>
                          기준 승률 (%)
                          <input
                            inputMode="decimal"
                            max={100}
                            min={0}
                            step={0.1}
                            type="number"
                            value={draft.seed_win_rate}
                            onChange={(event) =>
                              setMemberDrafts((rows) => ({
                                ...rows,
                                [member.id]: { ...draft, seed_win_rate: Number(event.target.value) }
                              }))
                            }
                          />
                        </label>
                      </div>

                      <div className="member-actions">
                        <button className="icon-button primary" disabled={busy} title="저장" type="button" onClick={() => updateMember(member.id)}>
                          <Save size={17} />
                        </button>
                        <button className="icon-button" disabled={busy} title="비밀번호 초기화" type="button" onClick={() => resetPassword(member.id)}>
                          <RotateCcw size={17} />
                        </button>
                        <button
                          className={classNames("icon-button", member.role === "admin" ? "danger" : "primary")}
                          disabled={busy || (member.id === profile?.id && member.role === "admin")}
                          title={member.role === "admin" ? "관리자 권한 삭제" : "관리자 권한 부여"}
                          type="button"
                          onClick={() => setMemberRole(member, nextRole)}
                        >
                          {member.role === "admin" ? <User size={17} /> : <Shield size={17} />}
                        </button>
                        <button className="icon-button danger" disabled={busy} title="삭제" type="button" onClick={() => deleteMember(member.id)}>
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "monitor" && isAdmin && (
          <div className="screen">
            <div className="section-head">
              <div>
                <p className="eyebrow">관리자</p>
                <h1>코트 진행 · 전체 결과</h1>
              </div>
            </div>

            <section className="panel">
              <div className="section-head">
                <h2>코트별 진행 상황</h2>
              </div>

              <div className="test-court-grid">
                {courtProgressRows.map((row) => {
                  const match = row.inProgressMatch ?? row.nextScheduledMatch;
                  const teamA = match ? matchTeam(match.id, "A") : [];
                  const teamB = match ? matchTeam(match.id, "B") : [];
                  const canStart = Boolean(match && match.status === "scheduled" && availableCourtNumbers.includes(match.court_number));
                  const canFinish = Boolean(match && match.status === "in_progress" && !match.ended_at);
                  const canRecordResult = Boolean(match && match.ended_at && match.team_a_score === null && match.team_b_score === null);

                  return (
                    <article className="test-court-card" key={row.courtNumber}>
                      <div className="match-head">
                        <div>
                          <p className="eyebrow">코트 {courtName(row.courtNumber)}</p>
                          <h3>{row.inProgressMatch ? "진행 중" : row.nextScheduledMatch ? "대기 경기" : "배정 없음"}</h3>
                        </div>
                        <span className={classNames("status-pill", match?.status)}>{match ? matchDisplayStatus(match) : "비어 있음"}</span>
                      </div>

                      <div className="match-meta">
                        <span>총 {row.totalCount}경기</span>
                        <span>진행 {row.inProgressCount}</span>
                        <span>대기 {row.scheduledCount}</span>
                        <span>종료 {row.finishedCount}</span>
                      </div>

                      {match ? (
                        <>
                          <div className="teams">
                            <div className="team-row">
                              <span>A</span>
                              <strong>{names(teamA)}</strong>
                            </div>
                            <div className="team-row">
                              <span>B</span>
                              <strong>{names(teamB)}</strong>
                            </div>
                          </div>
                          <div className="match-meta">
                            <span>라운드 {match.round_number}</span>
                            <span>시작 {formatTime(match.started_at)}</span>
                            <span>종료 {formatTime(match.ended_at)}</span>
                          </div>
                          <div className="match-actions">
                            <button className="small-button" disabled={busy || !canStart} type="button" onClick={() => startMatch(match)}>
                              <Play size={16} />
                              시작
                            </button>
                            <button className="small-button" disabled={busy || !canFinish} type="button" onClick={() => finishMatch(match)}>
                              <StopCircle size={16} />
                              종료
                            </button>
                          </div>
                          {canRecordResult && <ResultForm disabled={busy} match={match} onSave={saveResult} />}
                        </>
                      ) : (
                        <p className="empty">현재 배정된 경기가 없습니다.</p>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>모든 경기 결과</h2>
                <div className="section-actions">
                  <span className="count-chip">{todayFinishedMatches.length}</span>
                  <button
                    className="small-button danger"
                    disabled={busy || allFinishedMatches.length === 0}
                    title="전체 경기 기록 삭제"
                    type="button"
                    onClick={deleteAllFinishedMatchRecords}
                  >
                    <Trash2 size={17} />
                    전체 삭제
                  </button>
                </div>
              </div>

              {todayFinishedMatches.length ? (
                <div className="ranking-list">
                  {todayFinishedMatches.map((match) => {
                    const teamA = matchTeam(match.id, "A");
                    const teamB = matchTeam(match.id, "B");
                    const minutes = elapsedMinutes(match.started_at, match.ended_at);

                    return (
                      <article className="match-card" key={match.id}>
                        <div className="match-head">
                          <div>
                            <span className="eyebrow">{formatDate(meetingDateById.get(match.meeting_id) ?? "")}</span>
                            <h3>
                              코트 {courtName(match.court_number)} · 라운드 {match.round_number}
                            </h3>
                          </div>
                          <div className="match-head-actions">
                            <span className={classNames("status-pill", "finished")}>종료</span>
                            <button
                              className="icon-button danger"
                              disabled={busy}
                              title="경기 기록 삭제"
                              type="button"
                              onClick={() => deleteMatchRecord(match)}
                            >
                              <Trash2 size={17} />
                            </button>
                          </div>
                        </div>

                        <div className="teams">
                          <div className="team-row">
                            <span>A</span>
                            <strong>{names(teamA)}</strong>
                          </div>
                          <div className="team-row">
                            <span>B</span>
                            <strong>{names(teamB)}</strong>
                          </div>
                        </div>

                        <div className="score-line">
                          <strong>
                            {match.team_a_score} : {match.team_b_score}
                          </strong>
                          <span>{winnerLabel(match.winner_team)} 승</span>
                        </div>

                        <div className="match-meta">
                          <span>시작 {formatTime(match.started_at)}</span>
                          <span>종료 {formatTime(match.ended_at)}</span>
                          <span>{minutes === null ? "소요 -" : `${minutes}분`}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="empty">기록된 경기 결과가 없습니다.</p>
              )}
            </section>
          </div>
        )}

        {tab === "test" && isAdmin && <TestConsole showToast={showToast} />}

        {tab === "courts" && isAdmin && (
          <CourtManagement
            courts={courts}
            busy={busy}
            tableReady={courtTableReady}
            onEndRental={endCourtRental}
            onStartRental={startCourtRental}
          />
        )}
      </section>

      <nav className="bottom-tabs">
        {[
          ["today", "오늘", Home],
          ["draw", "대진표", ListChecks],
          ["results", "결과", ClipboardList],
          ["ranking", "랭킹", Trophy],
          ["me", "내 정보", User]
        ].map(([key, label, Icon]) => {
          const TabIcon = Icon as typeof Home;
          return (
            <button className={tab === key ? "active" : ""} key={key as string} type="button" onClick={() => setTab(key as Tab)}>
              <TabIcon size={20} />
              <span>{label as string}</span>
            </button>
          );
        })}
      </nav>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
