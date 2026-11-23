#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const pass = requireCoolifySshPassword();
console.log(
  await sshPsqlJson(
    `SELECT jsonb_build_object(
      'n8', (SELECT prosrc LIKE '%v_dup_only%' FROM pg_proc WHERE proname='connector_ack_delivery_batch_v1' AND pronargs=8),
      'n7', (SELECT prosrc LIKE '%v_dup_only%' FROM pg_proc WHERE proname='connector_ack_delivery_batch_v1' AND pronargs=7)
    )`,
    { password: pass },
  ),
);
