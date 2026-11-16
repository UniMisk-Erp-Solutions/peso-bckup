/**
 * Coolify host SSH for self-hosted Supabase on .46 (docker exec psql / docker cp edge).
 * Mirrors scripts/_ssh_credentials.py resolution order (no committed secrets).
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PASSWORD_FILE = join(REPO_ROOT, ".local-sensitive-data", "coolify_ssh_password.txt");

/** PesoWise backup Supabase Coolify service */
export const COOLIFY_BACKUP_SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";

export function resolveCoolifySshHost() {
  return (
    process.env.DEPLOY_SSH_HOST ??
    process.env.COOLIFY_SSH_HOST ??
    "192.168.23.46"
  );
}

export function resolveCoolifySshUser() {
  const fromEnv = process.env.DEPLOY_SSH_USER ?? process.env.COOLIFY_SSH_USER;
  if (fromEnv) return fromEnv;
  const ssh = process.env.COOLIFY_SSH;
  if (ssh?.includes("@")) return ssh.split("@")[0];
  return "hasto";
}

export function resolveCoolifySshPassword() {
  const direct =
    process.env.DEPLOY_SSH_PASSWORD ??
    process.env.COOLIFY_SSH_PASSWORD;
  if (direct) return direct;
  if (existsSync(PASSWORD_FILE)) {
    const fromFile = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  }
  return null;
}

export function requireCoolifySshPassword() {
  const pass = resolveCoolifySshPassword();
  if (!pass) {
    throw new Error(
      "Coolify SSH password required: set COOLIFY_SSH_PASSWORD or DEPLOY_SSH_PASSWORD, " +
        "or create .local-sensitive-data/coolify_ssh_password.txt (see scripts/_ssh_credentials.py)",
    );
  }
  return pass;
}
