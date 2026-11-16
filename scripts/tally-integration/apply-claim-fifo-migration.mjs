#!/usr/bin/env node
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { requireSshPassword, sshPsqlMutate } from "./_sshPsqlRemote.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(
  resolve(root, "supabase/migrations/20261008120000_tally_claim_fifo_by_job_created.sql"),
  "utf-8",
);
await sshPsqlMutate(sql, { password: requireSshPassword() });
console.log("Applied claim FIFO by job created_at DESC");
