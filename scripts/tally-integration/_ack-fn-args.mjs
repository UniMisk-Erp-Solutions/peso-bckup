#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const pass = requireCoolifySshPassword();
console.log(
  await sshPsqlJson(
    `SELECT jsonb_agg(jsonb_build_object('args', pg_get_function_arguments(oid), 'n', pronargs)) FROM pg_proc WHERE proname='connector_ack_delivery_batch_v1'`,
    { password: pass },
  ),
);
