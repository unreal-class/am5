const LOGIN_DOMAIN = "am5.local";

export function normalizeLoginId(loginId: string) {
  return loginId.trim().replace(/\s+/g, "");
}

export function loginIdToEmail(loginId: string) {
  const normalized = normalizeLoginId(loginId);
  const bytes = new TextEncoder().encode(normalized);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `u_${encoded}@${LOGIN_DOMAIN}`;
}
