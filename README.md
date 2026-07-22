# Transaction Categorizer

Use LLM + Supabase Vector Search to automatically categorize personal transactions based on previous transaction history. This only supports an evaluation mode right now, it's not hooked up to any budget tooling in particular.

Runs an `mcp` server using [edge-function-mcp-sandbox](https://github.com/gregnr/edge-function-mcp-sandbox/tree/main) in `supabase functions` that exposes two tools:

- `store_transaction_example` - Compute an embedding for the transaction and store in in the database.
- `fetch_similar_transactions` - Search the database for similar transactions using the transaction details to do a vector similarity search on the embeddings, weighted with a custom "transaction amount similarity".

The transaction data is fed into a prompt that runs against LM Studio's OpenAI-compatible API. During evaluation, the model is given the MCP tool schema, chooses the tool call, and the script executes that MCP call against the Supabase function. For my testing, I ran `gemma-4-e4b-it` in LM Studio.

## Results

In testing with my transaction data, the LLM was able to guess **79/80 transactions** correctly. (Note: I skip Amazon/Walmart/Costco transactions due to not having extra transaction context for what was purchased at these "everything stores".)

```sh
❯ node scripts/evaluate_mcp.mjs
Loaded 100 rows from local/testdata/transactions-100.csv

Account: REDACTED
Payee: Circle K
Amount: -51.58
Date: 2026-05-05
Notes: AplPay CIRCLE K

Similar labeled transactions from the Supabase MCP server (never includes this exact row):
- Similarity: 0.942; Payee: Michaels; Amount: -50.44; Notes: AplPay MICHAELS; Category: Spending Money
- Similarity: 0.933; Payee: REDACTED; Amount: -49.02; Notes: REDACTED; Category: Spending Money
Guessed Category: Spending Money
Want Category: Fuel & Parking

79/80 guessed correctly
Skipped 20 Walmart/Amazon transactions
```

## Usage

### Setup

Install dependencies and build the vendored MCP edge helper:

```sh
pnpm run setup
```

Run LM Studio with the OpenAI-compatible server enabled. By default, evaluation uses `http://localhost:1234/v1`; override with `LMSTUDIO_BASE_URL` or `--base-url`. Pass `--model` or set `LMSTUDIO_MODEL` to match the model loaded in LM Studio.

### Start Supabase

```sh
pnpm exec supabase start
pnpm exec supabase functions serve
```

### Authentication

This app runs as a single Supabase Auth user; the anonymous role has no access.
The loader and evaluator sign in with a user's email/password and send that
user's JWT to the MCP server and REST API.

Set the credentials (e.g. in `.envrc`, which is gitignored):

```sh
export SUPABASE_USER_EMAIL="me@example.com"
export SUPABASE_USER_PASSWORD="a-strong-password"
```

Create the user once (uses the local admin/secret key; idempotent):

```sh
pnpm run create-user
```

### Try it with the example data

`testdata/transactions-1000.example.csv` and `prompts/system_prompt.example.md` are
committed to the repo so you can run the full pipeline without any real
transaction history.

> **Note:** These example files are AI-generated placeholder data for
> demonstration purposes only — they are not real transactions and not a real
> budget category setup. The CSV is produced deterministically by
> `scripts/generate_test_data.mjs`; regenerate it (or make a bigger one) with:
>
> ```sh
> pnpm run generate-test-data -- testdata/transactions-1000.example.csv
> ```

```sh
node scripts/load_transactions_mcp.mjs testdata/transactions-1000.example.csv --clear
node scripts/evaluate_mcp.mjs testdata/transactions-1000.example.csv --prompt prompts/system_prompt.example.md
```

### Load Transactions

Put private transaction CSVs under `local/testdata/`. Files in `local/` are ignored by git.

By default, the loader reads:

```txt
local/testdata/transactions-1000.csv
```

Load examples into Supabase:

```sh
node scripts/load_transactions_mcp.mjs --clear
```

Or pass a specific CSV:

```sh
node scripts/load_transactions_mcp.mjs local/testdata/my-transactions.csv --clear
```

`--clear` deletes existing rows from `public.transactions` before loading.

### Run evaluation

Create a private prompt file:

```sh
mkdir -p local
cp prompts/system_prompt.example.md local/system_prompt.md
```

Then edit `local/system_prompt.md` with your real category rules/examples. This file is ignored by git.

By default, evaluation reads:

```txt
local/testdata/transactions-100.csv
```

Common options:

```sh
node scripts/evaluate_mcp.mjs \
  local/testdata/transactions-100.csv \
  --model gemma-4-e4b-it \
  --match-count 5
```
