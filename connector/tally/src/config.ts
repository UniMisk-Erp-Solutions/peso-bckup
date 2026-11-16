import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { newInstallationId } from "./randomId.js";

/** v1 = single org+company; future v2 may add `pairings[]` for multi-company on one PC. */
export type ConnectorConfig = {
  configVersion?: 1;
  pesoApiUrl: string;
  deviceToken?: string;
  connectorId?: string;
  organizationId?: string;
  tallyHost: string;
  tallyPort: number;
  tallyCompanyName?: string;
  /** Operator attestation scoped to the company and connector build; never set by startup. */
  metadataReadyCompany?: string;
  metadataReadyVersion?: string;
  installationId: string;
  logMaxBytes: number;
};

export function isMetadataImportReady(cfg: ConnectorConfig, version: string): boolean {
  return Boolean(cfg.tallyCompanyName?.trim())
    && cfg.metadataReadyCompany === cfg.tallyCompanyName?.trim()
    && cfg.metadataReadyVersion === version;
}

const CONFIG_DIR = join(homedir(), "PesoWise", "TallyConnector");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_PATH;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): ConnectorConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config at ${CONFIG_PATH}. Run setup first (double-click PesoWise Setup).`);
  }
  const text = readFileSync(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "");
  const raw = JSON.parse(text) as ConnectorConfig;
  return {
    ...raw,
    logMaxBytes: raw.logMaxBytes ?? 2_000_000,
    tallyHost: raw.tallyHost ?? "127.0.0.1",
    tallyPort: raw.tallyPort ?? 9000,
  };
}

export function saveConfig(partial: Partial<ConnectorConfig>): ConnectorConfig {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let base: ConnectorConfig = {
    configVersion: 1,
    pesoApiUrl: "",
    tallyHost: "127.0.0.1",
    tallyPort: 9000,
    installationId: "",
    logMaxBytes: 2_000_000,
  };
  if (existsSync(CONFIG_PATH)) {
    base = { ...base, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "")) };
  }
  const next = { ...base, ...partial };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function ensureInstallationId(cfg: ConnectorConfig): string {
  if (cfg.installationId && cfg.installationId.length >= 8) return cfg.installationId;
  const id = newInstallationId();
  saveConfig({ installationId: id });
  return id;
}
