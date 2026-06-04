import { NextResponse } from "next/server";
import { loginIdToEmail, normalizeLoginId } from "@/lib/auth-id";
import { DEFAULT_PASSWORD, type Gender } from "@/lib/models";
import { requireAdmin } from "@/lib/server-supabase";

const genders = new Set(["male", "female", "other"]);

export async function POST(request: Request) {
  const gate = await requireAdmin(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const body = await request.json().catch(() => ({}));
  const displayName = String(body.displayName ?? "").trim();
  const isGuest = Boolean(body.isGuest);
  const phone = String(body.phone ?? "").trim() || (isGuest ? "게스트" : "");
  const gender = String(body.gender ?? "other") as Gender;
  const rawSeedWinRate = Number(body.seedWinRate ?? 50);
  const seedWinRate = Number.isFinite(rawSeedWinRate) ? Math.max(0, Math.min(100, rawSeedWinRate)) : Number.NaN;
  const todayMeetingId = String(body.todayMeetingId ?? "");
  const baseLoginId = isGuest
    ? normalizeLoginId(`guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    : normalizeLoginId(String(body.loginId ?? displayName));
  let loginId = baseLoginId;

  if (!displayName || !phone || !loginId || !genders.has(gender) || !Number.isFinite(seedWinRate)) {
    return NextResponse.json({ message: "이름, 전화번호, 성별을 확인해주세요." }, { status: 400 });
  }

  const admin = gate.admin;
  if (isGuest) {
    if (!todayMeetingId) {
      return NextResponse.json({ message: "당일 모임이 생성된 상태에서만 게스트를 추가할 수 있습니다." }, { status: 400 });
    }

    const today = new Date();
    const meetingDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const { data: meeting, error: meetingError } = await admin
      .from("meetings")
      .select("id, status")
      .eq("id", todayMeetingId)
      .eq("meeting_date", meetingDate)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ message: "당일 모임이 생성된 상태에서만 게스트를 추가할 수 있습니다." }, { status: 400 });
    }
  }

  const { data: existing, error: existingError } = await admin.from("profiles").select("id").eq("login_id", loginId).maybeSingle();

  if (existingError) {
    return NextResponse.json({ message: existingError.message }, { status: 400 });
  }

  if (existing && !isGuest) {
    return NextResponse.json({ message: "이미 사용 중인 로그인 아이디입니다." }, { status: 409 });
  }

  if (existing && isGuest) {
    loginId = normalizeLoginId(`guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
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
    return NextResponse.json({ message: error?.message ?? "회원 추가에 실패했습니다." }, { status: 400 });
  }

  const { error: profileError } = await admin.from("profiles").insert({
    id: data.user.id,
    login_id: loginId,
    display_name: displayName,
    phone,
    gender,
    role: "member",
    is_guest: isGuest,
    seed_win_rate: seedWinRate,
    must_change_password: true
  });

  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json({ message: profileError.message }, { status: 400 });
  }

  if (isGuest && todayMeetingId) {
    const { error: attendanceError } = await admin.from("attendances").insert({
      meeting_id: todayMeetingId,
      member_id: data.user.id,
      checked_in_at: new Date().toISOString()
    });

    if (attendanceError) {
      await admin.auth.admin.deleteUser(data.user.id);
      return NextResponse.json({ message: attendanceError.message }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true, memberId: data.user.id });
}