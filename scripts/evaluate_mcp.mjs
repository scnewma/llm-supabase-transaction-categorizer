#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";
import { parse } from "csv-parse/sync";

const DEFAULT_INPUT = "local/testdata/transactions-100.csv";
const DEFAULT_BASE_URL = "http://localhost:1234/v1";

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    matchCount: 5,
    similaritySearch: true,
    baseURL: process.env.LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.LMSTUDIO_MODEL ?? "local-model",
    promptPath: process.env.SYSTEM_PROMPT_PATH ?? "local/system_prompt.md",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--match-count") args.matchCount = Number(argv[++i]);
    else if (arg === "--model" || arg === "-m") args.model = argv[++i];
    else if (arg === "--base-url") args.baseURL = argv[++i];
    else if (arg === "--prompt") args.promptPath = argv[++i];
    else if (arg === "--no-similarity-search") args.similaritySearch = false;
    else if (!arg.startsWith("-") && args.input === DEFAULT_INPUT) args.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  console.error(`Usage:
  node scripts/evaluate_mcp.mjs [input.csv] --model <model> [options]

Options:
  -m, --model <name>        Model name. Default: local-model
      --base-url <url>      OpenAI-compatible base URL. Default: ${DEFAULT_BASE_URL}
      --match-count <n>     Similar MCP examples to include. Default: 5
      --prompt <path>       System prompt file. Default: local/system_prompt.md
      --no-similarity-search
                            Do not fetch/include Supabase MCP examples in the LLM prompt

Load examples first with scripts/load_transactions_mcp.mjs.

Environment overrides:
  LMSTUDIO_BASE_URL
  LMSTUDIO_MODEL
  LMSTUDIO_API_KEY
  SUPABASE_URL
  SUPABASE_PUBLISHABLE_KEY
  SYSTEM_PROMPT_PATH
`);
}

function supabaseStatus() {
  return JSON.parse(execFileSync("pnpm", ["exec", "supabase", "status", "-o", "json"], { encoding: "utf8" }));
}

function localConfig() {
  let status;
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !key) status = supabaseStatus();

  const baseUrl = (supabaseUrl ?? status.API_URL).replace(/\/$/, "");
  return {
    restUrl: `${baseUrl}/rest/v1`,
    mcpUrl: `${baseUrl}/functions/v1/mcp`,
    key: key ?? status.PUBLISHABLE_KEY,
  };
}

async function loadSystemPrompt(path) {
  return fs.readFile(path, "utf8");
}


function parseMcpBody(text) {
  const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines.join("\n") : text);
}

async function mcpRequest({ mcpUrl, key }, id, method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body}`);

  const message = parseMcpBody(body);
  if (message.error) throw new Error(JSON.stringify(message.error));
  return message.result;
}

function toolJson(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? JSON.stringify(result));
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function normalizeCategory(category) {
  if (category === "Two Month Buffer") return "2 Month Buffer";
  if (category === "Taxes/State refunds") return "Spending Money";
  if (category === "Uncategorized") return "";
  return category?.trim() ?? "";
}

function shouldSkipEvaluation(row) {
  const payee = row.payee.toLowerCase();
  return payee.includes("walmart") || payee.includes("amazon");
}

function sameTransaction(row, tx) {
  return tx.transaction_date === row.date &&
    tx.payee === row.payee &&
    tx.notes === row.notes &&
    Number(tx.amount) === Number(row.amount) &&
    normalizeCategory(tx.category) === normalizeCategory(row.category);
}

function transactionText(row, examples) {
  let item = "";
  item += `Account: ${row.account}\n`;
  item += `Payee: ${row.payee}\n`;
  item += `Amount: ${row.amount}\n`;
  item += `Date: ${row.date}\n`;
  item += `Notes: ${row.notes}`;

  if (examples.length > 0) {
    item += "\n\nSimilar labeled transactions from the Supabase MCP server (never includes this exact row):\n";
    item += examples
      .map((tx) => `- Similarity: ${Number(tx.similarity).toFixed(3)}; Payee: ${tx.payee}; Amount: ${tx.amount}; Notes: ${tx.notes}; Category: ${tx.category || "Uncategorized"}`)
      .join("\n");
  }

  return item;
}

async function complete({ baseURL, model }, systemPrompt, item) {
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY ?? "lm-studio"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: item },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body}`);
  const json = JSON.parse(body);
  return normalizeCategory(json.choices?.[0]?.message?.content ?? "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const config = localConfig();
  const systemPrompt = await loadSystemPrompt(args.promptPath);
  const rows = parse(await fs.readFile(args.input, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  console.log(`Loaded ${rows.length} rows from ${args.input}`);

  await mcpRequest(config, 1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "evaluate-mcp", version: "0.1.0" },
  });

  let requestId = 2;
  let correct = 0;
  let total = 0;
  let skipped = 0;
  for (const row of rows) {
    if (shouldSkipEvaluation(row)) {
      skipped += 1;
      continue;
    }

    total += 1;
    let examples = [];
    if (args.similaritySearch) {
      const result = await mcpRequest(config, requestId++, "tools/call", {
        name: "fetch_similar_transactions",
        arguments: {
          payee: row.payee,
          notes: row.notes,
          amount: Number(row.amount),
          match_count: args.matchCount,
        },
      });

      const { transactions } = toolJson(result);
      examples = transactions.filter((tx) => !sameTransaction(row, tx));
    }
    const item = transactionText(row, examples);
    const guessed = await complete(args, systemPrompt, item);
    const wanted = normalizeCategory(row.category);

    if (guessed === wanted) correct += 1;
    else {
      console.log(item);
      console.log("Guessed Category:", guessed);
      console.log("Want Category:", wanted);
      console.log();
    }
  }

  console.log(`${correct}/${total} guessed correctly`);
  if (skipped > 0) console.log(`Skipped ${skipped} Walmart/Amazon transactions`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
