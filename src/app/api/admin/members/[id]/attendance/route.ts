import { NextResponse } from "next/server";
import { autoAssignMatches, type AssignedMatchSummary } from "@/lib/server-matchmaker";
import { requireAdmin } from "@/lib/server-supabase";

function validDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const meetingDate = String(body.meetingDate ?? "");

  if (!id) {
    return NextResponse.json({ message: "회원 ID가 필요합니다." }, { status: 400 });
  }

  if (action !== "check-in" && action !== "check-out") {
    return NextResponse.json({ message: "출석 또는 퇴장 작업을 선택해주세요." }, { status: 400 });
  }

  if (!validDateKey(meetingDate)) {
    return NextResponse.json({ message: "모임 날짜가 올바르지 않습니다." }, { status: 400 });
  }

  const { data: member, error: memberError } = await gate.admin
    .from("profiles")
    .select("id")
    .eq("id", id)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ message: memberError?.message ?? "회원을 찾을 수 없습니다." }, { status: 404 });
  }

  if (action === "check-out") {
    const { data: meeting, error: meetingError } = await gate.admin
      .from("meetings")
      .select("id")
      .eq("meeting_date", meetingDate)
      .maybeSingle();

    if (meetingError) {
      return NextResponse.json({ message: meetingError.message }, { status: 400 });
    }

    if (!meeting) {
      return NextResponse.json({ message: "오늘 모임이 아직 생성되지 않았습니다." }, { status: 400 });
    }

    const { data: activeMatches, error: activeMatchError } = await gate.admin
      .from("matches")
      .select("id")
      .eq("meeting_id", meeting.id)
      .in("status", ["scheduled", "in_progress"]);

    if (activeMatchError) {
      return NextResponse.json({ message: activeMatchError.message }, { status: 400 });
    }

    const activeMatchIds = (activeMatches ?? []).map((match) => match.id);

    if (activeMatchIds.length > 0) {
      const { data: activePlayer, error: activePlayerError } = await gate.admin
        .from("match_players")
        .select("id")
        .eq("member_id", id)
        .in("match_id", activeMatchIds)
        .limit(1)
        .maybeSingle();

      if (activePlayerError) {
        return NextResponse.json({ message: activePlayerError.message }, { status: 400 });
      }

      if (activePlayer) {
        return NextResponse.json({ message: "경기에 참여 중인 회원은 퇴장할 수 없습니다." }, { status: 400 });
      }
    }

    const { data: attendance, error: attendanceError } = await gate.admin
      .from("attendances")
      .update({ checked_out_at: new Date().toISOString() })
      .eq("meeting_id", meeting.id)
      .eq("member_id", id)
      .is("checked_out_at", null)
      .select("id")
      .maybeSingle();

    if (attendanceError) {
      return NextResponse.json({ message: attendanceError.message }, { status: 400 });
    }

    if (!attendance) {
      return NextResponse.json({ message: "출석 중인 회원이 아닙니다." }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  }

  const now = new Date().toISOString();
  const { data: meeting, error: meetingError } = await gate.admin
    .from("meetings")
    .upsert(
      {
        meeting_date: meetingDate,
        status: "active",
        created_by: gate.user.id
      },
      { onConflict: "meeting_date" }
    )
    .select("*")
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ message: meetingError?.message ?? "모임을 생성하지 못했습니다." }, { status: 400 });
  }

  const { data: activeAttendance, error: activeLookupError } = await gate.admin
    .from("attendances")
    .select("id")
    .eq("meeting_id", meeting.id)
    .eq("member_id", id)
    .is("checked_out_at", null)
    .maybeSingle();

  if (activeLookupError) {
    return NextResponse.json({ message: activeLookupError.message }, { status: 400 });
  }

  if (activeAttendance) {
    return NextResponse.json({ message: "이미 출석 중인 회원입니다." }, { status: 400 });
  }

  const { error: attendanceError } = await gate.admin.from("attendances").insert({
    meeting_id: meeting.id,
    member_id: id,
    checked_in_at: now,
    checked_out_at: null
  });

  if (attendanceError) {
    return NextResponse.json({ message: attendanceError.message }, { status: 400 });
  }

  let assignedMatches: AssignedMatchSummary[] = [];
  let assignmentWarning: string | null = null;

  try {
    assignedMatches = await autoAssignMatches({
      admin: gate.admin,
      meetingId: meeting.id,
      currentUserId: id
    });
  } catch (error) {
    assignmentWarning = error instanceof Error ? error.message : "자동 대진 생성에 실패했습니다.";
  }

  return NextResponse.json({ ok: true, assignedMatches, assignmentWarning });
}
