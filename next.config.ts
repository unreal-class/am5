import type { NextConfig } from "next";
import { execSync } from "node:child_process";

function lastCommitDate() {
  try {
    return execSync("git log -1 --format=%cd --date=format:%Y-%m-%d", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_LAST_COMMIT_DATE: lastCommitDate()
  },
  reactStrictMode: true
};

export default nextConfig;
