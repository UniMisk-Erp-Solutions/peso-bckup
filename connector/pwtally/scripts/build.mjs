#!/usr/bin/env node
/**
 * Builds dist/PesoWiseTally.exe: esbuild bundle (CJS, node18) -> pkg (win-x64).
 * Uses the repo-root esbuild and the already-installed `pkg` binary (offline; base node18 binary is cached).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const require = createRequire(join(repo, "package.json"));
const esbuild = require("esbuild");

mkdirSync(join(root, "dist"), { recursive: true });
await esbuild.build({
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: join(root, "dist", "PesoWiseTally.cjs"),
  logLevel: "info",
});

const pkgBin = [join(repo, "connector", "tally", "node_modules", "pkg", "lib-es5", "bin.js"), join(repo, "node_modules", "pkg", "lib-es5", "bin.js")]
  .find(existsSync);
if (!pkgBin) {
  console.error("pkg not found. Run: npm i -D pkg@5 (in connector/pwtally) and retry.");
  process.exit(1);
}
const out = join(root, "dist", "PesoWiseTally.exe");
const r = spawnSync(process.execPath, [pkgBin, join(root, "dist", "PesoWiseTally.cjs"), "--targets", "node18-win-x64", "--output", out], {
  cwd: root, stdio: "inherit",
});
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(join(root, "dist", "BUILD_INFO.txt"), `PesoWiseTally.exe built ${new Date().toISOString()}\n`);
console.log("Built", out);
