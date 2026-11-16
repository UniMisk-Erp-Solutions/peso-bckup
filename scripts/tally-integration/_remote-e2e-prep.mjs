import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const DB = "supabase-db-kar0ro1k6jiyfxzzw7acnsza";

const sql = `
SELECT o.id AS org_id, m.user_id AS admin_id,
  (SELECT count(*) FROM expenses e WHERE e.organization_id=o.id AND e.deleted_at IS NULL) AS expenses
FROM organizations o
JOIN organization_memberships m ON m.organization_id=o.id AND m.role='admin' AND m.is_active
ORDER BY expenses DESC NULLS LAST
LIMIT 3;
`;

const cmd = `docker exec ${DB} psql -U supabase_admin -d postgres -c "${sql.replace(/\n/g, " ")}"`;

const conn = new Client();
conn.on("ready", () => {
  conn.exec(cmd, (err, stream) => {
    if (err) throw err;
    stream.on("data", (d) => process.stdout.write(d));
    stream.stderr.on("data", (d) => process.stderr.write(d));
    stream.on("close", (c) => process.exit(c ?? 0));
  });
}).connect({ host: "192.168.23.46", username: user, password: pass });
