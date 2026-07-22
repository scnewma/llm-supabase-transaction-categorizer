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

const DEFAULT_INPUT = "local/testdata/transactions-100.csv";
const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_MODEL = "local-model";
const MCP_TOOL_NAME = "transaction_categorizer_fetch_similar_transactions";
const MCP_SERVER_TOOL_NAME = "fetch_similar_transactions";

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    matchCount: 5,
    baseURL: process.env.LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.LMSTUDIO_MODEL ?? DEFAULT_MODEL,
    promptPath: process.env.SYSTEM_PROMPT_PATH ?? "local/system_prompt.md",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--match-count") args.matchCount = Number(argv[++i]);
    else if (arg === "--model" || arg === "-m") args.model = argv[++i];
    else if (arg === "--base-url") args.baseURL = argv[++i];
    else if (arg === "--prompt") args.promptPath = argv[++i];
    else if (arg === "--no-similarity-search") throw new Error("--no-similarity-search is no longer supported; the model must call the MCP tool");
    else if (!arg.startsWith("-") && args.input === DEFAULT_INPUT) args.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  console.error(`Usage:
  node scripts/evaluate_mcp.mjs [input.csv] --model <model> [options]

Options:
  -m, --model <name>        LM Studio model name. Default: ${DEFAULT_MODEL}
      --base-url <url>      LM Studio OpenAI-compatible base URL. Default: ${DEFAULT_BASE_URL}
      --match-count <n>     Similar MCP examples the model should request. Default: 5
      --prompt <path>       System prompt file. Default: local/system_prompt.md

Load examples first with scripts/load_transactions_mcp.mjs.

Required environment variables:
  SUPABASE_USER_EMAIL
  SUPABASE_USER_PASSWORD

Environment overrides:
  LMSTUDIO_BASE_URL
  LMSTUDIO_MODEL
  SYSTEM_PROMPT_PATH
  SUPABASE_URL
  PUBLISHABLE_KEY
`);
}

async function loadSystemPrompt(promptPath) {
  const prompt = await fs.readFile(promptPath, "utf8");
  return prompt.replace(/\n## Examples\n[\s\S]*$/u, "").trim();
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
  return message.result;
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

function transactionText(row, matchCount) {
  return `Call ${MCP_TOOL_NAME} with payee ${JSON.stringify(row.payee)}, notes ${JSON.stringify(row.notes)}, amount ${Number(row.amount)}, match_count ${matchCount}. Then ignore exact duplicates from the tool result and categorize this transaction: Account: ${row.account}; Payee: ${row.payee}; Amount: ${row.amount}; Date: ${row.date}; Notes: ${row.notes}. Return only the final category name. If the best category is Uncategorized, return an empty string.`;
}

function evaluatorPrompt(systemPrompt) {
  return `If the user asks to categorize a transaction, first call ${MCP_TOOL_NAME} using the transaction payee, notes, amount, and match_count. Do not output text before this tool call. After the tool result, answer with only the category name.\n\n${systemPrompt}`;
}

function toolSchema() {
  return [{
    type: "function",
    function: {
      name: MCP_TOOL_NAME,
      description: "Search for transactions similar to the provided fields.",
      parameters: {
        type: "object",
        properties: {
          payee: { type: "string" },
          notes: { type: "string" },
          amount: { type: "number" },
          match_count: { type: "integer", exclusiveMinimum: 0, maximum: 50 },
        },
        required: ["payee", "notes", "amount"],
      },
    },
  }];
}

async function chat({ baseURL, model }, messages, tools, toolChoice) {
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY ?? "lm-studio"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, temperature: 0, messages, tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body}`);
  return JSON.parse(body).choices?.[0]?.message;
}

async function complete(args, config, systemPrompt, row) {
  const messages = [
    { role: "system", content: evaluatorPrompt(systemPrompt) },
    { role: "user", content: transactionText(row, args.matchCount) },
  ];

  const assistant = await chat(args, messages, toolSchema(), "required");
  const toolCalls = assistant?.tool_calls ?? [];
  if (toolCalls.length !== 1 || toolCalls[0].function?.name !== MCP_TOOL_NAME) {
    throw new Error(`model called ${MCP_TOOL_NAME} ${toolCalls.length} times for ${row.payee}; expected exactly once`);
  }

  const toolCall = toolCalls[0];
  const toolArgs = JSON.parse(toolCall.function.arguments || "{}");
  const result = await mcpRequest(config, 2, "tools/call", {
    name: MCP_SERVER_TOOL_NAME,
    arguments: toolArgs,
  });

  const final = await chat(args, [
    ...messages,
    assistant,
    { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) },
  ]);

  return normalizeCategory(final?.content ?? "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const baseConfig = resolveConfig();
  const accessToken = await signIn(baseConfig, userCredentials());
  const config = { mcpUrl: baseConfig.mcpUrl, config: baseConfig, accessToken };
  await mcpRequest(config, 1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "evaluate-mcp", version: "0.1.0" },
  });

  const systemPrompt = await loadSystemPrompt(args.promptPath);
  const rows = parse(await fs.readFile(args.input, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  console.log(`Loaded ${rows.length} rows from ${args.input}`);

  let correct = 0;
  let total = 0;
  let skipped = 0;
  for (const row of rows) {
    if (shouldSkipEvaluation(row)) {
      skipped += 1;
      continue;
    }

    total += 1;
    const guessed = await complete(args, config, systemPrompt, row);
    const wanted = normalizeCategory(row.category);

    if (guessed === wanted) correct += 1;
    else {
      console.log(transactionText(row, args.matchCount));
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
