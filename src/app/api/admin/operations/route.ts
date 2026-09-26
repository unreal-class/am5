import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server-supabase";
import { autoAssignMatches } from "@/lib/server-matchmaker";

type Operation = "reassign" | "reset-and-reassign" | "close-meeting";

export async function POST(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ message: gate.message }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const meetingId = String(body.meetingId ?? "");
  const operation = String(body.operation ?? "") as Operation;
  if (!meetingId) return NextResponse.json({ message: "모임 ID가 필요합니다." }, { status: 400 });
  if (!["reassign", "reset-and-reassign", "close-meeting"].includes(operation)) {
    return NextResponse.json({ message: "경기 운영 작업이 올바르지 않습니다." }, { status: 400 });
  }

  if (operation === "close-meeting") {
    const { data, error } = await gate.admin.rpc("close_meeting_operations", { p_meeting_id: meetingId });
    if (error) return NextResponse.json({ message: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, ...data });
  }

  const { data: meeting, error: meetingError } = await gate.admin
    .from("meetings").select("id, status").eq("id", meetingId).maybeSingle();
  if (meetingError) return NextResponse.json({ message: meetingError.message }, { status: 400 });
  if (!meeting || meeting.status !== "active") {
    return NextResponse.json({ message: "진행 중인 모임만 재배정할 수 있습니다." }, { status: 400 });
  }

  let stoppedMatchCount = 0;
  if (operation === "reset-and-reassign") {
    const { data, error } = await gate.admin.rpc("reset_meeting_assignments", { p_meeting_id: meetingId });
    if (error) return NextResponse.json({ message: error.message }, { status: 400 });
    stoppedMatchCount = Number(data?.stoppedMatchCount ?? 0);
  }

  try {
    const assignedMatches = await autoAssignMatches({
      admin: gate.admin, meetingId, currentUserId: gate.user.id
    });
    return NextResponse.json({ ok: true, stoppedMatchCount, assignedMatches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "자동 재배정에 실패했습니다.";
    if (operation === "reset-and-reassign") {
      return NextResponse.json({ ok: true, stoppedMatchCount, assignedMatches: [], assignmentWarning: message });
    }
    return NextResponse.json({
      message,
      stoppedMatchCount
    }, { status: 400 });
  }
}
