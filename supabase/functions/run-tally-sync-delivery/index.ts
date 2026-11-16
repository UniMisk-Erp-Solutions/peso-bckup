/**
 * Phase 5 — After `prepared`: map items → XML batches → persistent delivery queue.
 * Large jobs: prefer delivery inlined in run-tally-sync-job (same long-lived worker).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { enqueueDeliveryBatches } from "../_shared/tallySync/enqueueDeliveryBatches.ts";

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server misconfiguration");
  // deno-lint-ignore no-explicit-any
  return createClient<any>(url, key, { auth: { persistSession: false } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let svc;
  try {
    svc = serviceClient();
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (token !== serviceKey) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let jobId: string | null = null;
  try {
    const body = await req.json();
    if (body?.job_id) jobId = String(body.job_id);
  } catch {
    /* empty */
  }
  if (!jobId) return jsonResponse({ error: "job_id required" }, 400);

  try {
    const result = await enqueueDeliveryBatches(svc, jobId);
    return jsonResponse({ ...result, store: { job_status: result.job_status } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "delivery enqueue failed";
    const code = msg.includes("not enqueueable") ? 409 : msg.includes("not found") ? 404 : 500;
    return jsonResponse({ error: msg }, code);
  }
});
