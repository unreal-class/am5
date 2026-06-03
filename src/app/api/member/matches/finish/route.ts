import { NextResponse } from "next/server";
import { requireUser } from "@/lib/server-supabase";

export async function POST(request: Request) {
  const gate = await requireUser(request);

  if (!gate.ok) {
    return NextResponse.json({ message: gate.message }, { status: gate.status });
  }

  const body = await request.json().catch(() => ({}));
  const matchId = String(body.matchId ?? "");

  if (!matchId) {
    return NextResponse.json({ message: "경기 ID가 필요합니다." }, { status: 400 });
  }

  const admin = gate.admin;
  const { data: participant, error: participantError } = await admin
    .from("match_players")
    .select("id")
    .eq("match_id", matchId)
    .eq("member_id", gate.user.id)
    .maybeSingle();

  if (participantError) {
    return NextResponse.json({ message: participantError.message }, { status: 400 });
  }

  if (!participant && gate.profile.role !== "admin") {
    return NextResponse.json({ message: "본인 참석 경기만 종료할 수 있습니다." }, { status: 403 });
  }

  const { error } = await admin
    .from("matches")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", matchId);

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
