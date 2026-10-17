/**
 * PesoWise -> Tally (pwt) connector API. Called by the Windows connector over HTTPS only.
 * Actions: pair | heartbeat | claim | ack. All but `pair` require the device token issued at pairing.
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
  const svc = createClient<any>(url, key, { auth: { persistSession: false } });

  // deno-lint-ignore no-explicit-any
  let b: any;
  try {
    b = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (b.action === "pair") {
    const code = String(b.code ?? "").trim().toUpperCase();
    if (code.length < 8) return jsonResponse({ error: "invalid pairing code" }, 400);
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const { data, error } = await svc.rpc("pwt_pair_v1", {
      p_code_hash: await sha256Hex(code),
      p_token_hash: await sha256Hex(token),
      p_device: String(b.device_name ?? "").slice(0, 120),
      p_version: String(b.tally_version ?? "").slice(0, 40),
    });
    if (error) return jsonResponse({ error: "invalid or expired pairing code" }, 401);
    return jsonResponse({ ...(data as object), device_token: token });
  }

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return jsonResponse({ error: "Unauthorized" }, 401);
  const { data: c } = await svc.rpc("pwt_connector_auth_v1", { p_token_hash: await sha256Hex(bearer) });
  if (!c) return jsonResponse({ error: "Unauthorized" }, 401);

  switch (b.action) {
    case "heartbeat": {
      await svc.rpc("pwt_heartbeat_connector_v1", {
        p_connector: c.id,
        p_active_company: b.active_company ?? null,
        p_version: b.tally_version ?? null,
        p_error: b.error ?? null,
      });
      return jsonResponse({ ok: true, paired_company: c.tally_company });
    }
    case "claim": {
      const { data, error } = await svc.rpc("pwt_claim_batch_v1", {
        p_connector: c.id,
        p_active_company: b.active_company ?? null,
      });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ batch: data ?? null });
    }
    case "ack": {
      if (!b.batch_id) return jsonResponse({ error: "batch_id required" }, 400);
      const { data, error } = await svc.rpc("pwt_ack_batch_v1", {
        p_connector: c.id,
        p_batch: b.batch_id,
        p_verified: b.verified === true,
        p_response: b.response ?? null,
        p_error: b.error ?? null,
        p_permanent: b.permanent === true,
      });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ result: data });
    }
    default:
      return jsonResponse({ error: "unknown action" }, 400);
  }
});
