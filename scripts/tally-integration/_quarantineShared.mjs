export const SMOKE_ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";

const REASON =
  "Superseded after Phase 5 metadata-voucher to metadata-ledger architecture migration; must not be delivered.";

/** @param {string[]} batchIds */
export function buildQuarantineSql(batchIds) {
  const idList = batchIds.map((id) => `'${id}'::uuid`).join(",");
  const reasonEsc = REASON.replace(/'/g, "''");
  return `
BEGIN;
DO $$
DECLARE
  v_expected int := 7;
  v_ids uuid[] := ARRAY[${idList}];
  v_smoke uuid := '${SMOKE_ORG}'::uuid;
  v_pending int;
  v_other int;
  v_updated int;
BEGIN
  SELECT count(*) INTO v_pending
  FROM public.tally_sync_delivery_batches b
  WHERE b.organization_id = v_smoke AND b.status = 'pending';

  IF v_pending <> v_expected THEN
    RAISE EXCEPTION 'precheck failed: smoke pending % (expected %)', v_pending, v_expected;
  END IF;

  SELECT count(*) INTO v_other
  FROM public.tally_sync_delivery_batches b
  WHERE b.status = 'pending' AND b.organization_id <> v_smoke;

  IF v_other <> 0 THEN
    RAISE EXCEPTION 'precheck failed: non-smoke pending batches %', v_other;
  END IF;

  IF (
    SELECT count(*)
    FROM unnest(v_ids) AS u(id)
    INNER JOIN public.tally_sync_delivery_batches b ON b.id = u.id
    WHERE b.organization_id = v_smoke AND b.status = 'pending'
  ) <> v_expected THEN
    RAISE EXCEPTION 'precheck failed: id list mismatch';
  END IF;

  UPDATE public.tally_sync_delivery_batches b
  SET status = 'skipped',
      last_error_safe = left('${reasonEsc}', 300),
      ack_summary = COALESCE(b.ack_summary, '{}'::jsonb) || jsonb_build_object(
        'quarantined', true,
        'quarantine_reason', left('${reasonEsc}', 500),
        'quarantined_at', now()
      ),
      updated_at = now(),
      completed_at = COALESCE(completed_at, now())
  WHERE b.organization_id = v_smoke
    AND b.id = ANY (v_ids)
    AND b.status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'quarantine affected % rows (expected %)', v_updated, v_expected;
  END IF;
END $$;
COMMIT;
SELECT jsonb_build_object('quarantine', 'committed', 'updated', 7);
`;
}

/** @param {Record<string, unknown>} data */
export function validatePrecheck(data) {
  const errors = [];
  if (data.smoke_pending_count !== 7) errors.push(`smoke_pending_count=${data.smoke_pending_count} (expected 7)`);
  if (data.microlink_pending_count !== 0) errors.push(`microlink_pending_count=${data.microlink_pending_count}`);
  if (data.global_pending_count !== 7) errors.push(`global_pending_count=${data.global_pending_count} (expected 7)`);
  const other = data.other_org_pending_counts ?? {};
  if (Object.keys(other).length > 0) errors.push(`other_org_pending=${JSON.stringify(other)}`);
  const batches = /** @type {Array<Record<string, unknown>>} */ (data.smoke_pending_batches ?? []);
  if (batches.length !== 7) errors.push(`smoke_pending_batches.length=${batches.length} (expected 7)`);
  for (const b of batches) {
    if (b.organization_id !== SMOKE_ORG) errors.push(`batch ${b.id} wrong org`);
    if (b.status !== "pending") errors.push(`batch ${b.id} status=${b.status} (expected pending)`);
  }
  const batchIds = batches.map((b) => String(b.id));
  const jobIds = [...new Set(batches.map((b) => String(b.job_id)))];
  return { ok: errors.length === 0, errors, batchIds, jobIds };
}
