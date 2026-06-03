import { NextResponse } from "next/server";
import { requireUser } from "@/lib/server-supabase";
import { autoAssignMatches, type AssignedMatchSummary } from "@/lib/server-matchmaker";

function validDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(request: Request) {
  const gate = await requireUser(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const body = await request.json().catch(() => ({}));
  const meetingDate = String(body.meetingDate ?? "");

  if (!validDateKey(meetingDate)) {
    return NextResponse.json({ message: "모임 날짜가 올바르지 않습니다." }, { status: 400 });
  }

  const admin = gate.admin;
  const now = new Date().toISOString();

  const { data: meeting, error: meetingError } = await admin
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
    return NextResponse.json({ message: meetingError?.message ?? "모임 생성에 실패했습니다." }, { status: 400 });
  }

  const { error: attendanceError } = await admin.from("attendances").upsert(
    {
      meeting_id: meeting.id,
      member_id: gate.user.id,
      checked_in_at: now,
      checked_out_at: null
    },
    { onConflict: "meeting_id,member_id" }
  );

  if (attendanceError) {
    return NextResponse.json({ message: attendanceError.message }, { status: 400 });
  }

  let assignedMatches: AssignedMatchSummary[] = [];

  let assignmentWarning: string | null = null;

  try {
    assignedMatches = await autoAssignMatches({
      admin,
      meetingId: meeting.id,
      currentUserId: gate.user.id
    });
  } catch (error) {
    assignmentWarning = error instanceof Error ? error.message : "자동 대진 생성에 실패했습니다.";
  }

  return NextResponse.json({
    ok: true,
    meetingCreated: true,
    assignmentWarning,
    assignedMatches
  });
}
