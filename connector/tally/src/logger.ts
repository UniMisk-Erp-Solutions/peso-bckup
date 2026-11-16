import { appendFileSync, copyFileSync, mkdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), "PesoWise", "TallyConnector");
const LOG_PATH = join(LOG_DIR, "connector.log");
const MAX = 2_000_000;

export function logFilePath(): string {
  return LOG_PATH;
}

function redact(line: string): string {
  return line
    .replace(/device_token=\S+/gi, "device_token=[REDACTED]")
    .replace(/X-Connector-Token:\s*\S+/gi, "X-Connector-Token: [REDACTED]")
    .replace(/"device_token"\s*:\s*"[^"]+"/gi, '"device_token":"[REDACTED]"');
}

function rotateIfNeeded() {
  try {
    const st = statSync(LOG_PATH);
    if (st.size > MAX) {
      const backup = `${LOG_PATH}.1`;
      try {
        unlinkSync(backup);
      } catch {
        /* no prior backup */
      }
      copyFileSync(LOG_PATH, backup);
      appendFileSync(LOG_PATH, "", { flag: "w" });
    }
  } catch {
    /* new file */
  }
}

export function log(line: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  rotateIfNeeded();
  const row = `${new Date().toISOString()} ${redact(line)}\n`;
  appendFileSync(LOG_PATH, row, "utf-8");
}

export function logError(line: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : err != null ? String(err) : "";
  log(detail ? `${line}: ${detail}` : line);
}

/** Production: survive unhandled rejections without silent exit. */
export function installGlobalErrorHandlers(): void {
  process.on("uncaughtException", (e) => {
    logError("uncaughtException", e);
  });
  process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason);
  });
}
