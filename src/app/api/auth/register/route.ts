import { NextResponse } from "next/server";
import { loginIdToEmail, normalizeLoginId } from "@/lib/auth-id";
import { createAdminClient } from "@/lib/server-supabase";
import { DEFAULT_PASSWORD, type Gender } from "@/lib/models";

const genders = new Set(["male", "female", "other"]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const displayName = String(body.displayName ?? "").trim();
    const phone = String(body.phone ?? "").trim();
    const gender = String(body.gender ?? "other") as Gender;
    const loginId = normalizeLoginId(String(body.loginId ?? displayName));

    if (!displayName || !phone || !loginId || !genders.has(gender)) {
      return NextResponse.json({ message: "이름, 전화번호, 성별을 확인해주세요." }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: existing } = await admin.from("profiles").select("id").eq("login_id", loginId).maybeSingle();

    if (existing) {
      return NextResponse.json({ message: "이미 사용 중인 로그인 아이디입니다." }, { status: 409 });
    }

    const email = loginIdToEmail(loginId);
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: DEFAULT_PASSWORD,
      email_confirm: true,
      user_metadata: {
        display_name: displayName,
        login_id: loginId,
        phone,
        gender
      }
    });

    if (error || !data.user) {
      return NextResponse.json({ message: error?.message ?? "회원가입에 실패했습니다." }, { status: 400 });
    }

    const { error: profileError } = await admin.from("profiles").insert({
      id: data.user.id,
      login_id: loginId,
      display_name: displayName,
      phone,
      gender,
      role: "member",
      must_change_password: true
    });

    if (profileError) {
      await admin.auth.admin.deleteUser(data.user.id);
      return NextResponse.json({ message: profileError.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "회원가입 처리 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
