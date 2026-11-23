/**
 * Shared: Node → SSH → docker exec -i psql (base64 stdin, avoids \\nSELECT psql bug).
 */
import {
  resolveCoolifySshHost,
  resolveCoolifySshUser,
  requireCoolifySshPassword,
} from "./_coolifySshCredentials.mjs";

export const DEFAULT_DB = process.env.DEPLOY_SUPABASE_DB_CONTAINER ?? "supabase-db-kar0ro1k6jiyfxzzw7acnsza";
export const DEFAULT_HOST = resolveCoolifySshHost();
export const DEFAULT_USER = resolveCoolifySshUser();

/** @param {string} sql @param {string} [container] @param {'json'|'mutate'} [mode] */
export function buildRemotePsqlBash(sql, container = DEFAULT_DB, mode = "json") {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("empty SQL");
  const b64 = Buffer.from(`${trimmed}\n`, "utf8").toString("base64");
  const flags = mode === "json" ? "-q -tA" : "-q";
  return `echo ${JSON.stringify(b64)} | base64 -d | docker exec -i ${container} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 ${flags}`;
}

/**
 * Extract one JSON value from psql stdout (SELECT -tA). Ignores command tags like INSERT 0 1.
 * Prefer separate mutate + json SELECT calls; this is a safety net for single-statement scripts.
 * @param {string} text
 */
export function parsePsqlJsonStdout(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") || line.startsWith("[")) {
      return JSON.parse(line);
    }
  }
  throw new Error(`No JSON in psql output (first 240 chars): ${text.slice(0, 240)}`);
}

/** @param {string} raw */
export function splitPsqlOutput(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const commandTags = lines.filter((l) => /^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|DO)/i.test(l));
  const jsonLines = lines.filter((l) => l.startsWith("{") || l.startsWith("["));
  return { commandTags, jsonLines, raw };
}

async function sshExec(bash, password, user, host) {
  // Keep pure SQL/output helpers importable in browserside test runners; load
  // the transport only when a real SSH operation is requested.
  const { Client } = await import("ssh2");
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(bash, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          let out = "";
          let errOut = "";
          stream.on("data", (d) => {
            out += d;
          });
          stream.stderr.on("data", (d) => {
            errOut += d;
          });
          stream.on("close", (code) => {
            conn.end();
            if (code !== 0) reject(new Error(errOut || out || `exit ${code}`));
            else resolve(out.trim());
          });
        });
      })
      .on("error", reject)
      .connect({ host, username: user, password, readyTimeout: 25000 });
  });
}

/** Single SELECT (or SELECT-only script) → parsed JSON. */
export async function sshPsqlJson(sql, opts) {
  const { password, user = DEFAULT_USER, host = DEFAULT_HOST, db = DEFAULT_DB } = opts;
  const raw = await sshExec(buildRemotePsqlBash(sql, db, "json"), password, user, host);
  return parsePsqlJsonStdout(raw);
}

/** DML / DDL without JSON body — returns raw stdout + parsed command tags. */
export async function sshPsqlMutate(sql, opts) {
  const { password, user = DEFAULT_USER, host = DEFAULT_HOST, db = DEFAULT_DB } = opts;
  const raw = await sshExec(buildRemotePsqlBash(sql, db, "mutate"), password, user, host);
  return splitPsqlOutput(raw);
}

/** @deprecated use sshPsqlJson */
export function sshPsqlQuery(sql, opts) {
  return sshPsqlJson(sql, opts).then((j) => JSON.stringify(j));
}

export function requireSshPassword() {
  return requireCoolifySshPassword();
}
