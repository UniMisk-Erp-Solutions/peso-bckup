/**
 * PesoWise -> Tally (pwt) background worker. Service-role only.
 * queued -> preparing -> delivering. "completed" is only ever set by the connector acknowledgement after Tally readback (pwt_ack_batch_v1).
 *
 * Preparation runs in short SLICES (the edge runtime cancels a single request after ~12 s): each call reads or plans for a few seconds,
 * saves where it stopped, and returns { done, phase, progress }. The caller asks again until done. See _shared/pwt/slice.ts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { runPrepSlice, type PwtAccountingConfig } from "../_shared/pwt/index.ts";

type Row = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return jsonResponse({ error: "Server misconfiguration" }, 500);
  if (req.headers.get("Authorization") !== `Bearer ${key}`) return jsonResponse({ error: "Unauthorized" }, 401);

  const { job_id } = await req.json().catch(() => ({}));
  if (!job_id) return jsonResponse({ error: "job_id required" }, 400);

  // deno-lint-ignore no-explicit-any
  const svc = createClient<any>(url, key, { auth: { persistSession: false } });
  try {
    const out = await runPrepSlice({
      rpc: (n, a) => svc.rpc(n, a) as never,
      dailyConfig: async (org) => {
        const { data, error } = await svc.from("organization_settings").select("daily_expense_report_config")
          .eq("organization_id", org).maybeSingle();
        if (error) throw new Error(error.message);
        return (data?.daily_expense_report_config ?? {}) as Row;
      },
      mappingConfig: async (org) => {
        const { data, error } = await svc.from("pwt_mapping_config").select("config").eq("organization_id", org).maybeSingle();
        if (error) throw new Error(error.message);
        return (data?.config ?? null) as Partial<PwtAccountingConfig> | null;
      },
    }, String(job_id));
    return jsonResponse(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("pwt-run-job failed", msg);
    return jsonResponse({ claimed: true, done: false, error: msg.slice(0, 200) }, 500);
  }
});
