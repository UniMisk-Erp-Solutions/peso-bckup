/**
 * Normalize ML USERS.csv (or similar) into Pesowise bulk-upload format.
 *
 * Usage:
 *   node scripts/format-bulk-users-csv.mjs "C:\path\to\ML USERS.csv"
 *
 * Output: same folder, file named "<basename>-pesowise-bulk.csv"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const POSITION_ALIASES = new Map([
  ["employees", "employee"],
  ["employee", "employee"],
  ["staff", "employee"],
  ["user", "employee"],
  ["manager", "engineer"],
  ["engineer", "engineer"],
  ["admin", "admin"],
  ["administrator", "admin"],
  ["cashier", "cashier"],
  ["team_leader", "team_leader"],
  ["team leader", "team_leader"],
  ["teamleader", "team_leader"],
  ["tl", "team_leader"],
  ["executive", "executive"],
  ["exec", "executive"],
]);

function parseCsvLine(line) {
  const out = [];
  let curr = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        curr += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(curr.trim());
      curr = "";
      continue;
    }
    curr += ch;
  }
  out.push(curr.trim());
  return out;
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function normalizePosition(value) {
  const key = String(value || "").trim().toLowerCase();
  return POSITION_ALIASES.get(key) || "employee";
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/format-bulk-users-csv.mjs <input.csv>");
  process.exit(1);
}

const raw = readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
if (lines.length < 2) {
  console.error("CSV must have a header row and at least one data row.");
  process.exit(1);
}

const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
const col = (name) => headers.indexOf(name);

const nameIdx = col("name");
const empIdx = col("employee_id");
const posIdx = col("position");
const passIdx = col("password");
const supIdx = col("immediate_supervisor_employee_id");
const locIdx = col("location");

if ([nameIdx, empIdx, posIdx, passIdx].some((i) => i < 0)) {
  console.error(
    "Input must include columns: name, employee_id, position, password (optional: immediate_supervisor_employee_id, location)",
  );
  process.exit(1);
}

const outHeader =
  "name,employee_id,position,password,immediate_supervisor_employee_id,location";
const outRows = [outHeader];
const errors = [];

for (let i = 1; i < lines.length; i += 1) {
  const cells = parseCsvLine(lines[i]);
  const name = (cells[nameIdx] || "").trim();
  const employeeId = (cells[empIdx] || "").trim();
  const position = normalizePosition(cells[posIdx]);
  const password = (cells[passIdx] || "").trim();
  const supervisor =
    supIdx >= 0 ? (cells[supIdx] || "").trim() : "";
  const location = locIdx >= 0 ? (cells[locIdx] || "").trim() : "";

  if (!name || !employeeId || !password) {
    errors.push(`Row ${i + 1}: missing name, employee_id, or password`);
    continue;
  }

  outRows.push(
    [
      escapeCsv(name),
      escapeCsv(employeeId),
      position,
      escapeCsv(password),
      escapeCsv(supervisor),
      escapeCsv(location),
    ].join(","),
  );
}

const base = basename(inputPath, ".csv");
const outputPath = join(dirname(inputPath), `${base}-pesowise-bulk.csv`);
writeFileSync(outputPath, `${outRows.join("\n")}\n`, "utf8");

console.log(`Wrote ${outRows.length - 1} rows to:\n${outputPath}`);
if (errors.length) {
  console.warn(`Skipped ${errors.length} invalid rows:`);
  errors.slice(0, 5).forEach((e) => console.warn(`  ${e}`));
}
