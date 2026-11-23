#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const pass = requireCoolifySshPassword();
const r = await sshPsqlJson(
  `SELECT prosrc FROM pg_proc WHERE proname='connector_ack_delivery_batch_v1' AND pronargs=8 LIMIT 1`,
  { password: pass },
);
const s = r.prosrc || "";
console.log("has WHEN v_dup_only", s.includes("WHEN v_dup_only THEN 'pending'"));
console.log("has v_dup_only :=", s.includes("v_dup_only :="));
