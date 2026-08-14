/**
 * GET + POST /api/master/maintenance — Master Admin maintenance control.
 *
 * Implementation is inlined here (no dynamic import) to avoid Vercel ESM
 * bundling issues with dynamic relative imports in "type": "module" projects.
 */

import { buildSystemStatusStore, getStoreDiagnostics } from "../_lib/edgeConfigSystemStatusStore.js";
import { verifyMasterAdmin } from "../_lib/verifyMasterAdmin.js";
import { getSystemStatusEnvironmentDiagnostics } from "../_lib/systemStatusEnvironment.js";
import { isSystemStatusControlEnabled } from "../_lib/systemStatusFeature.js";
import {
  validateManualMaintenance,
  validateWindow,
  evaluateSystemStatus,
} from "../_lib/systemStatusEvaluator.js";
import type { MaintenanceWritePayload } from "../_lib/systemStatusTypes.js";

type VercelReq = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type VercelRes = {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => { json: (body: unknown) => void; end: () => void };
};

function getHeader(req: VercelReq, name: string): string {
  const v = req.headers[name.toLowerCase()] ?? req.headers[name];
  if (Array.isArray(v)) return v[0] ?? "";
  return String(v ?? "");
}

function makeRequestId(): string {
  return `ma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isValidPayload(body: unknown): body is MaintenanceWritePayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.action === "string" &&
    ["start_manual", "end_manual", "create_window", "cancel_window",
     "publish_announcement", "clear_announcement"].includes(b.action) &&
    typeof b.revision === "string"
  );
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return res.status(200).end();
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Request-Id", requestId);

  // Feature disabled — no auth, no store access, no Edge Config reads/writes.
  if (!isSystemStatusControlEnabled()) {
    return res.status(503).json({
      ok: false,
      code: "system_status_control_temporarily_disabled",
      error: "Maintenance controls are temporarily unavailable.",
      feature_enabled: false,
      request_id: requestId,
    });
  }

  const authHeader = getHeader(req, "authorization");
  const authResult = await verifyMasterAdmin(authHeader || undefined);
  if (authResult.ok === false) {
    return res.status(authResult.status).json({
      ok: false,
      code: authResult.code,
      error: authResult.error,
      ...(authResult.missingVariables ? { missingVariables: authResult.missingVariables } : {}),
      request_id: requestId,
    });
  }

  if (req.method === "GET") {
    const store = await getStore();
    const diagnostics = getStoreDiagnostics(store);
    const env = getSystemStatusEnvironmentDiagnostics();
    const serverNow = new Date();

    if (diagnostics.provider === "unavailable") {
      return res.status(503).json({
        ok: false,
        code: "maintenance_store_not_configured",
        error: "Maintenance store is not configured for this environment.",
        missingVariables: [...env.missingReadVars, ...env.missingWriteVars],
        store: diagnostics,
        server_time: serverNow.toISOString(),
        request_id: requestId,
      });
    }

    const readResult = await store.read();
    if (readResult.ok === false) {
      return res.status(503).json({
        ok: false,
        code: "maintenance_store_read_failed",
        error: readResult.error,
        store: diagnostics,
        server_time: serverNow.toISOString(),
        request_id: requestId,
      });
    }

    const doc = readResult.doc;
    const publicStatus = evaluateSystemStatus(doc, {
      serverNow,
      backendHealth: { status: "unknown", checked_at: serverNow.toISOString() },
      publicStatusUrl: process.env.PUBLIC_STATUS_URL ?? null,
    });

    return res.status(200).json({
      ok: true,
      document: doc,
      public_status: publicStatus,
      store: diagnostics,
      server_time: serverNow.toISOString(),
      request_id: requestId,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", request_id: requestId });
  }

  const body = req.body;
  if (!isValidPayload(body)) {
    return res.status(400).json({
      ok: false,
      code: "maintenance_invalid_payload",
      error: "Invalid payload: missing action or revision",
      request_id: requestId,
    });
  }

  const serverNow = new Date();

  if (body.action === "start_manual") {
    const err = validateManualMaintenance({
      title: String(body.title ?? ""),
      message: String(body.message ?? ""),
      estimated_end_at:
        body.estimated_end_at != null ? String(body.estimated_end_at) : null,
    });
    if (err) {
      return res.status(400).json({ ok: false, code: "maintenance_invalid_payload", error: err, request_id: requestId });
    }
  }

  const store = await getStore();
  const diagnostics = getStoreDiagnostics(store);

  if (diagnostics.provider === "unavailable") {
    const env = getSystemStatusEnvironmentDiagnostics();
    return res.status(503).json({
      ok: false,
      code: "maintenance_store_not_configured",
      error: "Maintenance store is not configured for this environment.",
      missingVariables: [...env.missingReadVars, ...env.missingWriteVars],
      request_id: requestId,
    });
  }

  if (body.action === "create_window") {
    const readResult = await store.read();
    if (readResult.ok === false) {
      return res.status(503).json({
        ok: false,
        code: "maintenance_store_read_failed",
        error: readResult.error,
        request_id: requestId,
      });
    }
    const err = validateWindow(
      {
        title: String((body as Record<string, unknown>).title ?? ""),
        message: String((body as Record<string, unknown>).message ?? ""),
        starts_at: String((body as Record<string, unknown>).starts_at ?? ""),
        ends_at: String((body as Record<string, unknown>).ends_at ?? ""),
        announce_from: String((body as Record<string, unknown>).announce_from ?? ""),
      },
      readResult.doc.windows,
    );
    if (err) {
      return res.status(400).json({ ok: false, code: "maintenance_invalid_payload", error: err, request_id: requestId });
    }
  }

  const writeResult = await store.write(body, serverNow);

  if (writeResult.ok === false) {
    if (writeResult.conflict === true) {
      return res.status(409).json({
        ok: false,
        code: "stale_revision",
        error: writeResult.error,
        conflict: true,
        request_id: requestId,
      });
    }
    if (writeResult.error?.includes("maintenance_store_not_configured")) {
      const env = getSystemStatusEnvironmentDiagnostics();
      return res.status(503).json({
        ok: false,
        code: "maintenance_store_not_configured",
        error: "Maintenance store is not configured for this environment.",
        missingVariables: [...env.missingWriteVars],
        request_id: requestId,
      });
    }
    return res.status(500).json({
      ok: false,
      code: "maintenance_store_write_failed",
      error: writeResult.error,
      request_id: requestId,
    });
  }

  console.info(
    `[maintenance] ${body.action} by ${authResult.email} (${authResult.userId}) at ${serverNow.toISOString()}`,
  );

  const savedDoc = writeResult.doc;
  const publicStatus = evaluateSystemStatus(savedDoc, {
    serverNow,
    backendHealth: { status: "unknown", checked_at: serverNow.toISOString() },
    publicStatusUrl: process.env.PUBLIC_STATUS_URL ?? null,
  });

  return res.status(200).json({
    ok: true,
    revision: savedDoc.revision,
    document: savedDoc,
    public_status: publicStatus,
    server_time: serverNow.toISOString(),
    request_id: requestId,
  });
}
