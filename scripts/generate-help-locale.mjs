/**
 * Generates src/locales/en/help.json from tutorialManuals structure.
 * Run: node scripts/generate-help-locale.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "src/content/tutorialManuals.ts"), "utf8");

// Extract tutorialManuals object via dynamic import workaround - parse JSON-like sections
// Use eval on exported object by transpiling minimal extract
const match = src.match(/export const tutorialManuals[^=]*=\s*(\{[\s\S]*\});?\s*$/);
if (!match) {
  console.error("Could not parse tutorialManuals");
  process.exit(1);
}

// Safe-ish eval in build script only
const tutorialManuals = eval(`(${match[1]})`);

const out = {};
for (const [role, manual] of Object.entries(tutorialManuals)) {
  out[role] = {
    displayName: manual.displayName,
    summary: manual.summary,
    lastUpdated: manual.lastUpdated,
    quickLinks: manual.quickLinks,
    sections: Object.fromEntries(
      manual.sections.map((s) => [
        s.id,
        { title: s.title, paragraphs: s.paragraphs },
      ]),
    ),
  };
}

const outPath = path.join(root, "src/locales/en/help.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("Wrote", outPath);
