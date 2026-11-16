#!/usr/bin/env node
/**
 * Static validation of run-tally-sync-delivery local import graph (pre-deploy).
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FUNCS = join(ROOT, "supabase/functions");
const ENTRY = join(FUNCS, "run-tally-sync-delivery/index.ts");

const importRe = /import\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?(["'])([^"']+)\1/g;
const bareRe = /^[a-z@][\w.-]*$/i;

function resolve(spec, fromFile) {
  if (spec.startsWith("https://")) return { kind: "remote", spec };
  if (bareRe.test(spec) && !spec.startsWith("node:")) return { kind: "bare", spec };
  let path = spec;
  if (path.startsWith("../") || path.startsWith("./")) {
    path = join(dirname(fromFile), path);
  } else if (path.startsWith("_shared/")) {
    path = join(FUNCS, path);
  } else {
    return { kind: "unknown", spec };
  }
  if (!path.endsWith(".ts")) path += ".ts";
  return { kind: "local", path, exists: existsSync(path) };
}

const queue = [ENTRY];
const seen = new Set();
const bare = [];
const missing = [];
const extensionless = [];

while (queue.length) {
  const file = queue.shift();
  if (!file || seen.has(file)) continue;
  seen.add(file);
  if (!existsSync(file)) {
    missing.push(file);
    continue;
  }
  const text = readFileSync(file, "utf-8");
  for (const m of text.matchAll(importRe)) {
    const spec = m[2];
    if (spec.startsWith("./") || spec.startsWith("../")) {
      if (!spec.endsWith(".ts")) extensionless.push({ file, spec });
    }
    const r = resolve(spec, file);
    if (r.kind === "bare") bare.push({ file, spec });
    if (r.kind === "local") {
      if (!r.exists) missing.push(r.path);
      else queue.push(r.path);
    }
  }
}

const ok = bare.length === 0 && missing.length === 0 && extensionless.length === 0;
console.log(
  JSON.stringify(
    {
      entry: ENTRY,
      files_in_graph: seen.size,
      bare_node_imports: bare,
      missing_local: missing,
      extensionless_relative: extensionless,
      validation: ok ? "PASS" : "FAIL",
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
