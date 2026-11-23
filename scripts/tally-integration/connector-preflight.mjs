#!/usr/bin/env node
/**
 * Post-pairing checks only — NO claim, NO Tally import.
 */
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import http from "http";

const CONFIG = join(homedir(), "PesoWise", "TallyConnector", "config.json");

function tcp(host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method: "GET", timeout: 5000 }, () => resolve(true));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function heartbeat(baseUrl, token) {
  const url = `${baseUrl.replace(/\/$/, "")}/functions/v1/tally-connector`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Connector-Token": token },
    body: JSON.stringify({ action: "heartbeat", version: "preflight" }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
}

async function main() {
  const out = {
    config_exists: existsSync(CONFIG),
    backend: { ok: false },
    tally_port_9000: false,
    organization_id: null,
    connector_id: null,
    tally_company: null,
  };
  if (!out.config_exists) {
    console.log(JSON.stringify({ ...out, final: "FAIL", reason: "no_config_run_pair_first" }));
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(CONFIG, "utf-8"));
  out.organization_id = cfg.organizationId ?? null;
  out.connector_id = cfg.connectorId ?? null;
  out.tally_company = cfg.tallyCompanyName ?? null;
  out.tally_port_9000 = await tcp(cfg.tallyHost ?? "127.0.0.1", cfg.tallyPort ?? 9000);
  if (cfg.deviceToken && cfg.pesoApiUrl) {
    out.backend = await heartbeat(cfg.pesoApiUrl, cfg.deviceToken);
  }
  const pass =
    out.config_exists &&
    out.backend.ok &&
    out.tally_port_9000 &&
    out.organization_id &&
    cfg.deviceToken;
  console.log(JSON.stringify({ ...out, final: pass ? "PREFLIGHT PASS" : "PREFLIGHT FAIL" }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
