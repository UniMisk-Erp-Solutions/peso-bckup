/**
 * PesoWise-Tally connector.
 *   pair   --api <https://host> --code <CODE> [--key <anon key>] [--tally-url http://127.0.0.1:9000]
 *   run                      background loop (what the startup task executes)
 *   doctor                   one-shot diagnostics (backend, TallyPrime, active company)
 *   install-startup | uninstall-startup
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { activeCompany, processBatch, TallyOfflineError, type ClaimedBatch } from "./engine.ts";
import { Api, APP_VERSION, dataDir, loadConfig, log, saveConfig, tallyHttp, type ConnectorConfig } from "./runtime.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pair() {
  const api = arg("api");
  const code = arg("code");
  if (!api || !code) throw new Error("usage: pair --api <https://host> --code <CODE> [--key <anon key>] [--tally-url <url>]");
  const tallyUrl = arg("tally-url") ?? "http://127.0.0.1:9000";
  const res = await new Api({ apiBase: api, apiKey: arg("key"), deviceToken: "" }).call<{
    connector_id: string; organization_id: string; tally_company: string; device_token: string;
  }>({ action: "pair", code, device_name: hostname(), tally_version: "" });
  saveConfig({
    apiBase: api, apiKey: arg("key"), deviceToken: res.device_token, connectorId: res.connector_id,
    organizationId: res.organization_id, tallyCompany: res.tally_company, tallyUrl, pollSeconds: 10,
  });
  log(`Paired. Organization ${res.organization_id}; authorised Tally company: "${res.tally_company}"`);
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
      await api.call({ action: "heartbeat", active_company: active, tally_version: APP_VERSION, error: tallyErr });

      // Only ask for work while the AUTHORISED company is the active one.
      if (active === cfg.tallyCompany) {
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

const cmd = process.argv[2];
const table: Record<string, () => Promise<void> | void> = {
  pair, run, doctor, "install-startup": installStartup, "uninstall-startup": uninstallStartup,
};
if (!cmd || !table[cmd]) {
  console.log("usage: PesoWiseTally.exe <pair|run|doctor|install-startup|uninstall-startup>");
  process.exit(cmd ? 2 : 0);
}
Promise.resolve(table[cmd]()).catch((e) => {
  log(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
void dirname; void mkdirSync;
export type { ConnectorConfig };
