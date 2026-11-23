import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireSingleInstanceLock } from "../../../connector/tally/src/singleInstance";

const directories: string[] = [];

function makeLockPath() {
  const directory = mkdtempSync(join(tmpdir(), "pesowise-agent-lock-"));
  directories.push(directory);
  return join(directory, "agent.lock");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("connector single-instance lock recovery", () => {
  it("recovers only a lock whose valid PID is confirmed dead", () => {
    const path = makeLockPath();
    writeFileSync(path, "987654321\n", "utf8");

    const lock = acquireSingleInstanceLock(path, (pid) => {
      expect(pid).toBe(987654321);
      return false;
    });

    expect(existsSync(path)).toBe(true);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a lock owned by a live PID", () => {
    const path = makeLockPath();
    writeFileSync(path, "2468\n", "utf8");

    expect(() => acquireSingleInstanceLock(path, () => true)).toThrow(/already running/);
    expect(existsSync(path)).toBe(true);
  });

  it("fails closed on malformed lock contents", () => {
    const path = makeLockPath();
    writeFileSync(path, "unknown\n", "utf8");

    expect(() => acquireSingleInstanceLock(path, () => false)).toThrow(/already running/);
    expect(existsSync(path)).toBe(true);
  });
});
