import { NextResponse } from "next/server";
import { requireUser } from "@/lib/server-supabase";

export async function POST(request: Request) {
  const gate = await requireUser(request);
  if (!gate.ok) return NextResponse.json({ message: gate.message }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const matchId = String(body.matchId ?? "");
  if (!matchId) return NextResponse.json({ message: "경기 ID가 필요합니다." }, { status: 400 });

  const { data: participant, error: participantError } = await gate.admin
    .from("match_players")
    .select("id")
    .eq("match_id", matchId)
    .eq("member_id", gate.user.id)
    .maybeSingle();

  if (participantError) return NextResponse.json({ message: participantError.message }, { status: 400 });
  if (!participant && gate.profile.role !== "admin") {
    return NextResponse.json({ message: "경기 참여자 또는 관리자만 팀을 재구성할 수 있습니다." }, { status: 403 });
  }

  const { data, error } = await gate.admin.rpc("reconfigure_match_teams", { p_match_id: matchId });
  if (error) return NextResponse.json({ message: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, pairingNumber: data?.pairingNumber ?? null });
}
