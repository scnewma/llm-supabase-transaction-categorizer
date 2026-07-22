#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_OUTPUT = "local/testdata/transactions-1000.csv";
const DEFAULT_COUNT = 1000;
const DEFAULT_SEED = 42;

// Small deterministic PRNG (mulberry32) so runs are reproducible with --seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const args = { output: DEFAULT_OUTPUT, count: DEFAULT_COUNT, seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--count") args.count = Number(argv[++i]);
    else if (arg === "--seed") args.seed = Number(argv[++i]);
    else if (arg === "--out" || arg === "-o") args.output = argv[++i];
    else if (!arg.startsWith("-") && args.output === DEFAULT_OUTPUT) args.output = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.error(`Usage:
  node scripts/generate_test_data.mjs [output.csv] [options]

Generates synthetic labeled transactions for local testing (not real data).

Options:
  --count <n>   Number of rows to generate. Default: ${DEFAULT_COUNT}
  --seed <n>    PRNG seed for reproducible output. Default: ${DEFAULT_SEED}
  --out <path>  Output CSV path. Default: ${DEFAULT_OUTPUT}
`);
}

const ACCOUNTS = ["Checking", "Credit Card", "Savings"];

// category -> { payees: [{ payee, notes }], amount: [min, max] (positive range; sign applied per category) }
const CATEGORIES = {
  "Mortgage/Rent": {
    sign: -1,
    amount: [1450, 2200],
    payees: [
      { payee: "Meridian Property Mgmt", notes: "Monthly rent" },
      { payee: "Summit Home Loans", notes: "Mortgage payment" },
    ],
  },
  Groceries: {
    sign: -1,
    amount: [12, 180],
    payees: [
      { payee: "Trader Joe's", notes: "" },
      { payee: "Kroger", notes: "" },
      { payee: "Whole Foods Market", notes: "AplPay WHOLE FOODS" },
      { payee: "Safeway", notes: "" },
    ],
  },
  "Fuel & Parking": {
    sign: -1,
    amount: [8, 75],
    payees: [
      { payee: "Circle K", notes: "AplPay CIRCLE K" },
      { payee: "Shell", notes: "" },
      { payee: "Chevron", notes: "" },
      { payee: "City Parking Garage", notes: "Monthly parking" },
    ],
  },
  "Spending Money": {
    sign: -1,
    amount: [5, 120],
    payees: [
      { payee: "Michaels", notes: "AplPay MICHAELS" },
      { payee: "Target", notes: "" },
      { payee: "Barnes & Noble", notes: "" },
      { payee: "Etsy", notes: "Online order" },
    ],
  },
  Restaurants: {
    sign: -1,
    amount: [8, 90],
    payees: [
      { payee: "Chick fil A", notes: "" },
      { payee: "Chipotle", notes: "" },
      { payee: "Local Pizza Co", notes: "" },
      { payee: "Starbucks", notes: "AplPay STARBUCKS" },
    ],
  },
  Utilities: {
    sign: -1,
    amount: [40, 260],
    payees: [
      { payee: "City Water & Power", notes: "Monthly utility bill" },
      { payee: "Metro Gas Co", notes: "Monthly utility bill" },
      { payee: "Fiber Internet Co", notes: "Internet service" },
    ],
  },
  Subscriptions: {
    sign: -1,
    amount: [5, 25],
    payees: [
      { payee: "Netflix", notes: "" },
      { payee: "Spotify", notes: "" },
      { payee: "iCloud Storage", notes: "" },
    ],
  },
  Insurance: {
    sign: -1,
    amount: [90, 320],
    payees: [
      { payee: "Statewide Insurance", notes: "Auto + home bundle" },
      { payee: "GuardHealth Insurance", notes: "Premium payment" },
    ],
  },
  Medical: {
    sign: -1,
    amount: [15, 400],
    payees: [
      { payee: "Riverside Family Clinic", notes: "Copay" },
      { payee: "Downtown Pharmacy", notes: "" },
      { payee: "Bright Smile Dental", notes: "Cleaning" },
    ],
  },
  "Fun Money/Entertainment": {
    sign: -1,
    amount: [10, 150],
    payees: [
      { payee: "AMC Theatres", notes: "" },
      { payee: "Steam", notes: "Game purchase" },
      { payee: "Local Bowling Alley", notes: "" },
    ],
  },
  "2 Month Buffer": {
    sign: -1,
    amount: [50, 500],
    payees: [{ payee: "Internal Transfer", notes: "Buffer savings transfer" }],
  },
  Travel: {
    sign: -1,
    amount: [80, 900],
    payees: [
      { payee: "Delta Air Lines", notes: "" },
      { payee: "Marriott Hotels", notes: "" },
      { payee: "Enterprise Rent-A-Car", notes: "" },
    ],
  },
  "Home Improvement": {
    sign: -1,
    amount: [15, 600],
    payees: [
      { payee: "Ace Hardware", notes: "" },
      { payee: "Lowe's", notes: "" },
    ],
  },
  Pets: {
    sign: -1,
    amount: [10, 200],
    payees: [
      { payee: "Petco", notes: "" },
      { payee: "Riverside Animal Hospital", notes: "Checkup" },
    ],
  },
  "Kids/Childcare": {
    sign: -1,
    amount: [30, 400],
    payees: [
      { payee: "Sunshine Daycare", notes: "Weekly childcare" },
      { payee: "Little Learners Preschool", notes: "Tuition" },
    ],
  },
  "Gifts/Donations": {
    sign: -1,
    amount: [10, 250],
    payees: [
      { payee: "Red Cross", notes: "Donation" },
      { payee: "Local Food Bank", notes: "Donation" },
    ],
  },
  "Auto Maintenance": {
    sign: -1,
    amount: [30, 700],
    payees: [
      { payee: "Midas Auto Service", notes: "" },
      { payee: "Jiffy Lube", notes: "Oil change" },
    ],
  },
  Clothing: {
    sign: -1,
    amount: [15, 200],
    payees: [
      { payee: "Old Navy", notes: "" },
      { payee: "Nordstrom Rack", notes: "" },
    ],
  },
  "Income/Paycheck": {
    sign: 1,
    amount: [1200, 3200],
    payees: [{ payee: "Acme Corp Payroll", notes: "Direct deposit" }],
  },
  Uncategorized: {
    sign: -1,
    amount: [10, 300],
    payees: [
      { payee: "Walmart", notes: "" },
      { payee: "Amazon", notes: "Online order" },
      { payee: "Costco", notes: "" },
      { payee: "Venmo", notes: "Payment to friend" },
      { payee: "Internal Transfer", notes: "Transfer between own accounts" },
    ],
  },
};

const CATEGORY_NAMES = Object.keys(CATEGORIES);

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randomAmount(rng, [min, max], sign) {
  const cents = Math.round((min + rng() * (max - min)) * 100);
  return ((sign * cents) / 100).toFixed(2);
}

function randomDate(rng, startDate, endDate) {
  const start = startDate.getTime();
  const end = endDate.getTime();
  const date = new Date(start + rng() * (end - start));
  return date.toISOString().slice(0, 10);
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function generateRows(count, seed) {
  const rng = mulberry32(seed);
  const startDate = new Date("2025-01-01");
  const endDate = new Date("2026-06-30");

  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const category = pick(rng, CATEGORY_NAMES);
    const { sign, amount, payees } = CATEGORIES[category];
    const { payee, notes } = pick(rng, payees);
    rows.push({
      account: pick(rng, ACCOUNTS),
      date: randomDate(rng, startDate, endDate),
      payee,
      amount: randomAmount(rng, amount, sign),
      notes,
      category,
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

function toCsv(rows) {
  const header = ["account", "date", "payee", "amount", "notes", "category"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => csvEscape(row[key])).join(","));
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!Number.isFinite(args.count) || args.count <= 0) {
    throw new Error(`--count must be a positive number, got: ${args.count}`);
  }

  const rows = generateRows(args.count, args.seed);
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, toCsv(rows), "utf8");
  console.log(`Wrote ${rows.length} synthetic transactions to ${args.output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
