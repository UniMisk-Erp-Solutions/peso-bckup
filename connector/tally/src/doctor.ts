import { existsSync, accessSync, constants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { configPath, loadConfig } from "./config.js";
import { PesoConnectorApi } from "./pesoApi.js";
import { TallyClient } from "./tallyClient.js";
import { log } from "./logger.js";
import { checkTcpPort, DOCTOR_TALLY_TCP_TIMEOUT_MS } from "./tallyTcpCheck.js";

export const AGENT_VERSION = "0.6.0-company-verify";

export type TallyCompanyVerificationStatus =
  | "verified"
  | "company_identity_mismatch"
  | "company_identity_ambiguous"
  | "company_probe_unavailable"
  | "company_not_configured"
  | "not_configured";

export type DoctorReport = {
  agent_version: string;
  config_present: boolean;
  config_path: string;
  organization_id: string | null;
  connector_id: string | null;
  tally_company: string | null;
  backend_reachable: boolean;
  backend_authenticated: boolean;
  tally_localhost: boolean;
  /** True only when the read-only Export probe returns exactly the configured active company. */
  tally_company_found: boolean;
  tally_company_verification: TallyCompanyVerificationStatus;
  delivery_ready: false;
  logs_writable: boolean;
  /** Doctor never delivers report batches; it still writes a local log and backend heartbeat. */
  readonly: false;
  backend_heartbeat_sent: boolean;
};

/** Diagnostics may issue one read-only company Export; never claim, acknowledge, or import. */
export async function runDoctor(): Promise<DoctorReport> {
  const cfgPath = configPath();
  const report: DoctorReport = {
    agent_version: AGENT_VERSION,
    config_present: existsSync(cfgPath),
    config_path: cfgPath,
    organization_id: null,
    connector_id: null,
    tally_company: null,
    backend_reachable: false,
    backend_authenticated: false,
    tally_localhost: false,
    tally_company_found: false,
    tally_company_verification: "company_probe_unavailable",
    delivery_ready: false,
    logs_writable: false,
    readonly: false,
    backend_heartbeat_sent: false,
  };

  try {
    accessSync(join(homedir(), "PesoWise", "TallyConnector"), constants.W_OK);
    report.logs_writable = true;
  } catch {
    report.logs_writable = false;
  }

  if (!report.config_present) return report;

  const cfg = loadConfig();
  report.organization_id = cfg.organizationId ?? null;
  report.connector_id = cfg.connectorId ?? null;
  report.tally_company = cfg.tallyCompanyName ?? null;
  if (!report.tally_company?.trim()) {
    report.tally_company_verification = "not_configured";
  }

  const host = cfg.tallyHost ?? "127.0.0.1";
  const port = cfg.tallyPort ?? 9000;
  try {
    report.tally_localhost = await checkTcpPort(host, port, DOCTOR_TALLY_TCP_TIMEOUT_MS);
  } catch {
    report.tally_localhost = false;
  }

  if (cfg.tallyCompanyName?.trim() && report.tally_localhost) {
    const tally = new TallyClient({ host, port, companyName: cfg.tallyCompanyName });
    const company = await tally.verifyActiveCompany(cfg.tallyCompanyName);
    report.tally_company_found = company.verified;
    report.tally_company_verification = company.verified ? "verified" : company.reason;
  }

  if (cfg.deviceToken && cfg.pesoApiUrl) {
    try {
      const api = new PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
      await api.heartbeat(AGENT_VERSION);
      report.backend_reachable = true;
      report.backend_authenticated = true;
      report.backend_heartbeat_sent = true;
    } catch {
      report.backend_reachable = false;
    }
  }

  log(
    `doctor: config=${report.config_present} backend=${report.backend_authenticated} tally_tcp=${report.tally_localhost} company_verify=${report.tally_company_verification}`,
  );
  return report;
}
