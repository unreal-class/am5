import { NextResponse } from "next/server";
import { DEFAULT_PASSWORD } from "@/lib/models";
import { requireAdmin } from "@/lib/server-supabase";

export async function POST(request: Request) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const body = await request.json();
  const memberId = String(body.memberId ?? "");

  if (!memberId) {
    return NextResponse.json({ message: "회원 ID가 필요합니다." }, { status: 400 });
  }

  const { error: authError } = await gate.admin.auth.admin.updateUserById(memberId, {
    password: DEFAULT_PASSWORD
  });

  if (authError) {
    return NextResponse.json({ message: authError.message }, { status: 400 });
  }

  const { error: profileError } = await gate.admin
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", memberId);

  if (profileError) {
    return NextResponse.json({ message: profileError.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
