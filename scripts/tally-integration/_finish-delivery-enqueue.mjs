#!/usr/bin/env node
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const jobId = process.argv[2];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
for (let i = 0; i < 25; i++) {
  const r = spawnSync(process.execPath, ["scripts/tally-integration/_run-delivery-only.mjs", jobId], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const line = (r.stdout || "").trim().split("\n").pop() ?? "";
  console.log(i, line);
  if (!line.includes('"more_chunks":true')) break;
  await new Promise((x) => setTimeout(x, 1200));
}
