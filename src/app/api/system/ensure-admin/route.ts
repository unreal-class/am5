import { NextResponse } from "next/server";
import { loginIdToEmail } from "@/lib/auth-id";
import { ADMIN_DISPLAY_NAME, ADMIN_LOGIN_ID, DEFAULT_PASSWORD } from "@/lib/models";
import { createAdminClient } from "@/lib/server-supabase";

export async function POST() {
  try {
    const admin = createAdminClient();
    const { data: existingProfile, error: lookupError } = await admin
      .from("profiles")
      .select("id, role")
      .eq("login_id", ADMIN_LOGIN_ID)
      .maybeSingle();

    if (lookupError) {
      return NextResponse.json({ message: lookupError.message }, { status: 400 });
    }

    if (existingProfile) {
      if (existingProfile.role !== "admin") {
        const { error: updateError } = await admin
          .from("profiles")
          .update({ role: "admin" })
          .eq("id", existingProfile.id);

        if (updateError) {
          return NextResponse.json({ message: updateError.message }, { status: 400 });
        }
      }

      return NextResponse.json({ ok: true, created: false });
    }

    const { data, error } = await admin.auth.admin.createUser({
      email: loginIdToEmail(ADMIN_LOGIN_ID),
      password: DEFAULT_PASSWORD,
      email_confirm: true,
      user_metadata: {
        display_name: ADMIN_DISPLAY_NAME,
        login_id: ADMIN_LOGIN_ID,
        phone: "000-0000-0000",
        gender: "other"
      }
    });

    if (error || !data.user) {
      return NextResponse.json({ message: error?.message ?? "관리자 계정 생성에 실패했습니다." }, { status: 400 });
    }

    const { error: profileError } = await admin.from("profiles").insert({
      id: data.user.id,
      login_id: ADMIN_LOGIN_ID,
      display_name: ADMIN_DISPLAY_NAME,
      phone: "000-0000-0000",
      gender: "other",
      role: "admin",
      must_change_password: true
    });

    if (profileError) {
      await admin.auth.admin.deleteUser(data.user.id);
      return NextResponse.json({ message: profileError.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, created: true });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "관리자 계정 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
