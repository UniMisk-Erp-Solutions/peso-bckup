/**
 * PesoWise <- TallyPrime (pwt inbound): "Sync from Tally" for employee balances.
 *
 *   start    (admin, user JWT)       create a reverse-sync job; the paired connector picks it up
 *   claim    (connector device token) hand the job to the connector, only if Tally's active company is the paired one
 *   submit   (connector)              store a chunk of fetched "PesoWise Payment" vouchers (idempotent)
 *   finish   (connector)              close the upload; the database validates the vouchers and credits balances
 *                                     through the existing balance engine (all rules live in SQL, not here)
 *
 * This function never writes balances itself and is independent of the outbound `pwt-connector` function.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { sha256Hex } from "../_shared/pwt/index.ts";

const MAX_BODY = 4_000_000; // ~100 vouchers per chunk is far below this

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return jsonResponse({ error: "Server misconfiguration" }, 500);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return jsonResponse({ error: "payload too large" }, 413);

  // deno-lint-ignore no-explicit-any
  let b: any;
  try {
    b = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return jsonResponse({ error: "Unauthorized" }, 401);

  // ---- admin: start a sync (user JWT; the database re-checks the admin role)
  if (b.action === "start") {
    const org = String(b.organization_id ?? "");
    if (!org) return jsonResponse({ error: "organization_id is required" }, 400);
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? key;
    // deno-lint-ignore no-explicit-any
    const user = createClient<any>(url, anon, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: u, error: ue } = await user.auth.getUser();
    if (ue || !u?.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const { data, error } = await user.rpc("pwt_inbound_create_job_v1", { p_organization_id: org });
    if (error) {
      const forbidden = /not permitted/i.test(error.message);
      return jsonResponse({ accepted: false, error: forbidden ? "Forbidden" : error.message.slice(0, 200) }, forbidden ? 403 : 400);
    }
    return jsonResponse({ accepted: true, job_id: (data as Record<string, unknown>).job_id, deduplicated: (data as Record<string, unknown>).deduplicated === true });
  }

  // ---- connector: device token (issued at pairing, only its hash is stored)
  // deno-lint-ignore no-explicit-any
  const svc = createClient<any>(url, key, { auth: { persistSession: false } });
  const { data: c } = await svc.rpc("pwt_connector_auth_v1", { p_token_hash: await sha256Hex(bearer) });
  if (!c) return jsonResponse({ error: "Unauthorized" }, 401);

  switch (b.action) {
    case "claim": {
      const { data, error } = await svc.rpc("pwt_inbound_claim_v1", { p_connector: c.id, p_active_company: b.active_company ?? null });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ job: data ?? null });
    }
    case "submit": {
      if (!b.job_id || !Array.isArray(b.vouchers)) return jsonResponse({ error: "job_id and vouchers are required" }, 400);
      const { data, error } = await svc.rpc("pwt_inbound_submit_v1", {
        p_connector: c.id, p_job: b.job_id, p_seq_start: Number(b.seq_start ?? 0), p_vouchers: b.vouchers, p_total: Number(b.total ?? 0),
      });
      if (error) return jsonResponse({ error: error.message }, 409);
      return jsonResponse({ result: data });
    }
    case "finish": {
      if (!b.job_id) return jsonResponse({ error: "job_id is required" }, 400);
      const { data, error } = await svc.rpc("pwt_inbound_finish_v1", {
        p_connector: c.id, p_job: b.job_id, p_total: Number(b.total ?? 0), p_error: b.error ? String(b.error).slice(0, 500) : null,
      });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ result: data });
    }
    default:
      return jsonResponse({ error: "unknown action" }, 400);
  }
});
