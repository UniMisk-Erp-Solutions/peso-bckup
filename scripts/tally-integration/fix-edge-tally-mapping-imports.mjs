#!/usr/bin/env node
/** Add .ts to relative imports in supabase/functions/_shared/tallyMapping for Deno edge. */
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const root = join(process.cwd(), "supabase/functions/_shared/tallyMapping");

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (name.endsWith(".ts")) files.push(p);
  }
  return files;
}

const re = /from (["'])(\.\.?\/[^"']+?)\1/g;

for (const file of walk(root)) {
  let text = readFileSync(file, "utf-8");
  const next = text.replace(re, (_, q, spec) => {
    if (spec.endsWith(".ts")) return `from ${q}${spec}${q}`;
    return `from ${q}${spec}.ts${q}`;
  });
  if (next !== text) {
    writeFileSync(file, next, "utf-8");
    console.log("fixed:", file.replace(process.cwd(), ""));
  }
}
