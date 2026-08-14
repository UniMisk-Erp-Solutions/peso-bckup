/**
 * Implementation of GET /api/system-status — manual-maintenance-only read path.
 *
 * Reads the system_status document from Edge Config and evaluates it using
 * server time. Does NOT contact Supabase, does NOT probe any backend health
 * endpoint. Supabase being unavailable cannot activate maintenance through
 * this endpoint.
 *
 * This is why users can see the maintenance screen even when Supabase is down.
 */

import { buildSystemStatusStore } from "../_lib/edgeConfigSystemStatusStore.js";
import { evaluateSystemStatus } from "../_lib/systemStatusEvaluator.js";
import { isSystemStatusControlEnabled } from "../_lib/systemStatusFeature.js";

type VercelReq = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};
type VercelRes = {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => { json: (body: unknown) => void; end: () => void };
};

function makeRequestId(): string {
  return `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getPublicStatusUrl(): string | null {
  return process.env.PUBLIC_STATUS_URL || null;
}

let storePromise: ReturnType<typeof buildSystemStatusStore> | null = null;
function getStore() {
  if (!storePromise) storePromise = buildSystemStatusStore();
  return storePromise;
}

export default async function handler(req: VercelReq, res: VercelRes) {
  const requestId = makeRequestId();

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", request_id: requestId });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Request-Id", requestId);

  const serverNow = new Date();
  const backendHealth = { status: "unknown" as const, checked_at: serverNow.toISOString() };

  // Feature disabled — return static operational response without touching Edge Config.
  if (!isSystemStatusControlEnabled()) {
    return res.status(200).json({
      schema_version: 1,
      revision: "system_status_disabled",
      server_now: serverNow.toISOString(),
      state: "operational",
      blocking: false,
      source: "none",
      title: null,
      message: null,
      starts_at: null,
      ends_at: null,
      estimated_end_at: null,
      next_window: null,
      backend_health: backendHealth,
      public_status_url: null,
      feature_enabled: false,
      request_id: requestId,
    });
  }

  try {
    const store = await getStore();
    const readResult = await store.read();
    const doc = readResult.ok ? readResult.doc : null;

    if (!doc) {
      return res.status(200).json({
        schema_version: 1,
        revision: "store_unavailable",
        server_now: serverNow.toISOString(),
        state: "unknown",
        blocking: false,
        source: "none",
        title: null,
        message: null,
        starts_at: null,
        ends_at: null,
        estimated_end_at: null,
        next_window: null,
        backend_health: backendHealth,
        public_status_url: getPublicStatusUrl(),
        request_id: requestId,
      });
    }

    const status = evaluateSystemStatus(doc, {
      serverNow,
      backendHealth,
      publicStatusUrl: getPublicStatusUrl(),
    });

    return res.status(200).json({ ...status, request_id: requestId });
  } catch (err) {
    console.error("[system-status] unhandled error:", err instanceof Error ? err.message : String(err));
    return res.status(200).json({
      schema_version: 1,
      revision: "error",
      server_now: serverNow.toISOString(),
      state: "unknown",
      blocking: false,
      source: "none",
      title: null,
      message: null,
      starts_at: null,
      ends_at: null,
      estimated_end_at: null,
      next_window: null,
      backend_health: backendHealth,
      public_status_url: getPublicStatusUrl(),
      request_id: requestId,
    });
  }
}
