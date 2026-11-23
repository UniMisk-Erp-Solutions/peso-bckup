#!/usr/bin/env node
/** Copy repo tally-extension → C:\\pesowise (TallyPrime TDL load path). */
import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(ROOT, "tally-extension");
const dest = process.env.PESOWISE_TDL_DIR ?? "C:\\pesowise";

if (!existsSync(src)) {
  console.warn("[tally] tally-extension missing — skip TDL sync");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src)) {
  const sourcePath = join(src, name);
  const destinationPath = join(dest, name);
  if (statSync(sourcePath).isDirectory()) {
    mkdirSync(destinationPath, { recursive: true });
    for (const child of readdirSync(sourcePath)) {
      const childSourcePath = join(sourcePath, child);
      const childDestinationPath = join(destinationPath, child);
      if (statSync(childSourcePath).isDirectory()) {
        cpSync(childSourcePath, childDestinationPath, { recursive: true, force: true });
      } else {
        cpSync(childSourcePath, childDestinationPath, { force: true });
      }
    }
  } else {
    cpSync(sourcePath, destinationPath, { force: true });
  }
}
console.log(`[tally] TDL synced to ${dest}`);
console.log(
  "[tally] In TallyPrime F12 load: PesoWise-Bootstrap.tdl + PesoWise-Load.tdl (NOT SafeMenu). Quit & restart Tally.",
);
