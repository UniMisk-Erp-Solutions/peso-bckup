#!/usr/bin/env node
/** Free localhost ports used by `npm run dev` (stale Vite / bridge from a prior session). */
import { execSync } from "child_process";

/** Only free Vite — leave Tally connector (9876) running across dev restarts. */
const PORTS = [3000];

function sleep(ms) {
  execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: "ignore" });
}

function pidsOnPort(port) {
  try {
    const cmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: "utf8" }).trim();
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" });
    console.log(`[dev] Stopped PID ${pid} (was using dev port)`);
    return true;
  } catch {
    return false;
  }
}

for (const port of PORTS) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) break;
    for (const pid of pids) killPid(pid);
    sleep(400);
  }
}
