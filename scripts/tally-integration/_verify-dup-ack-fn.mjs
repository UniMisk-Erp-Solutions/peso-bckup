#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const pass = requireCoolifySshPassword();
const r = await sshPsqlJson(
  `SELECT jsonb_build_object('has_fix', (SELECT prosrc LIKE '%v_dup_only%' FROM pg_proc WHERE proname='connector_ack_delivery_batch_v1' LIMIT 1))`,
  { password: pass },
);
console.log(r);
