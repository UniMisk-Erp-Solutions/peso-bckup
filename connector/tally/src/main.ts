import minimist from "minimist";
import { loadConfig, saveConfig, ensureInstallationId, configPath } from "./config.js";
import { runSetupWizard, resolveSetupPrefill } from "./setupWizard.js";
import { exchangePairingCode } from "./pesoApi.js";
import { installGlobalErrorHandlers, log, logFilePath } from "./logger.js";

import { deliverEntireJob } from "./deliverJob.js";
import { deliverBoundBatch } from "./deliverBatch.js";
import { PesoConnectorApi } from "./pesoApi.js";
import { TallyClient } from "./tallyClient.js";
import { runDoctor, AGENT_VERSION } from "./doctor.js";
import { startLocalBridge, startServeMode } from "./localBridge.js";
import { acquireSingleInstanceLock } from "./singleInstance.js";
import { newInstallationId } from "./randomId.js";
import { isPackagedExecutable, isProductionConnectorRuntime } from "./runtime.js";
import { PRODUCT_NAME } from "./product.js";

const VERSION = AGENT_VERSION;

installGlobalErrorHandlers();

async function cmdPair(args: Record<string, unknown>) {
  const pesoApiUrl = String(args.url ?? args["peso-url"] ?? "");
  const anonKey = String(
    args.anon ?? args["anon-key"] ?? process.env.PESO_TALLY_ANON_KEY ?? process.env.TALLY_VALIDATE_ANON_KEY ?? "",
  );
  const code = String(args.code ?? "");
  const deviceName = String(args.name ?? "PesoWise Connector");
  const tallyCompany = args.company ? String(args.company) : undefined;
  if (!pesoApiUrl || !anonKey || !code) {
    console.error("Usage: pair --url <supabase-url> --anon-key <anon> --code <PAIRING>");
    process.exit(2);
  }
  const installationId = newInstallationId();
  const result = await exchangePairingCode(pesoApiUrl, anonKey, code, deviceName, installationId, VERSION);
  saveConfig({
    configVersion: 1,
    pesoApiUrl,
    deviceToken: result.device_token,
    connectorId: result.connector_id,
    organizationId: result.organization_id,
    installationId,
    tallyCompanyName: tallyCompany,
  });
  console.log(`Paired connector ${result.connector_id}. Config: ${configPath()}`);
  console.log("Device token stored locally â€” not shown again.");
}

function rejectDevOnlyCommand(cmd: string): void {
  if (
    (cmd === "bridge" || cmd === "serve") &&
    isProductionConnectorRuntime() &&
    process.env.PESOWISE_ALLOW_DEV_BRIDGE !== "1"
  ) {
    console.error(
      `${cmd} is dev-only. Production PesoWiseConnector.exe runs "run" (background sync). ` +
        `Logs: ${logFilePath()}`,
    );
    process.exit(2);
  }
}

function defaultCommand(): string {
  // A user double-click must show setup/status feedback rather than silently
  // starting a background worker and closing the window. Startup tasks always
  // pass the explicit `run` command.
  if (isPackagedExecutable()) return "setup";
  return "run";
}

async function main() {
  const argv = minimist(process.argv.slice(2));
  const sub = argv._[0] as string | undefined;

  const cmd = sub ?? defaultCommand();
  if (cmd === "version") {
    console.log(
      JSON.stringify({
        product: PRODUCT_NAME,
        version: VERSION,
        packaged: isPackagedExecutable(),
      }),
    );
    return;
  }
  if (cmd === "confirm-metadata") {
    const cfg = loadConfig();
    const company = String(argv.company ?? "").trim();
    if (!company || company !== cfg.tallyCompanyName?.trim()
      || argv["confirm-installed"] !== true || argv["confirm-group"] !== true) {
      console.error("After restarting Tally and confirming both PesoWise TDL files are loaded and the 'PesoWise Metadata' group exists, run: PesoWiseConnector.exe confirm-metadata --company \"<configured company>\" --confirm-installed --confirm-group");
      process.exitCode = 2;
      return;
    }
    saveConfig({ metadataReadyCompany: company, metadataReadyVersion: VERSION });
    console.log(`Metadata setup attested for ${company} on connector ${VERSION}.`);
    return;
  }
  rejectDevOnlyCommand(cmd);
  if (cmd === "pair") {
    await cmdPair(argv);
    return;
  }
  if (cmd === "doctor") {
    const report = await runDoctor();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode =
      report.config_present && report.backend_authenticated && report.tally_localhost && report.tally_company_found ? 0 : 1;
    return;
  }
  if (cmd === "deliver-job") {
    const jobId = String(argv["job-id"] ?? argv.jobId ?? "");
    const cfg = loadConfig();
    const out = await deliverEntireJob(cfg, jobId, VERSION);
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.stopped_reason === "complete" ? 0 : 1;
    return;
  }
  if (cmd === "deliver-batch" || cmd === "run-once") {
    const jobId = String(argv["job-id"] ?? argv.jobId ?? "");
    const batchId = String(argv["batch-id"] ?? argv.batchId ?? "");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(jobId) || !uuid.test(batchId)) {
      console.error(`Usage: ${cmd} --job-id <UUID> --batch-id <UUID>`);
      process.exitCode = 2;
      return;
    }
    const cfg = loadConfig();
    const peso = new PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken ?? "");
    const tally = new TallyClient({
      host: cfg.tallyHost,
      port: cfg.tallyPort,
      companyName: cfg.tallyCompanyName,
    });
    const result = await deliverBoundBatch(cfg, peso, tally, jobId, batchId);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.success ? 0 : 1;
    return;
  }
  if (cmd === "bridge") {
    startLocalBridge();
    return;
  }
  if (cmd === "serve") {
    startServeMode();
    return;
  }
  if (cmd === "setup") {
    await runSetupWizard({ prefillCode: resolveSetupPrefill(argv), openBrowser: true });
    return;
  }
  if (cmd === "run") {
    const lock = acquireSingleInstanceLock();
    const cfg = loadConfig();
    ensureInstallationId(cfg);
    log(
      `${PRODUCT_NAME} ${VERSION} starting packaged=${isPackagedExecutable()} org=${cfg.organizationId ?? "?"}`,
    );
    process.on("SIGINT", () => {
      lock.release();
      process.exit(0);
    });
    // The packaged background process must never sweep and claim old queued
    // batches at startup. The UI requests delivery for one newly-created job
    // through the local bridge after a fresh active-company preflight.
    startLocalBridge();
    log("Local bridge ready; no pending batches will be claimed automatically.");
    return;
  }
  console.error(
    "Commands: setup | run | pair | version | doctor | confirm-metadata | run-once | deliver-batch | deliver-job | (dev: bridge | serve)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

