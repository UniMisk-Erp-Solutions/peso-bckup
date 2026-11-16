#!/usr/bin/env node
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { requireSshPassword, sshPsqlMutate } from "./_sshPsqlRemote.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(
  resolve(root, "supabase/migrations/20261008103000_tally_duplicate_ack_retry.sql"),
  "utf-8",
);
const pass = requireSshPassword();
const r = await sshPsqlMutate(sql, { password: pass });
console.log(JSON.stringify({ applied: true, tags: r.commandTags }, null, 2));
