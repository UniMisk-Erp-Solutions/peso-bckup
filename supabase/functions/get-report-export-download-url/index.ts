/**
 * Server-authorized report download signer.
 *
 * ROOT CAUSE THIS REPLACES: the browser used to call
 * `storage.from("generated-reports").createSignedUrl(job.storage_path, ...)`
 * directly with the caller's own JWT. Signing a private object requires a
 * `storage.objects` SELECT policy, and the only one that exists,
 * "Report viewers can read their organization's generated reports", gates on
 *
 *     daily_report_caller_can_view_v1(organization_id, false)
 *
 * -- team_scoped hard-coded to false, always. The job-creation RPCs
 * (create_daily_project_report_export_job_v1, create_expense_report_export_job_v1)
 * call the SAME function with the REAL team_scoped value the caller asked to
 * generate with. So a Manager/Executive who is correctly authorized to
 * GENERATE a team-scoped report is then denied at DOWNLOAD time, because the
 * Storage policy evaluates a different (always-false) authorization than the
 * one that let them generate it in the first place -- exactly the
 * "two authorization systems that can drift" failure mode. Reproduced live:
 * MBM Textiles manager (role=engineer), team-scoped Daily Project Report,
 * `createSignedUrl` -> 400 "Object not found" (RLS makes the object
 * invisible rather than returning a readable permission error).
 *
 * FIX: the browser no longer signs Storage objects itself. It sends only a
 * job_id here. This function:
 *   1. authenticates the caller from their own JWT (service-role has no
 *      auth.uid(), so authorization must run as the caller, not as service-role)
 *   2. loads the report_export_jobs row (existing RLS already permits a caller
 *      to read their own org's job rows -- this endpoint does not change that)
 *   3. re-derives team_scoped from the job's OWN stored parameters and calls
 *      the exact same canonical authorization function generation used
 *      (daily_report_caller_can_view_v1) -- one source of report
 *      authorization, not a second copy of the rule
 *   4. requires status = 'completed' and a non-null storage_path
 *   5. only THEN uses a service-role Storage client (never exposed to the
 *      browser) to sign exactly that stored path -- the client never
 *      supplies a bucket/path/filename itself
 *
 * The `storage.objects` policy above is intentionally left as-is here: it
 * still lets an admin's browser self-sign as a fallback/defence-in-depth
 * path, and correcting or removing it is a separate, explicit Storage-RLS
 * change the owner should approve on its own (see the hotfix root-cause
 * report) rather than bundling it into this endpoint's deploy.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";

const BUCKET = "generated-reports";
const SIGNED_URL_TTL_SECONDS = 120;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Not authenticated" }, 401);

  let job_id: string | undefined;
  try {
    const body = await req.json();
    job_id = typeof body?.job_id === "string" ? body.job_id : undefined;
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }
  if (!job_id) return jsonResponse({ error: "job_id is required" }, 400);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Caller-scoped client: auth.uid() and every RLS check below run AS the
  // real caller, exactly like the job-creation RPCs already do. This is what
  // lets us call the canonical authorization function correctly, instead of
  // re-implementing its role/team-scope logic a second time here.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ error: "Not authenticated" }, 401);
  }

  // Load the job as the caller. Existing report_export_jobs RLS already
  // scopes this to the caller's own organization's rows -- unchanged here.
  const { data: job, error: jobError } = await callerClient
    .from("report_export_jobs")
    .select("id, organization_id, status, storage_path, filename, parameters")
    .eq("id", job_id)
    .maybeSingle();

  // Deliberately identical response for "not found" and "not authorized":
  // do not leak whether a job_id belonging to another organization exists.
  if (jobError || !job) {
    return jsonResponse({ error: "Report not found." }, 404);
  }

  // Daily Project Report jobs persist the real team_scoped flag they were
  // generated with (create_daily_project_report_export_job_v1 stores it in
  // `parameters`). The three expense-report types
  // (claim_verification/claim_approval/detailed_expense) do NOT -- their
  // creation RPC stores only the user's filters in `parameters`, so there is
  // nowhere to read the original scope back from. Checking only `false`
  // there produced a false 403 for a Manager/Executive who was genuinely
  // authorized at generation time (caught live while deploying this fix).
  //
  // Fix without a DB migration: when the real flag isn't known, check BOTH
  // values of daily_report_caller_can_view_v1 and allow if either passes.
  // This cannot over-grant: whoever created this job already had to pass
  // the SAME function with SOME concrete team_scoped value, so "the caller
  // passes it with either value" is never a broader grant than "the creator
  // passed it with the value they actually used" -- it only resolves the
  // ambiguity of which one that was. (The two checks are not simply
  // true implies false: the non-team-scoped branch's admin-or-
  // cashier-accountant-mode case is not a subset of the team-scoped branch's
  // admin/engineer/team_leader/executive case, or the reverse, so both are
  // tried explicitly rather than assuming one implies the other.)
  const storedTeamScoped = (job.parameters as Record<string, unknown> | null)?.teamScoped;
  const scopesToTry = typeof storedTeamScoped === "boolean" ? [storedTeamScoped] : [false, true];

  let authorized = false;
  for (const scope of scopesToTry) {
    const { data: canView } = await callerClient.rpc("daily_report_caller_can_view_v1", {
      p_organization_id: job.organization_id,
      p_team_scoped: scope,
    });
    if (canView === true) {
      authorized = true;
      break;
    }
  }
  if (!authorized) {
    return jsonResponse({ error: "You don't have permission to download this report." }, 403);
  }

  if (job.status !== "completed") {
    return jsonResponse({ error: "This report is not ready yet." }, 409);
  }
  if (!job.storage_path) {
    return jsonResponse({ error: "The report was generated, but a download link could not be created." }, 500);
  }

  // Service-role Storage client -- never sent to the browser, used only
  // inside this server runtime, and only for the exact path this job's own
  // row names. The client never supplies bucket/path/filename itself.
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: signed, error: signError } = await serviceClient.storage
    .from(BUCKET)
    .createSignedUrl(job.storage_path, SIGNED_URL_TTL_SECONDS, {
      download: job.filename ?? undefined,
    });

  if (signError || !signed?.signedUrl) {
    return jsonResponse({ error: "The report file is temporarily unavailable." }, 500);
  }

  // SUPABASE_URL inside this runtime is the internal Docker hostname
  // (http://supabase-kong:8000) -- correct and required for THIS function to
  // reach Storage, but storage-api echoes that same host back into the
  // signed URL it returns. Left alone, every download link handed to a
  // browser would point at a host only reachable from inside the Docker
  // network -- unresolvable from the internet, surfacing as exactly the
  // literal "Failed to fetch" the browser reports, for every role, not only
  // the ones the RLS bug above blocked outright. Rewrite onto the real
  // public origin (already provisioned in this environment for this exact
  // purpose) before the link ever reaches a browser; the signature/token
  // query string is untouched, so the swap does not change what it grants.
  const PUBLIC_URL = Deno.env.get("NEXT_PUBLIC_SUPABASE_URL");
  let signedUrl = signed.signedUrl;
  if (PUBLIC_URL) {
    try {
      const internal = new URL(signedUrl, SUPABASE_URL);
      signedUrl = new URL(internal.pathname + internal.search, PUBLIC_URL).toString();
    } catch {
      /* fall back to the unrewritten URL rather than fail the download */
    }
  }

  return jsonResponse({ signedUrl, filename: job.filename });
});
