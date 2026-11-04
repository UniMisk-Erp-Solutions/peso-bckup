/**
 * PesoWise -> Tally (pwt) deletion sync: connector API. Called by the Windows connector over HTTPS only.
 *   claim  hand out the next queued correction (only while Tally's active company is the paired one)
 *   ack    report the outcome: completed | blocked | retry
 * Detection (trigger + scan) and every rule about what is queued live in the database; this function only
 * authenticates the device token and forwards. It is independent of pwt-connector and pwt-inbound.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { sha256Hex } from "../_shared/pwt/index.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return jsonResponse({ error: "Server misconfiguration" }, 500);
  // deno-lint-ignore no-explicit-any
  let b: any;
  try {
    b = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return jsonResponse({ error: "Unauthorized" }, 401);
  // deno-lint-ignore no-explicit-any
  const svc = createClient<any>(url, key, { auth: { persistSession: false } });
  const { data: c } = await svc.rpc("pwt_connector_auth_v1", { p_token_hash: await sha256Hex(bearer) });
  if (!c) return jsonResponse({ error: "Unauthorized" }, 401);

  switch (b.action) {
    case "claim": {
      const { data, error } = await svc.rpc("pwt_deletion_claim_v1", { p_connector: c.id, p_active_company: b.active_company ?? null });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ job: data ?? null });
    }
    case "ack": {
      if (!b.job_id) return jsonResponse({ error: "job_id required" }, 400);
      const { data, error } = await svc.rpc("pwt_deletion_ack_v1", {
        p_connector: c.id,
        p_job: b.job_id,
        p_outcome: String(b.outcome ?? ""),
        p_action: b.correction ? String(b.correction) : null,
        p_result: b.result ?? null,
        p_error: b.error ? String(b.error).slice(0, 1000) : null,
      });
      if (error) return jsonResponse({ error: error.message }, 400);
      return jsonResponse({ result: data });
    }
    default:
      return jsonResponse({ error: "unknown action" }, 400);
  }
});
