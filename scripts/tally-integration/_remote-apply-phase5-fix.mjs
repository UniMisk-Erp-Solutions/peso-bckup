import { Client } from "ssh2";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const DB = "supabase-db-kar0ro1k6jiyfxzzw7acnsza";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(join(root, "supabase/migrations/20261007120000_tally_connector_phase5.sql"), "utf-8");

const conn = new Client();
conn.on("ready", () => {
  conn.sftp((err, sftp) => {
    if (err) throw err;
    const remote = "/tmp/phase5.sql";
    const stream = sftp.createWriteStream(remote);
    stream.write(sql);
    stream.end();
    stream.on("close", () => {
      conn.exec(
        `cat ${remote} | docker exec -i ${DB} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remote}`,
        (e, s) => {
          if (e) throw e;
          s.on("data", (d) => process.stdout.write(d));
          s.stderr.on("data", (d) => process.stderr.write(d));
          s.on("close", (c) => process.exit(c ?? 0));
        },
      );
    });
  });
}).connect({ host: "192.168.23.46", username: user, password: pass });
