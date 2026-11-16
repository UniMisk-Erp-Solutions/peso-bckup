/** Shared queue safety snapshot + validation (smoke + MicroLink). */

export const SMOKE_ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
export const MICROLINK_ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";

export const MICROLINK_PREPARED_IDS = [
  "255fd764-53a5-4db3-b24f-0ce9712f7ef5",
  "89d0f0c8-9cdd-4790-8b86-698ba65f8aab",
  "68fd0e2d-867c-4434-9132-2f2eb56b5bb4",
];

/** Full queue + MicroLink prepared job snapshot (READ-ONLY). */
export const QUEUE_SNAPSHOT_SQL = `
SELECT jsonb_build_object(
  'global_pending_batches', (SELECT count(*)::int FROM public.tally_sync_delivery_batches WHERE status = 'pending'),
  'smoke_pending_batches', (SELECT count(*)::int FROM public.tally_sync_delivery_batches WHERE organization_id = '${SMOKE_ORG}'::uuid AND status = 'pending'),
  'microlink_pending_batches', (SELECT count(*)::int FROM public.tally_sync_delivery_batches WHERE organization_id = '${MICROLINK_ORG}'::uuid AND status = 'pending'),
  'microlink_prepared_jobs', (
    SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at), '[]'::jsonb)
    FROM (
      SELECT id, status, report_type, prepared_item_count, created_at
      FROM public.tally_sync_jobs
      WHERE organization_id = '${MICROLINK_ORG}'::uuid AND status = 'prepared'
    ) t
  ),
  'quarantined_skipped_smoke', (
    SELECT count(*)::int FROM public.tally_sync_delivery_batches
    WHERE organization_id = '${SMOKE_ORG}'::uuid AND status = 'skipped'
      AND (ack_summary->>'quarantined')::boolean IS TRUE
  )
);
`;

/** @param {Record<string, unknown>} d */
export function evaluateQueueSafe(d) {
  const errors = [];
  if (d.global_pending_batches !== 0) errors.push(`global_pending_batches=${d.global_pending_batches}`);
  if (d.smoke_pending_batches !== 0) errors.push(`smoke_pending_batches=${d.smoke_pending_batches}`);
  if (d.microlink_pending_batches !== 0) errors.push(`microlink_pending_batches=${d.microlink_pending_batches}`);
  const jobs = /** @type {Array<{ id: string; status: string; report_type?: string; prepared_item_count: number }>} */ (
    d.microlink_prepared_jobs ?? []
  );
  for (const id of MICROLINK_PREPARED_IDS) {
    const j = jobs.find((x) => String(x.id).toLowerCase() === id.toLowerCase());
    if (!j) errors.push(`missing Microlink prepared job ${id}`);
    else if (j.status !== "prepared") errors.push(`Microlink job ${id} status=${j.status}`);
    else if (j.report_type !== "claim_verification") {
      errors.push(`Microlink job ${id} report_type=${j.report_type}`);
    } else if (Number(j.prepared_item_count) !== 2514) {
      errors.push(`Microlink job ${id} prepared_item_count=${j.prepared_item_count}`);
    }
  }
  return { queue_safe: errors.length === 0, errors };
}
