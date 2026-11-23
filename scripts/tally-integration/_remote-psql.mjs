import { Client } from "ssh2";
const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const sql = process.argv.slice(2).join(" ");
const conn = new Client();
conn.on("ready", () => {
  conn.exec(
    `docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc "${sql.replace(/"/g, '\\"')}"`,
    (err, stream) => {
      if (err) throw err;
      stream.on("data", (d) => process.stdout.write(d));
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", (c) => process.exit(c ?? 0));
    },
  );
}).connect({ host: "192.168.23.46", username: user, password: pass });
conn.on("error", (e) => { console.error(e.message); process.exit(1); });
