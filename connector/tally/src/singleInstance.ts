import { openSync, closeSync, existsSync, readFileSync, unlinkSync, writeSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOCK = join(homedir(), "PesoWise", "TallyConnector", "agent.lock");

export function agentLockPath(): string {
  return LOCK;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireSingleInstanceLock(
  lockPath = LOCK,
  isAlive: (pid: number) => boolean = pidIsAlive,
): { release: () => void } {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const text = existsSync(lockPath) ? readFileSync(lockPath, "utf8").trim() : "";
    const priorPid = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(priorPid) || priorPid <= 0 || isAlive(priorPid)) {
      throw new Error("PesoWise Tally Agent is already running (single-instance lock).");
    }
    // Recover only a well-formed lock whose owner PID is confirmed dead. The
    // exclusive create below wins safely if another connector starts meanwhile.
    unlinkSync(lockPath);
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      throw new Error("PesoWise Tally Agent is already running (single-instance lock).");
    }
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return {
    release: () => {
      try {
        if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    },
  };
}
