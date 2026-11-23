"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const minimist_1 = __importDefault(require("minimist"));
const config_js_1 = require("./config.js");
const setupWizard_js_1 = require("./setupWizard.js");
const pesoApi_js_1 = require("./pesoApi.js");
const serviceLoop_js_1 = require("./serviceLoop.js");
const logger_js_1 = require("./logger.js");
const deliverJob_js_1 = require("./deliverJob.js");
const doctor_js_1 = require("./doctor.js");
const localBridge_js_1 = require("./localBridge.js");
const singleInstance_js_1 = require("./singleInstance.js");
const randomId_js_1 = require("./randomId.js");
const runtime_js_1 = require("./runtime.js");
const installBundle_js_1 = require("./installBundle.js");
const launcher_js_1 = require("./launcher.js");
const product_js_1 = require("./product.js");
const VERSION = doctor_js_1.AGENT_VERSION;
(0, logger_js_1.installGlobalErrorHandlers)();
async function cmdPair(args) {
    const pesoApiUrl = String(args.url ?? args["peso-url"] ?? "");
    const anonKey = String(args.anon ?? args["anon-key"] ?? process.env.PESO_TALLY_ANON_KEY ?? process.env.TALLY_VALIDATE_ANON_KEY ?? "");
    const code = String(args.code ?? "");
    const deviceName = String(args.name ?? "PesoWise Connector");
    const tallyCompany = args.company ? String(args.company) : undefined;
    if (!pesoApiUrl || !anonKey || !code) {
        console.error("Usage: pair --url <supabase-url> --anon-key <anon> --code <PAIRING>");
        process.exit(2);
    }
    const installationId = (0, randomId_js_1.newInstallationId)();
    const result = await (0, pesoApi_js_1.exchangePairingCode)(pesoApiUrl, anonKey, code, deviceName, installationId, VERSION);
    (0, config_js_1.saveConfig)({
        configVersion: 1,
        pesoApiUrl,
        deviceToken: result.device_token,
        connectorId: result.connector_id,
        organizationId: result.organization_id,
        installationId,
        tallyCompanyName: tallyCompany,
    });
    console.log(`Paired connector ${result.connector_id}. Config: ${(0, config_js_1.configPath)()}`);
    console.log("Device token stored locally â€” not shown again.");
}
function rejectDevOnlyCommand(cmd) {
    if ((cmd === "bridge" || cmd === "serve") &&
        (0, runtime_js_1.isProductionConnectorRuntime)() &&
        process.env.PESOWISE_ALLOW_DEV_BRIDGE !== "1") {
        console.error(`${cmd} is dev-only. Production PesoWiseConnector.exe runs "run" (background sync). ` +
            `Logs: ${(0, logger_js_1.logFilePath)()}`);
        process.exit(2);
    }
}
function defaultCommand() {
    if ((0, runtime_js_1.isPackagedExecutable)() && !(0, config_js_1.configExists)())
        return "setup";
    return "run";
}
async function main() {
    const argv = (0, minimist_1.default)(process.argv.slice(2));
    const sub = argv._[0];
    if ((0, launcher_js_1.shouldUseSimpleLauncher)(!sub)) {
        try {
            (0, installBundle_js_1.installBundledFiles)();
        }
        catch (e) {
            (0, logger_js_1.log)(`Install warning: ${e.message}`);
        }
        const launch = (0, launcher_js_1.runPackagedLauncher)();
        if (launch === "worker_started" || launch === "worker_already_running") {
            process.exit(0);
        }
        // setup_needed: stay in this process and run setup wizard below (port 9877).
    }
    const cmd = sub ?? defaultCommand();
    if (cmd === "version") {
        console.log(JSON.stringify({
            product: product_js_1.PRODUCT_NAME,
            version: VERSION,
            packaged: (0, runtime_js_1.isPackagedExecutable)(),
        }));
        return;
    }
    rejectDevOnlyCommand(cmd);
    if (cmd === "pair") {
        await cmdPair(argv);
        return;
    }
    if (cmd === "doctor") {
        const report = await (0, doctor_js_1.runDoctor)();
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.config_present && report.backend_authenticated && report.tally_localhost && report.tally_company_found ? 0 : 1);
    }
    if (cmd === "run-once") {
        console.error("run-once is unavailable: controlledRun module is missing.");
        process.exitCode = 2;
        return;
    }
    if (cmd === "deliver-job") {
        const jobId = String(argv["job-id"] ?? argv.jobId ?? "");
        const cfg = (0, config_js_1.loadConfig)();
        const out = await (0, deliverJob_js_1.deliverEntireJob)(cfg, jobId, VERSION);
        console.log(JSON.stringify(out, null, 2));
        process.exit(out.stopped_reason === "complete" ? 0 : 1);
        return;
    }
    if (cmd === "bridge") {
        (0, localBridge_js_1.startLocalBridge)();
        return;
    }
    if (cmd === "serve") {
        (0, localBridge_js_1.startServeMode)();
        return;
    }
    if (cmd === "setup") {
        await (0, setupWizard_js_1.runSetupWizard)({ prefillCode: (0, setupWizard_js_1.resolveSetupPrefill)(argv), openBrowser: true });
        return;
    }
    if (cmd === "run") {
        const lock = (0, singleInstance_js_1.acquireSingleInstanceLock)();
        const cfg = (0, config_js_1.loadConfig)();
        (0, config_js_1.ensureInstallationId)(cfg);
        (0, logger_js_1.log)(`${product_js_1.PRODUCT_NAME} ${VERSION} starting packaged=${(0, runtime_js_1.isPackagedExecutable)()} org=${cfg.organizationId ?? "?"}`);
        process.on("SIGINT", () => {
            lock.release();
            process.exit(0);
        });
        await (0, serviceLoop_js_1.runServiceLoop)(cfg);
        return;
    }
    console.error("Commands: setup | run | pair | version | run-once | deliver-job | doctor | (dev: bridge | serve)");
}
main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
