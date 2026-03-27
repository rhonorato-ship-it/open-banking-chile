/**
 * Test script — simulates the exact scrape flow from the web app.
 * Usage: doppler run --project open-banking-chile --config dev -- node scripts/test-scrape.mjs <bankId>
 *   e.g. doppler run --project open-banking-chile --config dev -- node scripts/test-scrape.mjs bice
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createClient } = require("../web/node_modules/@supabase/supabase-js/dist/index.cjs");
import { getBank } from "../dist/index.js";

const bankId = process.argv[2];
if (!bankId) {
  console.error("Usage: node scripts/test-scrape.mjs <bankId>");
  process.exit(1);
}

const userId = "5ba97bb4-79df-4f30-9359-c4c7aed7224a";

// --- Supabase ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// --- AES-256-GCM decrypt (same as web/lib/credentials.ts) ---
const secretHex = process.env.CREDENTIALS_SECRET;
if (!secretHex || !/^[a-fA-F0-9]{64}$/.test(secretHex)) {
  console.error("CREDENTIALS_SECRET missing or invalid");
  process.exit(1);
}
const rawKey = Buffer.from(secretHex, "hex");
const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);

async function decrypt(ciphertext, ivBase64) {
  const iv = Buffer.from(ivBase64, "base64");
  const data = Buffer.from(ciphertext, "base64");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, data);
  return new TextDecoder().decode(decrypted);
}

// --- Step 1: Fetch credentials ---
console.log(`\n[1/4] Fetching credentials for ${bankId} (user: ${userId.slice(0, 8)}...)...`);

const { data: cred, error: credError } = await supabase
  .from("bank_credentials")
  .select("encrypted_rut, rut_iv, encrypted_password, password_iv")
  .eq("user_id", userId)
  .eq("bank_id", bankId)
  .single();

if (credError || !cred) {
  console.error("Credential lookup failed:", credError?.message ?? "no row found");
  console.error("This is the exact error the app shows as 'No se encontraron credenciales'");
  process.exit(1);
}
console.log("  Credentials found.");

// --- Step 2: Decrypt ---
console.log("[2/4] Decrypting...");
const rut = await decrypt(cred.encrypted_rut, cred.rut_iv);
const password = await decrypt(cred.encrypted_password, cred.password_iv);
console.log(`  RUT/ID: ${rut.slice(0, 4)}${"*".repeat(rut.length - 4)}`);
console.log(`  Password: ${"*".repeat(password.length)} (${password.length} chars)`);

// --- Step 3: Get bank scraper ---
const bank = getBank(bankId);
if (!bank) {
  console.error(`Bank "${bankId}" not found in registry`);
  process.exit(1);
}
console.log(`[3/4] Scraper: ${bank.name} (${bank.url})`);

// --- Step 4: Run scrape ---
console.log("[4/4] Starting scrape...\n");

const result = await bank.scrape({
  rut,
  password,
  headful: true,
  saveScreenshots: true,
  onProgress: (step) => {
    const now = new Date().toLocaleTimeString("es-CL");
    console.log(`  [${now}] ${step}`);
  },
});

console.log("\n" + "=".repeat(50));
console.log(`Result: ${result.success ? "SUCCESS" : "FAILED"}`);
if (result.error) console.log(`Error: ${result.error}`);
if (result.movements?.length) {
  console.log(`Movements: ${result.movements.length}`);
  console.log(`First: ${result.movements[0].date} | ${result.movements[0].description} | ${result.movements[0].amount}`);
  console.log(`Last:  ${result.movements.at(-1).date} | ${result.movements.at(-1).description} | ${result.movements.at(-1).amount}`);
}
if (result.balance != null) console.log(`Balance: $${result.balance.toLocaleString("es-CL")}`);
if (result.debug) console.log(`Debug:\n${result.debug}`);
console.log("=".repeat(50));
