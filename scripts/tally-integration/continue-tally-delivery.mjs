#!/usr/bin/env node
/** Drive chunked run-tally-sync-delivery until job reaches waiting_for_connector (or failed). */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const jobId = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 40);
if (!jobId) {
  console.error("Usage: node continue-tally-delivery.mjs <job_id> [max_rounds]");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const probe = join(root, "scripts/tally-integration/probe-sync-job.mjs");
const redispatch = join(root, "scripts/tally-integration/redispatch-tally-delivery.mjs");

for (let i = 1; i <= maxRounds; i++) {
  const st = spawnSync("node", [probe, jobId], { encoding: "utf-8" });
  const data = JSON.parse(st.stdout);
  const status = data.job?.status;
  const batchTotal = data.batch_total ?? 0;
  console.log(`round ${i}: status=${status} batches=${batchTotal}`);
  if (status === "waiting_for_connector" || status === "delivering" || status === "completed") {
    console.log(JSON.stringify({ done: true, ...data }, null, 2));
    process.exit(0);
  }
  if (status === "failed") {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  spawnSync("node", [redispatch, jobId], { encoding: "utf-8", stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 3000));
}

console.error("max rounds reached — refresh Reports UI or run again");
process.exit(2);
