#!/usr/bin/env node
/** Patch 8-arg connector_ack (the one Edge uses with p_e2e_hold) for duplicate retries. */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { requireSshPassword, sshPsqlMutate } from "./_sshPsqlRemote.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = readFileSync(
  resolve(root, "supabase/migrations/20261007170000_tally_e2e_controlled_delivery.sql"),
  "utf-8",
);
const start = raw.indexOf("CREATE OR REPLACE FUNCTION public.connector_ack_delivery_batch_v1(");
const end = raw.indexOf("$$;", start) + 3;
let sql = raw.slice(start, end);
if (!sql.includes("p_e2e_hold")) {
  console.error("8-arg ack function not found in e2e migration");
  process.exit(1);
}

sql = sql.replace("v_kind text;", "v_kind text;\n  v_dup_only boolean;");
sql = sql.replace(
  "  IF v_batch.claimed_by IS DISTINCT FROM p_connector_id THEN",
  `  v_dup_only := COALESCE((p_ack_summary->>'duplicate_only')::boolean, false)
    OR COALESCE(p_error_safe, '') ILIKE '%duplicate%'
    OR COALESCE(p_error_safe, '') ILIKE '%udf%'
    OR COALESCE(p_error_safe, '') ILIKE '%import not confirmed%';

  IF v_batch.claimed_by IS DISTINCT FROM p_connector_id THEN`,
);
sql = sql.replace(
  `      UPDATE public.tally_sync_delivery_batches
      SET status = CASE WHEN v_batch.attempt_count >= v_batch.max_attempts THEN 'failed' ELSE 'pending' END,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error_safe = left(COALESCE(p_error_safe, 'delivery failed'), 500),
          tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
          updated_at = now()
      WHERE id = p_batch_id;`,
  `      UPDATE public.tally_sync_delivery_batches
      SET status = CASE
            WHEN v_dup_only THEN 'pending'
            WHEN v_batch.attempt_count >= v_batch.max_attempts THEN 'failed'
            ELSE 'pending'
          END,
          attempt_count = CASE WHEN v_dup_only THEN GREATEST(v_batch.attempt_count - 1, 0) ELSE v_batch.attempt_count END,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error_safe = left(COALESCE(p_error_safe, 'delivery failed'), 500),
          tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
          ack_summary = COALESCE(p_ack_summary, ack_summary),
          updated_at = now()
      WHERE id = p_batch_id;`,
);
sql = sql.replace(
  "UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector' WHERE id = v_batch.job_id;",
  "UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector', error_code = NULL, error_message_safe = NULL WHERE id = v_batch.job_id;",
);

const pass = requireSshPassword();
const r = await sshPsqlMutate(sql, { password: pass });
console.log(JSON.stringify({ applied_8arg: true, tags: r.commandTags }, null, 2));
