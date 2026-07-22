import { execFileSync } from "node:child_process";
import process from "node:process";

function supabaseStatus() {
  return JSON.parse(
    execFileSync("pnpm", ["exec", "supabase", "status", "-o", "json"], {
      encoding: "utf8",
    }),
  );
}

export function resolveConfig({ needSecret = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const publishableKey =
    process.env.PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  let status;
  if (!url || !publishableKey || (needSecret && !secretKey)) {
    status = supabaseStatus();
  }

  const baseUrl = (url ?? status.API_URL).replace(/\/$/, "");
  return {
    baseUrl,
    authUrl: `${baseUrl}/auth/v1`,
    restUrl: `${baseUrl}/rest/v1`,
    mcpUrl: `${baseUrl}/functions/v1/mcp`,
    publishableKey: publishableKey ?? status.PUBLISHABLE_KEY,
    secretKey:
      secretKey ?? status?.SECRET_KEY ?? status?.SERVICE_ROLE_KEY ?? undefined,
  };
}

export function userCredentials() {
  const email = process.env.SUPABASE_USER_EMAIL;
  const password = process.env.SUPABASE_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Set SUPABASE_USER_EMAIL and SUPABASE_USER_PASSWORD for the single app user",
    );
  }
  return { email, password };
}

export async function signIn({ authUrl, publishableKey }, { email, password }) {
  const response = await fetch(`${authUrl}/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Sign-in failed: ${response.status} ${body}`);
  }
  const accessToken = JSON.parse(body).access_token;
  if (!accessToken) throw new Error(`Sign-in returned no access_token: ${body}`);
  return accessToken;
}

export function authHeaders({ publishableKey }, accessToken) {
  return { apikey: publishableKey, Authorization: `Bearer ${accessToken}` };
}
