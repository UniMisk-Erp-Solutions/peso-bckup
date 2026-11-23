import { Client } from "ssh2";
import { requireCoolifySshPassword, resolveCoolifySshHost, resolveCoolifySshUser } from "./_coolifySshCredentials.mjs";

const EDGE = "supabase-edge-functions-kar0ro1k6jiyfxzzw7acnsza";
const bash = `docker exec ${EDGE} sh -c 'grep -c enqueueDeliveryBatches /home/deno/functions/run-tally-sync-job/index.ts 2>/dev/null || echo MISSING'; docker logs ${EDGE} 2>&1 | tail -30`;

const conn = new Client();
conn
  .on("ready", () => {
    conn.exec(bash, (err, stream) => {
      if (err) throw err;
      stream.on("data", (d) => process.stdout.write(d));
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", (c) => process.exit(c ?? 0));
    });
  })
  .connect({ host: resolveCoolifySshHost(), username: resolveCoolifySshUser(), password: requireCoolifySshPassword() });
