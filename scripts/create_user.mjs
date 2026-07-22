#!/usr/bin/env node
import process from "node:process";
import { resolveConfig, userCredentials } from "./auth.mjs";

function usage() {
  console.error(`Usage:
  node scripts/create_user.mjs

Creates the single application user via the Supabase admin API. Idempotent.

Required environment variables:
  SUPABASE_USER_EMAIL
  SUPABASE_USER_PASSWORD

Environment overrides:
  SUPABASE_URL
  SUPABASE_SECRET_KEY   (defaults to the local service_role/secret key)
`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  const config = resolveConfig({ needSecret: true });
  if (!config.secretKey) {
    throw new Error(
      "No secret key available. Set SUPABASE_SECRET_KEY or run `supabase start`.",
    );
  }
  const { email, password } = userCredentials();

  const response = await fetch(`${config.authUrl}/admin/users`, {
    method: "POST",
    headers: {
      apikey: config.secretKey,
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  const body = await response.text();
  if (response.ok) {
    console.log(`Created user ${email}`);
    return;
  }

  if (/already.*registered|already been registered|email_exists/i.test(body)) {
    console.log(`User ${email} already exists`);
    return;
  }

  throw new Error(`Failed to create user: ${response.status} ${body}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
