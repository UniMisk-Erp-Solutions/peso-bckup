import http from "node:http";
import { isMetadataImportReady, loadConfig, saveConfig } from "./config.js";
import { log } from "./logger.js";
import { deliverEntireJob } from "./deliverJob.js";
import { AGENT_VERSION } from "./doctor.js";
import { TallyClient } from "./tallyClient.js";
import { PesoConnectorApi } from "./pesoApi.js";

export const LOCAL_BRIDGE_HOST = "127.0.0.1";
export const LOCAL_BRIDGE_PORT = 9876;
const HEARTBEAT_INTERVAL_MS = 60_000;

let deliverInFlight: Promise<unknown> | null = null;
let deliverInFlightJobId: string | null = null;

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow =
    origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin : "http://localhost:3000";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export function startLocalBridge(): http.Server {
  // The desktop bridge serves explicit, job-scoped delivery requests from the
  // Reports UI. Publish liveness separately; this heartbeat never claims work.
  try {
    const cfg = loadConfig();
    if (cfg.deviceToken) {
      const api = new PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
      const heartbeat = () => {
        void api.heartbeat(AGENT_VERSION).catch((error: unknown) => {
          log(`Connector heartbeat failed: ${(error as Error).message}`);
        });
      };
      heartbeat();
      const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
      timer.unref();
    }
  } catch (error) {
    log(`Connector heartbeat not started: ${(error as Error).message}`);
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(typeof origin === "string" ? origin : undefined);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method === "GET" && (req.url === "/v1/health" || req.url === "/v1/status")) {
      void (async () => {
        let paired = false;
        let tallyReachable = false;
        let companyName: string | null = null;
        let companyVerified = false;
        let companyVerifiedName: string | null = null;
        let metaReady = false;
        try {
          const cfg = loadConfig();
          metaReady = isMetadataImportReady(cfg, AGENT_VERSION);
        } catch { /* unconfigured means not ready */ }
        const companyOnHttp: boolean | null = null;
        try {
          const cfg = loadConfig();
          paired = Boolean(cfg.deviceToken);
          companyName = cfg.tallyCompanyName?.trim() || null;
          const tally = new TallyClient({
            host: cfg.tallyHost,
            port: cfg.tallyPort,
            companyName: cfg.tallyCompanyName,
          });
          tallyReachable = await tally.isReachable();
          if (paired && tallyReachable && companyName) {
            const check = await tally.verifyActiveCompany(companyName);
            companyVerified = check.verified;
            companyVerifiedName = check.verified ? check.companyName : null;
          }
        } catch {
          /* not paired yet */
        }
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            service: "pesowise-tally-bridge",
            delivery_in_progress: deliverInFlight != null,
            delivery_job_id: deliverInFlightJobId,
            connector_paired: paired,
            tally_reachable: tallyReachable,
            tally_company_name: companyName,
            tally_company_verified: companyVerified,
            tally_company_verified_name: companyVerifiedName,
            organization_id: loadSafeOrganizationId(),
            tally_company_on_http: companyOnHttp,
            metadata_import_ready: metaReady,
          }),
        );
      })();
      return;
    }

    if (req.method === "POST" && req.url === "/v1/config") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}") as { tally_company_name?: string };
          const name = String(parsed.tally_company_name ?? "").trim();
          if (!name) {
            res.writeHead(400, { ...cors, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "tally_company_name required" }));
            return;
          }
          const existing = loadConfig();
          saveConfig(name === existing.tallyCompanyName?.trim()
            ? { tallyCompanyName: name }
            : { tallyCompanyName: name, metadataReadyCompany: undefined, metadataReadyVersion: undefined });
          res.writeHead(200, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, tally_company_name: name }));
        } catch (e) {
          res.writeHead(500, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/deliver-job") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        void (async () => {
          let jobId = "";
          try {
            const parsed = JSON.parse(body || "{}") as { job_id?: string };
            jobId = String(parsed.job_id ?? "").trim();
            if (!jobId) {
              res.writeHead(400, { ...cors, "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "job_id required" }));
              return;
            }
            const cfg = loadConfig();
            if (!isMetadataImportReady(cfg, AGENT_VERSION)) {
              res.writeHead(412, { ...cors, "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "tally_metadata_setup_unverified" }));
              return;
            }
            if (deliverInFlight) {
              if (deliverInFlightJobId === jobId) {
                res.writeHead(202, { ...cors, "Content-Type": "application/json" });
                res.end(JSON.stringify({ accepted: true, job_id: jobId, already_in_progress: true }));
                return;
              }
              res.writeHead(409, { ...cors, "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: "delivery_in_progress",
                job_id: deliverInFlightJobId,
              }));
              return;
            }
            res.writeHead(202, { ...cors, "Content-Type": "application/json" });
            res.end(JSON.stringify({ accepted: true, job_id: jobId }));

            deliverInFlightJobId = jobId;
            deliverInFlight = deliverEntireJob(cfg, jobId, AGENT_VERSION).finally(() => {
              deliverInFlight = null;
              deliverInFlightJobId = null;
            });
            const result = await deliverInFlight;
            log(`bridge deliver-job finished: ${JSON.stringify(result)}`);
          } catch (e) {
            log(`bridge error: ${(e as Error).message}`);
          }
        })();
      });
      return;
    }

    res.writeHead(404, cors);
    res.end();
  });

  server.listen(LOCAL_BRIDGE_PORT, LOCAL_BRIDGE_HOST, () => {
    log(`Local Tally bridge http://${LOCAL_BRIDGE_HOST}:${LOCAL_BRIDGE_PORT}`);
  });
  return server;
}

function loadSafeOrganizationId(): string | null {
  try { return loadConfig().organizationId ?? null; } catch { return null; }
}

/** HTTP bridge only. Delivery is explicitly scoped to a job from the Sync button. */
export function startServeMode(): void {
  startLocalBridge();
  log("Bridge ready; it will deliver only explicitly requested Sync jobs after company verification.");
}
