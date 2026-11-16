#!/usr/bin/env node
/**
 * Dev bootstrap: if local connector config is missing or wrong org, auto-pair to MicroLink.
 * Requires Coolify SSH password (same as other tally-integration scripts).
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { MICROLINK_ORG } from "./_queueSafeShared.mjs";

const CONFIG = join(homedir(), "PesoWise", "TallyConnector", "config.json");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPANY = process.env.PESO_TALLY_COMPANY ?? "PesoWise Integration Test";

function configOk() {
  if (!existsSync(CONFIG)) return false;
  try {
    const raw = JSON.parse(readFileSync(CONFIG, "utf-8").replace(/^\uFEFF/, ""));
    return Boolean(raw.deviceToken) && String(raw.organizationId ?? "") === MICROLINK_ORG;
  } catch {
    return false;
  }
}

if (configOk()) {
  console.log("[tally] Connector already paired for MicroLink");
  process.exit(0);
}

console.log("[tally] Auto-pairing connector to MicroLink org…");
process.env.ISSUE_PAIRING_CONFIRM = "1";
process.env.PESO_TALLY_COMPANY = COMPANY;
const issue = spawnSync(process.execPath, ["scripts/tally-integration/ssh-issue-microlink-pairing-code.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env },
});
process.exit(issue.status ?? 1);
