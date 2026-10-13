/**
 * Create a Paystack subaccount for one pilot shop, so their card sales are paid
 * straight to their own bank account (split payments / "Option B").
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Creating a subaccount needs your PAYSTACK_SECRET_KEY. You should never paste that
 * key into a chat, a ticket, or a terminal command where it lands in shell history.
 * This script reads the key from your server .env (via `node -r dotenv/config`) and
 * calls Paystack for you, so the secret never leaves your machine.
 *
 * It prints the resulting subaccount code, which you then paste into the shop's
 * Settings -> Preferences -> "Card payouts (split payments)" screen in KaziOS.
 * That code is safe to handle: it is a public identifier, not a secret.
 *
 * RUN IT
 * ------
 *   cd apps/api
 *   node -r dotenv/config scripts/create-subaccount.mjs --name "Mama Mboga Shop" --bank 035 --account 0123456789
 *
 *   --name     Business/account name shown on the shop's bank statement (required)
 *   --bank     Settlement bank code from Paystack's bank list, e.g. 035 (see below) (required)
 *   --account  Settlement bank account number, digits only (required)
 *   --percent  Your platform fee as a PERCENTAGE of each sale, e.g. 2 for 2% (optional, default 0)
 *   --test     Assert the key is a test key (sk_test_...), refusing to mix with a live key
 *
 * WHERE DO I GET THE BANK CODE?
 * -----------------------------
 * Paystack needs the numeric bank code of the shop's settlement bank, not the bank name:
 *   curl https://api.paystack.co/bank?currency=KES -H "Authorization: Bearer $PAYSTACK_SECRET_KEY"
 * Common Kenyan examples: 035 (KCB), 063 (Equity), 011 (Co-op), 057 (Stanbic),
 * 031 (NCBA), 070 (Family). Always confirm against the live list for your key.
 *
 * WHAT HAPPENS NEXT (in the app)
 * ------------------------------
 * The code this prints (starts with ACCT_) goes into the shop's
 *   Settings -> Preferences -> "Card payouts (split payments)" -> "Paystack subaccount code".
 * After that, each card sale for that shop is split: the shop's bank receives the sale
 * minus your fee, and your platform keeps the fee. Leave the field blank to keep today's
 * behaviour (everything settles to the platform account).
 *
 * NOTE: this creates a REAL subaccount on whichever Paystack account owns the secret key
 * (live or test). It performs no charge and moves no money. Treat it as a live setup step.
 */

function parseArgs(argv) {
  const args = { test: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (arg === "--name") args.name = next();
    else if (arg === "--bank") args.bank = next();
    else if (arg === "--account") args.account = next();
    else if (arg === "--percent") args.percent = next();
    else if (arg === "--test") args.test = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      '  node -r dotenv/config scripts/create-subaccount.mjs --name "Shop Name" --bank 035 --account 0123456789 [--percent 2] [--test]',
      "",
      "Reads PAYSTACK_SECRET_KEY from .env. Prints an ACCT_... code to paste into",
      "the shop's KaziOS Settings -> Preferences -> Card payouts.",
    ].join("\n") + "\n"
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY || "";
  if (!secretKey) {
    process.stderr.write(
      "PAYSTACK_SECRET_KEY is not set in .env. Add it there (never paste it into a chat) and retry.\n"
    );
    process.exitCode = 1;
    return;
  }

  const mode = secretKey.startsWith("sk_test_") ? "test" : "live";
  if (args.test && mode === "live") {
    process.stderr.write(
      "You passed --test but the key is a LIVE key (sk_live_...). Refusing to mix modes.\n"
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "live") {
    process.stderr.write(
      "WARNING: using a LIVE Paystack key. This creates a real subaccount. Continue only if intended.\n"
    );
  }

  const missing = [];
  if (!args.name) missing.push("--name");
  if (!args.bank) missing.push("--bank");
  if (!args.account) missing.push("--account");
  if (missing.length > 0) {
    process.stderr.write(`Missing required arguments: ${missing.join(", ")}\n\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!/^[0-9]+$/.test(String(args.account))) {
    process.stderr.write("--account must be digits only (the bank account number).\n");
    process.exitCode = 1;
    return;
  }

  const percentageCharge = args.percent ? Number(args.percent) : 0;
  if (!Number.isFinite(percentageCharge) || percentageCharge < 0 || percentageCharge > 100) {
    process.stderr.write("--percent must be a number between 0 and 100.\n");
    process.exitCode = 1;
    return;
  }

  const body = {
    business_name: String(args.name).trim(),
    settlement_bank: String(args.bank).trim(),
    account_number: String(args.account).trim(),
    percentage_charge: percentageCharge,
  };

  const res = await fetch("https://api.paystack.co/subaccount", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.status) {
    process.stderr.write(
      `Paystack rejected the request (HTTP ${res.status}): ${json.message || "unknown error"}\n`
    );
    if (json.message && /bank/i.test(String(json.message))) {
      process.stderr.write(
        "The settlement bank code looks wrong. List valid codes with: GET https://api.paystack.co/bank?currency=KES\n"
      );
    }
    process.exitCode = 1;
    return;
  }

  const sub = json.data || {};
  process.stdout.write("\nSubaccount created.\n");
  process.stdout.write(`  mode:            ${mode}\n`);
  process.stdout.write(`  subaccount code: ${sub.subaccount_code}\n`);
  if (sub.account_number) {
    const raw = String(sub.account_number);
    const masked = raw.slice(-4).padStart(raw.length, "*");
    process.stdout.write(`  account:         ${masked}\n`);
  }
  if (sub.settlement_bank) process.stdout.write(`  bank:            ${sub.settlement_bank}\n`);
  if (sub.percentage_charge !== undefined) {
    process.stdout.write(`  % charge to platform: ${sub.percentage_charge}\n`);
  }
  process.stdout.write(
    "\nNext: open the shop in KaziOS -> Settings -> Preferences -> \"Card payouts (split payments)\"\n" +
      `and paste this code: ${sub.subaccount_code}\n` +
      "That code is a public identifier; the secret key stays in your .env.\n"
  );
}

main().catch(err => {
  process.stderr.write(`Unexpected error: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

