import { NextResponse } from "next/server";
import { checkoutMemberAndReassign } from "@/lib/server-matchmaker";
import { requireUser } from "@/lib/server-supabase";

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
      memberId: gate.user.id,
      currentUserId: gate.user.id
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "퇴장 처리에 실패했습니다." }, { status: 400 });
  }
}
