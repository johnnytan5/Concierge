import type { NextConfig } from "next";
import path from "node:path";

// Local dev: the server-only keys (ASSEMBLYAI_API_KEY, OPENROUTER_API_KEY,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) live in the repo-root .env shared
// with the Python stack, so they are not copied into dashboard/.env.local.
// None are NEXT_PUBLIC_, so none reach the browser. On Vercel there is no
// ../.env; the project's env vars are used instead. Never overrides a var
// that is already set.
try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {
  // no repo-root .env (Vercel, or a dashboard-only checkout)
}

const nextConfig: NextConfig = {};

export default nextConfig;
