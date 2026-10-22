import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TallyOfflineError, type TallyIO } from "./engine.ts";

export interface ConnectorConfig {
  /** e.g. https://<your-supabase-host>  (functions are under /functions/v1) */
  apiBase: string;
  /** Publishable (anon) key only; the gateway may require an apikey header. Never a service key. */
  apiKey?: string;
  deviceToken: string;
  connectorId: string;
  organizationId: string;
  tallyCompany: string;
  tallyUrl: string;
  pollSeconds: number;
}

export const APP_VERSION = "1.2.5";

export function dataDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const dir = join(base, "PesoWise", "TallyConnector");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const configPath = () => join(dataDir(), "config.json");
const logPath = () => join(dataDir(), "connector.log");

export function loadConfig(): ConnectorConfig | null {
  if (!existsSync(configPath())) return null;
  return JSON.parse(readFileSync(configPath(), "utf-8").replace(/^﻿/, "")) as ConnectorConfig;
}

export function saveConfig(c: ConnectorConfig): void {
  writeFileSync(configPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    const p = logPath();
    if (existsSync(p) && statSync(p).size > 2_000_000) renameSync(p, p + ".1");
    appendFileSync(p, line);
  } catch { /* logging must never crash the service */ }
  process.stdout.write(line);
}

/** Local TallyPrime XML over HTTP. Never exposed publicly; loopback by default. */
export function tallyHttp(url: string, timeoutMs = 120_000): TallyIO {
  return {
    async post(xml: string): Promise<string> {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8" },
          body: xml,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
        if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"].includes(cause) ||
          (e as Error).name === "TimeoutError" || (e as Error).name === "TypeError") {
          throw new TallyOfflineError(`TallyPrime is not reachable at ${url}`);
        }
        throw e;
      }
      if (!res.ok) throw new Error(`TallyPrime HTTP ${res.status}`);
      return await res.text();
    },
  };
}

export class Api {
  constructor(private cfg: Pick<ConnectorConfig, "apiBase" | "apiKey" | "deviceToken">) {}

  /** `fn` selects the backend function; the default is the PesoWise -> Tally delivery API (unchanged). */
  async call<T = Record<string, unknown>>(body: Record<string, unknown>, fn = "pwt-connector"): Promise<T> {
    const url = `${this.cfg.apiBase.replace(/\/+$/, "")}/functions/v1/${fn}`;
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
      throw new Error("PesoWise API must use HTTPS");
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.deviceToken) headers.Authorization = `Bearer ${this.cfg.deviceToken}`;
    if (this.cfg.apiKey) headers.apikey = this.cfg.apiKey;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new Error(`PesoWise API ${res.status}: ${(json as { error?: string }).error ?? text.slice(0, 120)}`);
    return json as T;
  }
}
