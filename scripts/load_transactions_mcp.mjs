#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { parse } from "csv-parse/sync";
import {
  authHeaders,
  resolveConfig,
  signIn,
  userCredentials,
} from "./auth.mjs";

const DEFAULT_INPUT = "local/testdata/transactions-1000.csv";

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, clear: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--clear") args.clear = true;
    else if (!arg.startsWith("-") && args.input === DEFAULT_INPUT) args.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.error(`Usage:
  node scripts/load_transactions_mcp.mjs [input.csv] [--clear]

Loads labeled CSV transactions into Supabase through the MCP server.

Required environment variables:
  SUPABASE_USER_EMAIL
  SUPABASE_USER_PASSWORD

Environment overrides:
  SUPABASE_URL
  SUPABASE_PUBLISHABLE_KEY
`);
}

async function restDeleteAll(config, accessToken) {
  const response = await fetch(`${config.restUrl}/transactions?id=not.is.null`, {
    method: "DELETE",
    headers: authHeaders(config, accessToken),
  });
  if (!response.ok) throw new Error(`Failed to clear transactions: ${response.status} ${await response.text()}`);
}

function parseMcpBody(text) {
  const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines.join("\n") : text);
}

async function mcpRequest({ mcpUrl, config, accessToken }, id, method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      ...authHeaders(config, accessToken),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body}`);
  const message = parseMcpBody(body);
  if (message.error) throw new Error(JSON.stringify(message.error));
  if (message.result?.isError) throw new Error(message.result.content?.[0]?.text ?? JSON.stringify(message.result));
  return message.result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const config = resolveConfig();
  const accessToken = await signIn(config, userCredentials());
  const mcp = { mcpUrl: config.mcpUrl, config, accessToken };

  const rows = parse(await fs.readFile(args.input, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const labeledRows = rows.filter((row) => row.category);
  console.log(`Loaded ${rows.length} rows from ${args.input}; ${labeledRows.length} labeled rows to store`);

  if (args.clear) {
    await restDeleteAll(config, accessToken);
    console.log("Cleared public.transactions");
  }

  await mcpRequest(mcp, 1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "load-transactions-mcp", version: "0.1.0" },
  });

  let requestId = 2;
  let stored = 0;
  for (const row of labeledRows) {
    await mcpRequest(mcp, requestId++, "tools/call", {
      name: "store_transaction_example",
      arguments: {
        date: row.date,
        payee: row.payee,
        notes: row.notes,
        category: row.category,
        amount: Number(row.amount),
      },
    });
    stored += 1;
    if (stored % 100 === 0) console.log(`Stored ${stored}/${labeledRows.length}`);
  }

  console.log(`Stored ${stored} transactions through MCP`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
