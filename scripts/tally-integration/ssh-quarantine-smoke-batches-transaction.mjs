#!/usr/bin/env node
/**
 * SELECT-only precheck + optional quarantine (smoke org pending batches only).
 *
 * Replicates admin_quarantine_tally_delivery_batches_v1 row updates via psql
 * (no JWT — server-side supabase_admin). Does NOT delete rows.
 *
 * SQL is sent base64 → stdin to avoid shell/psql interpreting "\\nSELECT" from JSON.stringify.
 *
 * Env:
 *   DEPLOY_SSH_PASSWORD (required)
 *   DEPLOY_SSH_USER (default hasto)
 *   DEPLOY_SSH_HOST (default 192.168.23.46)
 *   DEPLOY_SUPABASE_DB_CONTAINER (default supabase-db-kar0ro1k6jiyfxzzw7acnsza)
 *   QUARANTINE_CONFIRM=1  — run mutation after precheck passes
 */
import { buildRemotePsqlBash, DEFAULT_DB, sshPsqlQuery } from "./_sshPsqlRemote.mjs";
import { buildQuarantineSql, SMOKE_ORG, validatePrecheck } from "./_quarantineShared.mjs";

const MICROLINK_ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const DB = DEFAULT_DB;

export { buildRemotePsqlBash, buildQuarantineSql, validatePrecheck };

const PRECHECK_SQL = `
SELECT jsonb_build_object(
  'smoke_pending_batches', (
    SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at, t.id), '[]'::jsonb)
    FROM (
      SELECT b.id, b.job_id, b.organization_id, b.batch_index, b.message_count, b.status,
             b.created_at, b.claimed_at, b.attempt_count, b.last_error_safe,
             j.report_type, j.status AS job_status, j.prepared_item_count
      FROM public.tally_sync_delivery_batches b
      JOIN public.tally_sync_jobs j ON j.id = b.job_id
      WHERE b.organization_id = '${SMOKE_ORG}'::uuid AND b.status = 'pending'
    ) t
  ),
  'smoke_pending_count', (
    SELECT count(*)::int FROM public.tally_sync_delivery_batches
    WHERE organization_id = '${SMOKE_ORG}'::uuid AND status = 'pending'
  ),
  'microlink_pending_count', (
    SELECT count(*)::int FROM public.tally_sync_delivery_batches
    WHERE organization_id = '${MICROLINK_ORG}'::uuid AND status = 'pending'
  ),
  'other_org_pending_counts', (
    SELECT coalesce(jsonb_object_agg(organization_id::text, c), '{}'::jsonb)
    FROM (
      SELECT organization_id, count(*)::int AS c
      FROM public.tally_sync_delivery_batches
      WHERE status = 'pending' AND organization_id NOT IN ('${SMOKE_ORG}'::uuid, '${MICROLINK_ORG}'::uuid)
      GROUP BY organization_id
    ) x
  ),
  'global_pending_count', (
    SELECT count(*)::int FROM public.tally_sync_delivery_batches WHERE status = 'pending'
  ),
  'microlink_prepared_jobs', (
    SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at), '[]'::jsonb)
    FROM (
      SELECT id, status, prepared_item_count, created_at
      FROM public.tally_sync_jobs
      WHERE organization_id = '${MICROLINK_ORG}'::uuid AND status = 'prepared'
    ) t
  )
);
`;

/** @param {string} sql */
function sshPsql(sql) {
  if (!pass) throw new Error("Set DEPLOY_SSH_PASSWORD");
  return sshPsqlQuery(sql, { password: pass });
}

/** @param {Record<string, unknown>} pre @param {ReturnType<typeof validatePrecheck>} v */
function summarizePrecheck(pre, v) {
  return {
    smoke_pending_count: pre.smoke_pending_count,
    global_pending_count: pre.global_pending_count,
    microlink_pending_count: pre.microlink_pending_count,
    other_org_pending_counts: pre.other_org_pending_counts ?? {},
    batch_ids: v.batchIds,
    job_ids: v.jobIds,
    precheck_ok: v.ok,
  };
}

async function main() {
  if (!pass) {
    console.log(JSON.stringify({ error: "Set DEPLOY_SSH_PASSWORD" }, null, 2));
    process.exit(2);
  }

  const raw = await sshPsql(PRECHECK_SQL);
  let pre;
  try {
    pre = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ error: "precheck parse failed", raw: raw.slice(0, 500) }, null, 2));
    process.exit(2);
  }

  const v = validatePrecheck(pre);
  const summary = summarizePrecheck(pre, v);
  const out = {
    phase: process.env.QUARANTINE_CONFIRM === "1" ? "quarantine_attempt" : "precheck_only",
    smoke_org: SMOKE_ORG,
    microlink_org: MICROLINK_ORG,
    ...summary,
    precheck_errors: v.errors,
    precheck: pre,
  };

  if (!v.ok) {
    console.log(JSON.stringify({ ...out, mutation: "SKIPPED" }, null, 2));
    process.exit(3);
  }

  if (process.env.QUARANTINE_CONFIRM !== "1") {
    console.log(
      JSON.stringify(
        {
          ...out,
          mutation: "NOT_RUN",
          hint: "Re-run with QUARANTINE_CONFIRM=1 to apply skipped quarantine (same semantics as admin_quarantine_tally_delivery_batches_v1).",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const qRaw = await sshPsql(buildQuarantineSql(v.batchIds));
  let post;
  try {
    post = JSON.parse(await sshPsql(PRECHECK_SQL));
  } catch (e) {
    post = { error: String(e) };
  }

  console.log(
    JSON.stringify(
      {
        ...out,
        quarantine_result: qRaw,
        postcheck: post,
        postcheck_ok:
          post.smoke_pending_count === 0 &&
          post.microlink_pending_count === 0 &&
          (post.microlink_prepared_jobs ?? []).length >= 3,
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("ssh-quarantine-smoke-batches-transaction.mjs");
if (isMain) {
  main().catch((e) => {
    console.log(JSON.stringify({ error: e.message ?? String(e) }, null, 2));
    process.exit(1);
  });
}
