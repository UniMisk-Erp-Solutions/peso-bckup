/**
 * PesoWise-Tally connector.
 *   pair   --api <https://host> --code <CODE> [--key <anon key>] [--tally-url http://127.0.0.1:9000]
 *   run                      background loop (what the startup task executes)
 *   doctor                   one-shot diagnostics (backend, TallyPrime, active company)
 *   install-startup | uninstall-startup
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { activeCompany, processBatch, TallyOfflineError, type ClaimedBatch } from "./engine.ts";
import { Api, APP_VERSION, dataDir, loadConfig, log, saveConfig, tallyHttp, type ConnectorConfig } from "./runtime.ts";
import { runInboundJob, type InboundJob } from "./inbound.ts";
import { runDeletionJob, type DeletionJob } from "./deletion.ts";
import { ensurePaymentVoucherType } from "./voucherType.ts";
import { realDeps, runSetupSafe } from "./setup.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pairWith(api: string, key: string | undefined, tallyUrl: string, code: string) {
  const res = await new Api({ apiBase: api, apiKey: key, deviceToken: "" }).call<{
    connector_id: string; organization_id: string; tally_company: string; device_token: string;
  }>({ action: "pair", code, device_name: hostname(), tally_version: "" });
  saveConfig({
    apiBase: api, apiKey: key, deviceToken: res.device_token, connectorId: res.connector_id,
    organizationId: res.organization_id, tallyCompany: res.tally_company, tallyUrl, pollSeconds: 10,
  });
  log(`Paired. Organization ${res.organization_id}; authorised Tally company: "${res.tally_company}"`);
}

async function pair() {
  const api = arg("api");
  const code = arg("code");
  if (!api || !code) throw new Error("usage: pair --api <https://host> --code <CODE> [--key <anon key>] [--tally-url <url>]");
  await pairWith(api, arg("key"), arg("tally-url") ?? "http://127.0.0.1:9000", code);
}

/** What the installer runs: install, pair, start. No PowerShell or script host is involved. */
async function setup() {
  const wait = !process.argv.includes("--no-wait");
  let code = 1;
  try {
    const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
    const cfgFile = join(dirname(process.execPath), "setup-config.json");
    const sc = existsSync(cfgFile) ? (JSON.parse(readFileSync(cfgFile, "utf-8").replace(/^﻿/, "")) as { apiBase: string; apiKey?: string; tallyUrl?: string }) : null;
    const deps = realDeps({
      destDir: join(base, "Programs", "PesoWiseTally"),
      skipPair: process.argv.includes("--no-pair"),
      isPaired: () => !!loadConfig(),
      pair: async (c) => {
        if (!sc?.apiBase) throw new Error("this installer has no server address; download it again from PesoWise");
        await pairWith(sc.apiBase, sc.apiKey, sc.tallyUrl ?? "http://127.0.0.1:9000", c);
      },
      doctor,
    });
    code = await runSetupSafe(deps, (e) => log(`SETUP FAILED: ${e.message}`));
  } catch (e) {
    // anything unexpected (for example an unreadable setup file) is shown, never a window that vanishes
    const msg = e instanceof Error ? e.message : String(e);
    try { log(`SETUP FAILED: ${msg}`); } catch { /* ignore */ }
    console.log(`
Setup could not start: ${msg}
Download the installer again from PesoWise and run it.`);
  }
  if (wait) {
    process.stdout.write("\nPress Enter to close this window.");
    await new Promise<void>((r) => { process.stdin.resume(); process.stdin.once("data", () => r()); process.stdin.once("end", () => r()); });
  }
  process.exit(code);
}

async function doctor() {
  const cfg = loadConfig();
  if (!cfg) return log("NOT PAIRED: run pair first");
  log(`Connector ${APP_VERSION}; company "${cfg.tallyCompany}"; backend ${cfg.apiBase}; tally ${cfg.tallyUrl}`);
  try {
    const r = await new Api(cfg).call<{ paired_company: string }>({ action: "heartbeat", tally_version: APP_VERSION });
    log(`Backend OK (paired company: ${r.paired_company})`);
  } catch (e) {
    log(`Backend FAIL: ${(e as Error).message}`);
  }
  try {
    const active = await activeCompany(tallyHttp(cfg.tallyUrl, 15_000));
    log(`TallyPrime OK. Active company: "${active}" ${active === cfg.tallyCompany ? "(matches)" : "(DOES NOT MATCH - open the authorised company)"}`);
  } catch (e) {
    log(`TallyPrime FAIL: ${(e as Error).message}`);
  }
}

async function run() {
  const cfg = loadConfig();
  if (!cfg) throw new Error("Not paired. Run: pair --api <url> --code <CODE>");
  const api = new Api(cfg);
  const tally = tallyHttp(cfg.tallyUrl);
  log(`PesoWise Tally connector ${APP_VERSION} started. Authorised company: "${cfg.tallyCompany}"`);

  let inboundRetryAt = 0;
  let deletionRetryAt = 0;
  let voucherTypeDone = ""; // "<company>|<name>" once the payment voucher type is known to exist
  let voucherTypeRetryAt = 0;
  for (;;) {
    let busy = false;
    try {
      let active: string | null = null;
      let tallyErr: string | undefined;
      try {
        active = await activeCompany(tally);
      } catch (e) {
        tallyErr = e instanceof TallyOfflineError ? "tally_offline" : (e as Error).message;
      }
      const hb = await api.call<{ voucher_type?: string }>({ action: "heartbeat", active_company: active, tally_version: APP_VERSION, error: tallyErr });

      // Only ask for work while the AUTHORISED company is the active one.
      if (active === cfg.tallyCompany) {
        // The payment voucher type used by "Sync from Tally" is created in the paired company automatically if it is missing.
        const vtName = hb.voucher_type ?? "PesoWise Payment";
        if (voucherTypeDone !== `${active}|${vtName}` && Date.now() >= voucherTypeRetryAt) {
          const r = await ensurePaymentVoucherType(tally, active, vtName).catch((e) => ({ ok: false as const, reason: (e as Error).message }));
          if (r.ok) {
            voucherTypeDone = `${active}|${vtName}`;
            if (r.state === "created") log(`Created the "${vtName}" voucher type in Tally (used by Sync from Tally).`);
          } else {
            voucherTypeRetryAt = Date.now() + 10 * 60_000;
            log(`Could not prepare the "${vtName}" voucher type (retry in 10 min): ${r.reason}`);
          }
        }

        const { batch } = await api.call<{ batch: (ClaimedBatch & { blocked?: string }) | null }>({
          action: "claim", active_company: active,
        });
        if (batch && !batch.blocked && batch.batch_id) {
          busy = true;
          log(`Batch ${batch.batch_id} (${batch.kind}) attempt ${(batch as unknown as { attempt: number }).attempt}`);
          const out = await processBatch(batch, tally);
          if (out.verified) {
            log(`  verified: ${JSON.stringify(out.response)}`);
            await api.call({ action: "ack", batch_id: batch.batch_id, verified: true, response: out.response });
          } else {
            log(`  NOT verified${out.offline ? " (Tally offline)" : ""}: ${out.error}`);
            await api.call({
              action: "ack", batch_id: batch.batch_id, verified: false, permanent: out.permanent,
              error: out.error, response: { ...(out.response ?? {}), offline: out.offline === true },
            });
          }
        }

        // Deletion sync (an expense deleted in PesoWise -> corrected in Tally): automatic, after any pending delivery.
        if (!busy && Date.now() >= deletionRetryAt) {
          try {
            const { job } = await api.call<{ job: (DeletionJob & { blocked?: string }) | null }>(
              { action: "claim", active_company: active }, "pwt-deletion",
            );
            if (job && !job.blocked && job.job_id) {
              busy = true;
              log(`Deletion correction job ${job.job_id}: voucher ${job.voucher_number} (${job.voucher_date}), amount ${job.amount}`);
              await runDeletionJob(job, tally, { call: (body) => api.call(body, "pwt-deletion") }, log);
            }
          } catch (e) {
            // e.g. the backend has no deletion function yet: back off instead of logging every cycle
            deletionRetryAt = Date.now() + 5 * 60_000;
            log(`deletion sync poll error (retry in 5 min): ${(e as Error).message}`);
          }
        }

        // Reverse sync (Tally -> PesoWise employee balances): only when there is no outbound work pending.
        if (!busy && Date.now() >= inboundRetryAt) {
          try {
            const { job } = await api.call<{ job: (InboundJob & { blocked?: string }) | null }>(
              { action: "claim", active_company: active }, "pwt-inbound",
            );
            if (job && !job.blocked && job.job_id) {
              busy = true;
              log(`Reverse sync job ${job.job_id} for "${job.tally_company}"`);
              const r = await runInboundJob(job, tally, { call: (body) => api.call(body, "pwt-inbound") }, log);
              log(r.ok ? `  reverse sync done: ${JSON.stringify(r.summary ?? {})}` : `  reverse sync failed: ${r.error}`);
            }
          } catch (e) {
            // e.g. the backend has no inbound function yet: back off instead of logging every cycle
            inboundRetryAt = Date.now() + 5 * 60_000;
            log(`reverse sync poll error (retry in 5 min): ${(e as Error).message}`);
          }
        }
      } else if (active) {
        log(`Active Tally company is "${active}", not "${cfg.tallyCompany}". Idle (nothing is written).`);
      }
    } catch (e) {
      log(`loop error: ${(e as Error).message}`);
    }
    await sleep(busy ? 250 : cfg.pollSeconds * 1000);
  }
}

function startupPaths() {
  const exe = process.execPath;
  const dir = dataDir();
  return { exe, vbs: join(dir, "run-hidden.vbs"), task: "PesoWise Tally Connector" };
}

function installStartup() {
  const { exe, vbs, task } = startupPaths();
  // Hidden launch (no console window) at every user logon; per-user, no admin rights needed.
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${exe}"" run", 0, False\r\n`);
  // HKCU Run key: runs at this user's logon, needs NO admin rights (a Task Scheduler ONLOGON task does).
  execFileSync("reg", ["add", RUN_KEY, "/v", task, "/t", "REG_SZ", "/d", `wscript.exe "${vbs}"`, "/f"], { stdio: "ignore" });
  // NOTE: starting the connector is done by the installer script / the logon entry, never from here: a child started from inside
  // the packaged exe inherits PKG_EXECPATH and runs as plain Node, so it can never start.
  log("Startup entry installed (HKCU Run). It starts at every sign-in; the installer starts it now.");
}

function uninstallStartup() {
  const { vbs, task } = startupPaths();
  try { execFileSync("reg", ["delete", RUN_KEY, "/v", task, "/f"], { stdio: "ignore" }); } catch { /* none */ }
  if (existsSync(vbs)) unlinkSync(vbs);
  log("Startup entry removed.");
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// Double-clicking the program (no arguments) means "install": a window that prints a usage line and closes would look like a crash.
const cmd = process.argv[2] ?? "setup";
const table: Record<string, () => Promise<void> | void> = {
  pair, run, doctor, setup, "install-startup": installStartup, "uninstall-startup": uninstallStartup,
};
if (!cmd || !table[cmd]) {
  console.log("usage: PesoWiseTally.exe <setup|pair|run|doctor|install-startup|uninstall-startup>");
  process.exit(cmd ? 2 : 0);
}
Promise.resolve(table[cmd]()).catch((e) => {
  log(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
void dirname; void mkdirSync;
export type { ConnectorConfig };
