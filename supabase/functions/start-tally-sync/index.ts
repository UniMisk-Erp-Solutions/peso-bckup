/**
 * Phase 3.6 — Single admin request: enqueue + dispatch worker server-side.
 * Browser must not invoke run-tally-sync-job or poll job status.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

type Body = {
  organization_id?: string;
  report_type?: string;
  parameters?: Record<string, unknown>;
};

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error("Server misconfiguration");
  return v;
}

async function dispatchWorker(jobId: string): Promise<void> {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${url}/functions/v1/run-tally-sync-job`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ job_id: jobId }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("run-tally-sync-job dispatch failed:", res.status, text.slice(0, 500));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const orgId = body.organization_id;
  const reportType = body.report_type;
  const parameters = body.parameters ?? {};
  if (!orgId || !reportType) {
    return jsonResponse({ error: "organization_id and report_type are required" }, 400);
  }

  const url = env("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!anonKey) return jsonResponse({ error: "Server misconfiguration" }, 500);

  // User-scoped client so create_tally_sync_job_v1 sees auth.uid() and admin RLS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userClient = createClient<any>(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const { data: created, error: createErr } = await userClient.rpc("create_tally_sync_job_v1", {
    p_organization_id: orgId,
    p_report_type: reportType,
    p_parameters: parameters,
  });
  if (createErr) {
    const msg = createErr.message.includes("not permitted")
      ? "Forbidden"
      : createErr.message.slice(0, 200);
    const code = createErr.message.includes("not permitted") ? 403 : 400;
    return jsonResponse({ error: msg, accepted: false }, code);
  }

  const jobId = String((created as Record<string, unknown>).job_id ?? "");
  if (!jobId) {
    return jsonResponse({ error: "Could not create job", accepted: false }, 500);
  }

  // Processing continues after HTTP response (browser-independent).
  const bg = dispatchWorker(jobId).catch((e) =>
    console.error("tally worker background dispatch:", e)
  );
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(bg);
  } else {
    await bg;
  }

  return jsonResponse({
    accepted: true,
    job_id: jobId,
    deduplicated: (created as Record<string, unknown>).deduplicated === true,
  });
});
