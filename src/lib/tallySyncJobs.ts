/**
 * Tally sync — Phase 3.6: single silent start request (no worker invoke / poll from browser).
 */
import { supabase } from "@/integrations/supabase/client";
import {
  buildTallySyncParameters,
  type BuildTallySyncParametersInput,
} from "@/lib/tallySyncParameters";
import type { TallySyncReportType } from "@/lib/tallyReportTypes";

export type TallySyncStartResult = {
  accepted: boolean;
  job_id?: string;
  deduplicated?: boolean;
};

export type StartTallySyncInput = BuildTallySyncParametersInput & {
  organizationId: string;
};

/** One backend request: enqueue + server-side worker dispatch. */
export async function startTallySync(input: StartTallySyncInput): Promise<TallySyncStartResult> {
  const parameters = buildTallySyncParameters(input);
  const { data, error } = await supabase.functions.invoke("start-tally-sync", {
    body: {
      organization_id: input.organizationId,
      report_type: input.reportType,
      parameters,
    },
  });
  if (error) {
    throw new Error(error.message || "Unable to start Tally sync");
  }
  const payload = data as Record<string, unknown> | null;
  if (!payload?.accepted) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Unable to start Tally sync",
    );
  }
  return {
    accepted: true,
    job_id: typeof payload.job_id === "string" ? payload.job_id : undefined,
    deduplicated: payload.deduplicated === true,
  };
}

/** @deprecated Phase 3.6 — use startTallySync. Kept for migration/tests. */
export async function enqueueTallySyncJob(input: StartTallySyncInput) {
  const parameters = buildTallySyncParameters(input);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("create_tally_sync_job_v1", {
    p_organization_id: input.organizationId,
    p_report_type: input.reportType,
    p_parameters: parameters,
  });
  if (error) throw new Error(error.message);
  return data as { job_id: string; status: string; deduplicated: boolean };
}
