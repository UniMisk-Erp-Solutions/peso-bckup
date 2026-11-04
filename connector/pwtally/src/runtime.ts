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

export const APP_VERSION = "1.2.7";

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
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new Error(explainNetworkError(e, url));
    }
    const text = await res.text();
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new Error(`PesoWise API ${res.status}: ${(json as { error?: string }).error ?? text.slice(0, 120)}`);
    return json as T;
  }
}

/** "fetch failed" says nothing: name the real problem (no internet, name not found, refused, timed out, certificate) and the host. */
export function explainNetworkError(e: unknown, url: string): string {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw text */ }
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? "";
  const text = `${err.name ?? ""} ${err.message ?? ""} ${err.cause?.message ?? ""} ${code}`;
  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timed out/i.test(text)) return `network: the PesoWise server (${host}) did not answer in time. Check the internet connection and try again.`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return `network: this PC cannot find the PesoWise server (${host}). Check the internet connection and DNS, then try again.`;
  if (/ECONNREFUSED/i.test(text)) return `network: the PesoWise server (${host}) refused the connection. Try again in a few minutes.`;
  if (/CERT|SSL|TLS|self.signed|unable to verify/i.test(text)) return `network: a secure connection to ${host} could not be made (certificate problem). Check the date and time on this PC and any proxy or antivirus web protection.`;
  if (/ECONNRESET|socket hang up|EPIPE/i.test(text)) return `network: the connection to ${host} was cut. Try again.`;
  return `network: this PC cannot reach the PesoWise server (${host}). Check the internet connection, firewall or proxy and try again.`;
}
