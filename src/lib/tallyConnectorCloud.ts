import { supabase } from "@/integrations/supabase/client";

/** Connector considered online if heartbeat within this window. */
export const TALLY_CONNECTOR_ONLINE_MS = 3 * 60 * 1000;

export type TallyConnectorDeviceRow = {
  id: string;
  device_name: string;
  installation_id: string;
  paired_at: string;
  last_seen_at: string | null;
  connector_version: string | null;
  revoked_at: string | null;
  is_enabled: boolean;
  token_prefix: string;
};

export type TallySyncJobHealthRow = {
  id: string;
  report_type: string;
  status: string;
  created_at: string;
  error_message_safe: string | null;
};

export type TallyManualReviewBatch = {
  id: string;
  job_id: string;
  batch_index: number;
  message_count: number;
  last_error_safe: string | null;
  tally_response_safe: string | null;
  created_at: string;
};

export type TallyPendingBatch = {
  id: string;
  job_id: string;
  batch_index: number;
  message_count: number;
  created_at: string;
};

export async function fetchTallyPendingBatches(organizationId: string, jobId?: string): Promise<TallyPendingBatch[]> {
  const allBatches: TallyPendingBatch[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (supabase as any)
      .from("tally_sync_delivery_batches")
      .select("id, job_id, batch_index, message_count, created_at")
      .eq("organization_id", organizationId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (jobId?.trim()) query = query.eq("job_id", jobId.trim());
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as TallyPendingBatch[];
    allBatches.push(...page);
    if (page.length < pageSize) return allBatches;
  }
}

export async function quarantineTallyPendingBatches(
  organizationId: string,
  batchIds: string[],
  reason: string,
): Promise<void> {
  const uniqueIds = [...new Set(batchIds.map((id) => id.trim()).filter(Boolean))];
  if (!organizationId.trim() || uniqueIds.length === 0) {
    throw new Error("Organization and pending batch IDs are required");
  }
  if (reason.trim().length < 20) throw new Error("Quarantine reason must explain why delivery is blocked");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("admin_quarantine_tally_delivery_batches_v1", {
    p_organization_id: organizationId,
    p_batch_ids: uniqueIds,
    p_reason: reason.trim(),
  });
  if (error) throw new Error(error.message);
  const result = data as { updated?: number } | null;
  if (Number(result?.updated) !== uniqueIds.length) {
    throw new Error(`Quarantine updated ${Number(result?.updated ?? 0)} of ${uniqueIds.length} selected batches`);
  }
}

/** Cancel one untouched sync through the organization-admin RPC. */
export async function cancelUntouchedTallySyncJob(
  organizationId: string,
  jobId: string,
  reason: string,
): Promise<{ skippedBatches: number; skippedRecords: number }> {
  if (!organizationId.trim() || !jobId.trim()) {
    throw new Error("Organization and Tally job ID are required");
  }
  if (reason.trim().length < 20) {
    throw new Error("Cancellation reason must explain why the job is being stopped");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("admin_cancel_untouched_tally_sync_job_v1", {
    p_organization_id: organizationId,
    p_job_id: jobId,
    p_reason: reason.trim(),
  });
  if (error) throw new Error(error.message);
  const result = data as { cancelled?: boolean; skipped_batches?: number; skipped_records?: number } | null;
  if (result?.cancelled !== true) throw new Error("The Tally job was not cancelled");
  return {
    skippedBatches: Number(result.skipped_batches ?? 0),
    skippedRecords: Number(result.skipped_records ?? 0),
  };
}

export async function fetchTallyManualReviewBatches(organizationId: string): Promise<TallyManualReviewBatch[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_sync_delivery_batches")
    .select("id, job_id, batch_index, message_count, last_error_safe, tally_response_safe, created_at")
    .eq("organization_id", organizationId)
    .eq("status", "manual_review")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TallyManualReviewBatch[];
}

export async function reconcileTallyDeliveryBatch(
  batchId: string,
  decision: "confirm_delivered" | "authorize_retry",
  evidence: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("reconcile_tally_delivery_batch_v1", {
    p_batch_id: batchId,
    p_decision: decision,
    p_evidence: evidence,
  });
  if (error) throw new Error(error.message);
}

export function isConnectorDeviceOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const t = Date.parse(lastSeenAt);
  if (Number.isNaN(t)) return false;
  return now - t <= TALLY_CONNECTOR_ONLINE_MS;
}

export async function fetchTallyConnectorDevices(organizationId: string): Promise<TallyConnectorDeviceRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_connector_devices")
    .select(
      "id, device_name, installation_id, paired_at, last_seen_at, connector_version, revoked_at, is_enabled, token_prefix",
    )
    .eq("organization_id", organizationId)
    .order("paired_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TallyConnectorDeviceRow[];
}

export async function fetchOrgHasOnlineConnector(organizationId: string): Promise<boolean> {
  const devices = await fetchTallyConnectorDevices(organizationId);
  return devices.some(
    (d) => !d.revoked_at && d.is_enabled && isConnectorDeviceOnline(d.last_seen_at),
  );
}

export async function createTallyConnectorPairingCode(
  organizationId: string,
  ttlMinutes = 15,
): Promise<{ pairing_code: string; expires_in_minutes: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("create_tally_connector_pairing_code_v1", {
    p_organization_id: organizationId,
    p_ttl_minutes: ttlMinutes,
  });
  if (error) throw new Error(error.message);
  const row = data as { pairing_code?: string; expires_in_minutes?: number };
  if (!row?.pairing_code) throw new Error("Pairing code not returned");
  return {
    pairing_code: String(row.pairing_code),
    expires_in_minutes: Number(row.expires_in_minutes ?? ttlMinutes),
  };
}

export async function revokeTallyConnectorDevice(connectorId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("revoke_tally_connector_v1", {
    p_connector_id: connectorId,
  });
  if (error) throw new Error(error.message);
}

export async function fetchRecentTallySyncJobs(
  organizationId: string,
  limit = 8,
): Promise<TallySyncJobHealthRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_sync_jobs")
    .select("id, report_type, status, created_at, error_message_safe")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TallySyncJobHealthRow[];
}

export function buildConnectorPairCommand(opts: {
  exePath?: string;
  supabaseUrl: string;
  anonKey: string;
  pairingCode: string;
  companyName: string;
  deviceName?: string;
}): string {
  const exe = opts.exePath ?? "PesoWiseSync.exe";
  const name = opts.deviceName ?? "Office PC";
  const company = opts.companyName.replace(/"/g, '\\"');
  return `${exe} pair --url ${opts.supabaseUrl} --anon-key ${opts.anonKey} --code ${opts.pairingCode} --name "${name}" --company "${company}"`;
}
