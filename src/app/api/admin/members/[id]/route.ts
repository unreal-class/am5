import { NextResponse } from "next/server";
import type { Gender, Role } from "@/lib/models";
import { requireAdmin } from "@/lib/server-supabase";

const genders = new Set(["male", "female", "other"]);
const roles = new Set(["member", "admin"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const { id } = await context.params;

  if (!id) {
    return NextResponse.json({ message: "회원 ID가 필요합니다." }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const updates: {
    display_name?: string;
    phone?: string;
    gender?: Gender;
    role?: Role;
    seed_win_rate?: number;
  } = {};

  if ("display_name" in body) {
    const displayName = String(body.display_name ?? "").trim();

    if (!displayName) {
      return NextResponse.json({ message: "회원 이름을 입력해주세요." }, { status: 400 });
    }

    updates.display_name = displayName;
  }

  if ("phone" in body) {
    const phone = String(body.phone ?? "").trim();

    if (!phone) {
      return NextResponse.json({ message: "전화번호를 입력해주세요." }, { status: 400 });
    }

    updates.phone = phone;
  }

  if ("gender" in body) {
    const gender = String(body.gender ?? "");

    if (!genders.has(gender)) {
      return NextResponse.json({ message: "성별 값이 올바르지 않습니다." }, { status: 400 });
    }

    updates.gender = gender as Gender;
  }

  if ("role" in body) {
    const role = String(body.role ?? "");

    if (!roles.has(role)) {
      return NextResponse.json({ message: "권한 값이 올바르지 않습니다." }, { status: 400 });
    }

    if (id === gate.user.id && role !== "admin") {
      return NextResponse.json({ message: "본인의 관리자 권한은 삭제할 수 없습니다." }, { status: 400 });
    }

    updates.role = role as Role;
  }

  if ("seed_win_rate" in body) {
    const seedWinRate = Number(body.seed_win_rate);

    if (!Number.isFinite(seedWinRate) || seedWinRate < 0 || seedWinRate > 100) {
      return NextResponse.json({ message: "기준 승률은 0~100 사이 값이어야 합니다." }, { status: 400 });
    }

    updates.seed_win_rate = seedWinRate;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ message: "변경할 회원 정보가 없습니다." }, { status: 400 });
  }

  const { data, error } = await gate.admin
    .from("profiles")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !data) {
    return NextResponse.json({ message: error?.message ?? "회원 정보를 저장하지 못했습니다." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, profile: data });
}

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
