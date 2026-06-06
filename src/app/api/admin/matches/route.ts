import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server-supabase";

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const body = await request.json().catch(() => ({}));

  if (body.confirmAllFinishedMatches !== true) {
    return NextResponse.json({ message: "전체 경기 기록 삭제 확인이 필요합니다." }, { status: 400 });
  }

  const { count, error } = await gate.admin
    .from("matches")
    .delete({ count: "exact" })
    .eq("status", "finished")
    .not("team_a_score", "is", null)
    .not("team_b_score", "is", null);

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, deletedCount: count ?? 0 });
}
