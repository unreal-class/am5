import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server-supabase";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const { id } = await context.params;

  if (!id) {
    return NextResponse.json({ message: "회원 ID가 필요합니다." }, { status: 400 });
  }

  const { error } = await gate.admin.auth.admin.deleteUser(id);

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
