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
    return NextResponse.json({ message: "배정된 경기의 참가자 또는 관리자만 시작할 수 있습니다." }, { status: 403 });
  }

  const { data: match, error: matchLookupError } = await admin
    .from("matches")
    .select("id, status, started_at, court_number")
    .eq("id", matchId)
    .single();

  if (matchLookupError || !match) {
    return NextResponse.json({ message: matchLookupError?.message ?? "경기를 확인할 수 없습니다." }, { status: 400 });
  }

  if (match.status === "in_progress" || match.started_at) {
    return NextResponse.json({ message: "이미 시작된 경기입니다." }, { status: 409 });
  }

  if (match.status !== "scheduled") {
    return NextResponse.json({ message: "예정 상태인 경기만 시작할 수 있습니다." }, { status: 400 });
  }

  const { data: availableCourt, error: courtLookupError } = await admin
    .from("courts")
    .select("court_number, is_available")
    .eq("court_number", match.court_number)
    .eq("is_available", true)
    .maybeSingle();

  if (courtLookupError) {
    return NextResponse.json({ message: courtLookupError.message }, { status: 400 });
  }

  if (!availableCourt) {
    return NextResponse.json({ message: "가용한 코트가 없어 경기를 시작할 수 없습니다." }, { status: 400 });
  }

  const { data: updatedMatch, error } = await admin
    .from("matches")
    .update({
      status: "in_progress",
      started_at: match.started_at ?? new Date().toISOString()
    })
    .eq("id", matchId)
    .eq("status", "scheduled")
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }

  if (!updatedMatch) {
    return NextResponse.json({ message: "이미 시작된 경기입니다." }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
