import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("edge _shared/tallyMapping imports", () => {
  it("does not use @/lib paths (Deno edge runtime)", () => {
    const root = join(process.cwd(), "supabase/functions/_shared/tallyMapping");
    const bad: string[] = [];
    for (const file of walkTs(root)) {
      const text = readFileSync(file, "utf-8");
      if (text.includes("@/lib/")) bad.push(file.replace(process.cwd(), ""));
    }
    expect(bad).toEqual([]);
  });

  it("uses explicit .ts on relative imports (Supabase Deno edge)", () => {
    const root = join(process.cwd(), "supabase/functions/_shared/tallyMapping");
    const bad: string[] = [];
    const re = /from (["'])(\.\.?\/[^"']+?)\1/g;
    for (const file of walkTs(root)) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(re)) {
        if (!m[2].endsWith(".ts")) bad.push(`${file.replace(process.cwd(), "")}: ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("run-tally-sync-delivery graph has no bare Node imports", () => {
    const entry = join(process.cwd(), "supabase/functions/run-tally-sync-delivery/index.ts");
    const importRe = /import\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?(["'])([^"']+)\1/g;
    const bareRe = /^[a-z@][\w.-]*$/i;
    const queue = [entry];
    const seen = new Set<string>();
    const bare: string[] = [];
    while (queue.length) {
      const file = queue.shift();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(importRe)) {
        const spec = m[2];
        if (bareRe.test(spec) && !spec.startsWith("node:") && !spec.startsWith("https://")) {
          bare.push(`${file}: ${spec}`);
        }
        if (spec.startsWith("./") || spec.startsWith("../")) {
          let p = join(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`);
          if (existsSync(p)) queue.push(p);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
