#!/usr/bin/env node
/** Hotfix: delivery batches never go to permanent 'failed' — job stays waiting (duplicate/TDL retries). */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { requireSshPassword, sshPsqlMutate } from "./_sshPsqlRemote.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let sql = readFileSync(
  resolve(root, "supabase/migrations/20261007170000_tally_e2e_controlled_delivery.sql"),
  "utf-8",
);
const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.connector_ack_delivery_batch_v1(");
const end = sql.indexOf("$$;", start) + 3;
sql = sql.slice(start, end);

sql = sql.replace(
  /SET status = CASE WHEN v_batch\.attempt_count >= v_batch\.max_attempts THEN 'failed' ELSE 'pending' END,/g,
  `SET status = 'pending',
          attempt_count = CASE WHEN v_batch.attempt_count >= v_batch.max_attempts THEN 0 ELSE v_batch.attempt_count END,`,
);

sql = sql.replace(
  `  ELSIF EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status = 'failed'
  ) THEN
    UPDATE public.tally_sync_jobs
    SET status = 'failed',
        error_code = 'tally_delivery_failed',
        error_message_safe = 'One or more Tally delivery batches failed'
    WHERE id = v_batch.job_id AND status <> 'completed';`,
  `  ELSIF EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status = 'failed'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status IN ('pending', 'claimed')
  ) THEN
    UPDATE public.tally_sync_jobs
    SET status = 'failed',
        error_code = 'tally_delivery_failed',
        error_message_safe = 'One or more Tally delivery batches failed'
    WHERE id = v_batch.job_id AND status <> 'completed';`,
);

sql = sql.replace(
  "UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector' WHERE id = v_batch.job_id;",
  "UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector', error_code = NULL, error_message_safe = NULL WHERE id = v_batch.job_id;",
);

const pass = requireSshPassword();
await sshPsqlMutate(sql, { password: pass });
console.log("Applied never-fail-batch hotfix (8-arg ack)");
