/**
 * Phase 5 — Connector API (device token auth): heartbeat, claim batch, ack.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";

type Svc = ReturnType<typeof createClient<any>>;

function serviceClient(): Svc {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server misconfiguration");
  // deno-lint-ignore no-explicit-any
  return createClient<any>(url, key, { auth: { persistSession: false } });
}

function connectorToken(req: Request): string | null {
  const h = req.headers.get("X-Connector-Token") ?? req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  return h && h.length >= 32 ? h : null;
}

async function resolveDevice(svc: Svc, token: string) {
  const { data, error } = await svc.rpc("resolve_tally_connector_device_v1", { p_bearer_token: token });
  if (error || !data) return null;
  return data as { connector_id: string; organization_id: string; device_name: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const token = connectorToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401);

  const svc = serviceClient();
  const device = await resolveDevice(svc, token);
  if (!device) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const action = String(body.action ?? new URL(req.url).searchParams.get("action") ?? "");

  try {
    if (action === "heartbeat") {
      const { error } = await svc.rpc("connector_heartbeat_v1", {
        p_connector_id: device.connector_id,
        p_version: body.version ? String(body.version) : null,
      });
      if (error) return jsonResponse({ error: "revoked" }, 403);
      return jsonResponse({ ok: true, connector_id: device.connector_id });
    }

    if (action === "claim") {
      const { data, error } = await svc.rpc("connector_claim_delivery_batch_v1", {
        p_connector_id: device.connector_id,
        p_lease_seconds: body.lease_seconds ? Number(body.lease_seconds) : 300,
        p_job_id: body.job_id ? String(body.job_id) : null,
        p_batch_id: body.batch_id ? String(body.batch_id) : null,
        p_expected_company_name: body.expected_company_name ? String(body.expected_company_name) : null,
      });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse(data);
    }

    if (action === "job_batches") {
      const jobId = body.job_id ? String(body.job_id) : null;
      if (!jobId) return jsonResponse({ error: "job_id required" }, 400);
      const offsetRaw = Number(body.offset ?? 0);
      const limitRaw = Number(body.limit ?? 1000);
      if (!Number.isSafeInteger(offsetRaw) || offsetRaw < 0) {
        return jsonResponse({ error: "offset must be a non-negative integer" }, 400);
      }
      if (!Number.isSafeInteger(limitRaw) || limitRaw < 1) {
        return jsonResponse({ error: "limit must be a positive integer" }, 400);
      }
      const offset = Math.min(offsetRaw, 100_000);
      const limit = Math.min(limitRaw, 1000);
      const { data: job, error: jobErr } = await svc
        .from("tally_sync_jobs")
        .select("id, organization_id")
        .eq("id", jobId)
        .maybeSingle();
      if (jobErr || !job) return jsonResponse({ error: "job not found" }, 404);
      if (String(job.organization_id) !== String(device.organization_id)) {
        return jsonResponse({ error: "job organization mismatch" }, 403);
      }
      const { data: batches, error: bErr, count } = await svc
        .from("tally_sync_delivery_batches")
        .select("id, status, batch_index, message_count", { count: "exact" })
        .eq("job_id", jobId)
        .order("batch_index", { ascending: true })
        .range(offset, offset + limit - 1);
      if (bErr) return jsonResponse({ error: bErr.message }, 500);
      return jsonResponse({ job_id: jobId, batches: batches ?? [], total_count: count ?? 0 });
    }

    if (action === "ack") {
      const batchId = body.batch_id ? String(body.batch_id) : null;
      if (!batchId) return jsonResponse({ error: "batch_id required" }, 400);
      const { data, error } = await svc.rpc("connector_ack_delivery_batch_v1", {
        p_connector_id: device.connector_id,
        p_batch_id: batchId,
        p_success: body.success === true,
        p_ack_summary: body.ack_summary ?? {},
        p_tally_response_safe: body.tally_response_safe ? String(body.tally_response_safe).slice(0, 4000) : null,
        p_error_safe: body.error_safe ? String(body.error_safe).slice(0, 500) : null,
        p_delivery_updates: body.delivery_updates ?? [],
      });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse(data);
    }

    return jsonResponse({ error: "unknown action" }, 400);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
