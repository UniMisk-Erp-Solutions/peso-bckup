/**
 * GET /api/system-status — public endpoint for client polling.
 *
 * Wraps publicSystemStatusHandler in a crash-safe boundary so that any
 * unhandled exception always produces valid JSON — never an HTML 500.
 * Static import ensures module-resolution failures are caught at build time.
 */

import publicSystemStatusHandler from "./_handlers/publicSystemStatusHandler.js";

type VercelReq = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};
type VercelRes = {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => { json: (body: unknown) => void; end: () => void };
};

function makeFallbackId(): string {
  return `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default async function handler(req: VercelReq, res: VercelRes) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const fallbackId = makeFallbackId();
  res.setHeader("X-Request-Id", fallbackId);

  try {
    return await publicSystemStatusHandler(req, res);
  } catch (err) {
    console.error(
      "[system-status] handler execution failed:",
      err instanceof Error ? err.message : String(err),
    );
    return res.status(200).json({
      schema_version: 1,
      revision: "runtime_error",
      server_now: new Date().toISOString(),
      state: "unknown",
      blocking: false,
      source: "none",
      title: null,
      message: null,
      starts_at: null,
      ends_at: null,
      estimated_end_at: null,
      next_window: null,
      backend_health: { status: "unknown", checked_at: new Date().toISOString() },
      public_status_url: null,
      request_id: fallbackId,
      diagnostic_code: "system_status_handler_execution_failed",
    });
  }
}
