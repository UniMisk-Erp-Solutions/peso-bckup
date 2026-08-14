/**
 * GET + POST /api/master/announcement — Broadcast announcement control.
 *
 * Implementation is inlined here (no dynamic import) to avoid Vercel ESM
 * bundling issues with dynamic relative imports in "type": "module" projects.
 */

import { buildSystemStatusStore, getStoreDiagnostics } from "../_lib/edgeConfigSystemStatusStore.js";
import { verifyMasterAdmin } from "../_lib/verifyMasterAdmin.js";
import { getSystemStatusEnvironmentDiagnostics } from "../_lib/systemStatusEnvironment.js";
import { isSystemStatusControlEnabled } from "../_lib/systemStatusFeature.js";
import type { PublishAnnouncementPayload, ClearAnnouncementPayload } from "../_lib/systemStatusTypes.js";

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
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

type AnnouncementWritePayload = PublishAnnouncementPayload | ClearAnnouncementPayload;

function isValidPayload(body: unknown): body is AnnouncementWritePayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.action === "string" &&
    ["publish_announcement", "clear_announcement"].includes(b.action) &&
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
      error: "Broadcast announcements are temporarily unavailable.",
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

  const store = await getStore();
  const diagnostics = getStoreDiagnostics(store);
  const env = getSystemStatusEnvironmentDiagnostics();

  if (diagnostics.provider === "unavailable") {
    return res.status(503).json({
      ok: false,
      code: "announcement_store_not_configured",
      error: "Announcement store is not configured for this environment.",
      missingVariables: [...env.missingReadVars, ...env.missingWriteVars],
      store: diagnostics,
      request_id: requestId,
    });
  }

  if (req.method === "GET") {
    const readResult = await store.read();
    if (readResult.ok === false) {
      return res.status(503).json({
        ok: false,
        code: "announcement_store_read_failed",
        error: readResult.error,
        store: diagnostics,
        request_id: requestId,
      });
    }
    return res.status(200).json({
      ok: true,
      announcement: readResult.doc.announcement ?? null,
      revision: readResult.doc.revision,
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
      code: "announcement_invalid_payload",
      error: "Invalid payload: action must be publish_announcement or clear_announcement, and revision is required",
      request_id: requestId,
    });
  }

  if (body.action === "publish_announcement") {
    const title = String((body as Record<string, unknown>).title ?? "").trim();
    const message = String((body as Record<string, unknown>).message ?? "").trim();
    if (!title) {
      return res.status(400).json({ ok: false, code: "announcement_invalid_payload", error: "Title is required", request_id: requestId });
    }
    if (title.length > 200) {
      return res.status(400).json({ ok: false, code: "announcement_invalid_payload", error: "Title must be 200 characters or fewer", request_id: requestId });
    }
    if (!message) {
      return res.status(400).json({ ok: false, code: "announcement_invalid_payload", error: "Message is required", request_id: requestId });
    }
    if (message.length > 2000) {
      return res.status(400).json({ ok: false, code: "announcement_invalid_payload", error: "Message must be 2000 characters or fewer", request_id: requestId });
    }
  }

  const serverNow = new Date();
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
    return res.status(500).json({
      ok: false,
      code: "announcement_store_write_failed",
      error: writeResult.error,
      request_id: requestId,
    });
  }

  return res.status(200).json({
    ok: true,
    announcement: writeResult.doc.announcement ?? null,
    revision: writeResult.doc.revision,
    request_id: requestId,
  });
}
