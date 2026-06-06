import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server-supabase";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const { id } = await context.params;

  if (!id) {
    return NextResponse.json({ message: "경기 ID가 필요합니다." }, { status: 400 });
  }

  const { count, error } = await gate.admin
    .from("matches")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }

  if (!count) {
    return NextResponse.json({ message: "삭제할 경기 기록을 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, deletedCount: count });
}
