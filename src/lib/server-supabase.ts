import { createClient } from "@supabase/supabase-js";

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function createAdminClient() {
  return createClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export function createUserClient(accessToken: string) {
  return createClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export async function requireAdmin(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) {
    return { ok: false as const, status: 401, message: "로그인이 필요합니다." };
  }

  const admin = createAdminClient();
  const userClient = createUserClient(token);
  const {
    data: { user },
    error
  } = await userClient.auth.getUser();

  if (error || !user) {
    return { ok: false as const, status: 401, message: "세션을 확인할 수 없습니다." };
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (profileError || profile?.role !== "admin") {
    return { ok: false as const, status: 403, message: "관리자 권한이 필요합니다." };
  }

  return { ok: true as const, admin, user };
}

export async function requireUser(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) {
    return { ok: false as const, status: 401, message: "로그인이 필요합니다." };
  }

  const admin = createAdminClient();
  const userClient = createUserClient(token);
  const {
    data: { user },
    error
  } = await userClient.auth.getUser();

  if (error || !user) {
    return { ok: false as const, status: 401, message: "세션을 확인할 수 없습니다." };
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return { ok: false as const, status: 403, message: "회원 정보를 확인할 수 없습니다." };
  }

  return { ok: true as const, admin, user, profile };
}
