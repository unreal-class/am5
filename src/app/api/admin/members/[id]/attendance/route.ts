import { NextResponse } from "next/server";
import { autoAssignMatches, checkoutMemberAndReassign, type AssignedMatchSummary } from "@/lib/server-matchmaker";
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

    try {
      const result = await checkoutMemberAndReassign({
        admin: gate.admin,
        meetingId: meeting.id,
        memberId: id,
        currentUserId: id
      });

      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return NextResponse.json({ message: error instanceof Error ? error.message : "퇴장 처리에 실패했습니다." }, { status: 400 });
    }
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
