/**
 * PesoWise -> Tally (pwt): "Sync to Tally" entry point called by the website.
 * Verifies the user, creates (or de-duplicates) a job via an admin-checked RPC, then hands the job to the
 * background worker. The browser never polls the worker and never sees Tally.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { PWT_REPORT_TYPES, sha256Hex, stableStringify } from "../_shared/pwt/index.ts";

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

const env = (n: string) => {
  const v = Deno.env.get(n);
  if (!v) throw new Error("Server misconfiguration");
  return v;
};

async function dispatch(jobId: string) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/pwt-run-job`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  });
  if (!res.ok) console.error("pwt-run-job dispatch failed", res.status, (await res.text()).slice(0, 300));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: { organization_id?: string; report_type?: string; parameters?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const org = body.organization_id;
  const report = body.report_type;
  if (!org || !report || !(PWT_REPORT_TYPES as readonly string[]).includes(report)) {
    return jsonResponse({ error: "organization_id and a valid report_type are required" }, 400);
  }
  const parameters = body.parameters && typeof body.parameters === "object" ? body.parameters : {};
  if (JSON.stringify(parameters).length > 20_000) return jsonResponse({ error: "parameters too large" }, 413);

  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");
  // deno-lint-ignore no-explicit-any
  const user = createClient<any>(env("SUPABASE_URL"), anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: u, error: ue } = await user.auth.getUser();
  if (ue || !u?.user) return jsonResponse({ error: "Unauthorized" }, 401);

  const hash = await sha256Hex(stableStringify({ report, parameters }));
  const { data, error } = await user.rpc("pwt_create_job_v1", {
    p_organization_id: org,
    p_report_type: report,
    p_parameters: parameters,
    p_parameters_hash: hash,
  });
  if (error) {
    const forbidden = /not permitted/i.test(error.message);
    return jsonResponse({ accepted: false, error: forbidden ? "Forbidden" : error.message.slice(0, 200) }, forbidden ? 403 : 400);
  }
  const jobId = String((data as Record<string, unknown>).job_id ?? "");
  const dedup = (data as Record<string, unknown>).deduplicated === true;
  if (jobId && !dedup) {
    const p = dispatch(jobId).catch((e) => console.error("pwt dispatch", e));
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p);
    else await p;
  }
  return jsonResponse({ accepted: true, job_id: jobId, deduplicated: dedup });
});
