/**
 * Verifies hi and gu locale files have the same keys as en.
 * Run: npm run i18n:check
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, "..", "src", "locales");

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function loadJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

const enDir = path.join(localesDir, "en");
const files = fs.readdirSync(enDir).filter((f) => f.endsWith(".json"));

let failed = false;

for (const file of files) {
  const enKeys = new Set(flattenKeys(loadJson(path.join(enDir, file))));
  for (const lang of ["hi", "gu"] as const) {
    const langPath = path.join(localesDir, lang, file);
    if (!fs.existsSync(langPath)) {
      console.error(`[i18n] missing file: ${lang}/${file}`);
      failed = true;
      continue;
    }
    const langKeys = new Set(flattenKeys(loadJson(langPath)));
    for (const key of enKeys) {
      if (!langKeys.has(key)) {
        console.error(`[i18n] ${lang}/${file} missing key: ${key}`);
        failed = true;
      }
    }
    for (const key of langKeys) {
      if (!enKeys.has(key)) {
        console.error(`[i18n] ${lang}/${file} extra key: ${key}`);
        failed = true;
      }
    }
  }
}

if (failed) {
  console.error("\ni18n key check failed.");
  process.exit(1);
}

console.log(`i18n key check passed (${files.length} namespaces × 2 languages).`);
