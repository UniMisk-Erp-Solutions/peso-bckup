#!/usr/bin/env node
/**
 * READ-ONLY queue safety check (global + smoke + MicroLink prepared jobs).
 */
import { requireSshPassword, sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { evaluateQueueSafe, QUEUE_SNAPSHOT_SQL } from "./_queueSafeShared.mjs";

export { evaluateQueueSafe, QUEUE_SNAPSHOT_SQL };

async function main() {
  const pass = requireSshPassword();
  const data = await sshPsqlJson(QUEUE_SNAPSHOT_SQL, { password: pass });
  const ev = evaluateQueueSafe(data);
  console.log(JSON.stringify({ readonly: true, ...data, ...ev }, null, 2));
  process.exit(ev.queue_safe ? 0 : 4);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("ssh-verify-queue-safe.mjs");
if (isMain) {
  main().catch((e) => {
    console.log(JSON.stringify({ error: e.message ?? String(e) }, null, 2));
    process.exit(1);
  });
}
