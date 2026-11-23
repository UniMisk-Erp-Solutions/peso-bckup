#!/usr/bin/env node
/**
 * Builds a single customer exe: PesoWiseSync.exe (pkg, Windows x64).
 */
import { spawnSync } from "child_process";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const entry = join(root, "dist", "main.js");
const requestedOutput = process.argv[2];
const primary = requestedOutput
  ? (isAbsolute(requestedOutput) ? requestedOutput : join(root, requestedOutput))
  : join(root, "dist", "PesoWiseSync.exe");
const replaceDistBuild = !requestedOutput;

if (!existsSync(entry)) {
  console.error("Run npm run build first");
  process.exit(1);
}

const pkgBin = join(root, "node_modules", "pkg", "lib-es5", "bin.js");
if (!existsSync(pkgBin)) {
  console.error("Install pkg in connector/tally: npm install --save-dev pkg");
  process.exit(1);
}

if (replaceDistBuild) {
  for (const name of readdirSync(join(root, "dist"))) {
    if (/^PesoWise.*\.exe$/i.test(name) && name !== "PesoWiseSync.exe") {
      try {
        unlinkSync(join(root, "dist", name));
        console.log("Removed old", name);
      } catch {
        /* ignore */
      }
    }
  }
}

const r = spawnSync(
  process.execPath,
  [pkgBin, "dist/main.js", "--targets", "node18-win-x64", "--output", primary, "--compress", "GZip"],
  { cwd: root, stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

let version = "unknown";
try {
  const doctor = readFileSync(join(root, "src", "doctor.ts"), "utf-8");
  const m = doctor.match(/AGENT_VERSION\s*=\s*"([^"]+)"/);
  if (m) version = m[1];
} catch {
  /* optional */
}
writeFileSync(
  join(dirname(primary), "BUILD_INFO.txt"),
  `product=PesoWiseSync.exe\r\nversion=${version}\r\nbuilt=${new Date().toISOString()}\r\n`,
  "utf-8",
);
console.log(`Built ${primary} (${version})`);
