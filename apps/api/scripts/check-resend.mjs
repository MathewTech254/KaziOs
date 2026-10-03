// Checks that the Resend key in the root .env is real, and lists the domains it may send
// from. Read only: it never sends a message.
//
// Run with: node -r dotenv/config scripts/check-resend.mjs
const key = process.env.EMAIL_API_KEY || "";

if (!key) {
  console.log("EMAIL_API_KEY is not set in the environment this script ran with.");
  console.log("That is usually the bug: the API reads apps/api/.env, not the root .env.");
  process.exit(1);
}

const domains = await (await fetch("https://api.resend.com/domains", {
  headers: { Authorization: `Bearer ${key}` },
})).json();

if (!Array.isArray(domains?.data)) {
  console.log("Resend rejected the key:", JSON.stringify(domains).slice(0, 300));
  process.exit(1);
}

console.log(`Resend accepted the key. ${domains.data.length} domain(s) available:`);
for (const domain of domains.data) {
  console.log(`  ${domain.name}  status=${domain.status}`);
}
console.log(
  "\nUntil a domain is verified, only onboarding@resend.dev can send, and only to the\n" +
    "address registered on the Resend account."
);
