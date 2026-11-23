#!/usr/bin/env node
/**
 * Admin: create one-time connector pairing code (shown once on stderr).
 *
 * Env:
 *   TALLY_VALIDATE_SUPABASE_URL (optional)
 *   TALLY_VALIDATE_ANON_KEY (optional)
 *   TALLY_VALIDATE_ADMIN_EMAIL / TALLY_VALIDATE_ADMIN_PASSWORD
 *   TALLY_SMOKE_ORG_ID (default test org)
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ORG =
  process.env.TALLY_ORG_ID ??
  process.env.TALLY_SMOKE_ORG_ID ??
  "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const url = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);

async function loadAnonKey() {
  if (process.env.TALLY_VALIDATE_ANON_KEY) return process.env.TALLY_VALIDATE_ANON_KEY;
  const local = join(dirname(fileURLToPath(import.meta.url)), "../../.env.local");
  if (existsSync(local)) {
    const m = readFileSync(local, "utf8").match(/VITE_SUPABASE_ANON_KEY=(.+)/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  const t = await fetch("https://peso-backup.vercel.app/assets/index-Di3_NMzi.js").then((r) => r.text());
  const m = t.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error("Set TALLY_VALIDATE_ANON_KEY");
  return m[0];
}

async function signIn(anon, email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? body.msg ?? res.status);
  return body.access_token;
}

async function rpc(name, args, { anon, jwt }) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${name}: ${text.slice(0, 400)}`);
  return data;
}

async function main() {
  const email = process.env.TALLY_VALIDATE_ADMIN_EMAIL;
  const password = process.env.TALLY_VALIDATE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set TALLY_VALIDATE_ADMIN_EMAIL and TALLY_VALIDATE_ADMIN_PASSWORD");
    process.exit(2);
  }
  const anon = await loadAnonKey();
  const jwt = await signIn(anon, email, password);
  const pairing = await rpc(
    "create_tally_connector_pairing_code_v1",
    { p_organization_id: ORG, p_ttl_minutes: 30 },
    { anon, jwt },
  );
  const code = String(pairing?.pairing_code ?? "");
  console.log(JSON.stringify({ organization_id: ORG, pairing_code_prefix: code.slice(0, 4) + "****" }));
  if (!code) {
    console.error("No pairing_code in response");
    process.exit(1);
  }
  console.error("\n=== ONE-TIME PAIRING CODE (copy now) ===");
  console.error(code);
  console.error("=== expires per p_ttl_minutes ===\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
