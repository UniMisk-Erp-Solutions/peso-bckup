#!/usr/bin/env node
/**
 * Build a bulk-import CSV from an operator-supplied employee TSV.
 *
 * The password column is GONE. Bulk import authenticates server-side with
 * administrative authorization against immutable user IDs; it never needed a
 * per-employee credential, and carrying one is what made the old input file a
 * P0 exposure. A supplied password column is now rejected outright.
 *
 * 1. Edit scripts/data/microlink-supervisor-emails.json with real supervisor emails.
 * 2. node scripts/generate-microlink-import-csv.mjs
 * 3. Upload scripts/data/microlink-bulk-import.csv via User Management (dry run first).
 */
import fs from "fs";
import path from "path";
import {
  loadEmployeeRows,
  parseArgs,
  resolveOutputPath,
} from "./lib/employeeDataInput.mjs";

import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const outPath = resolveOutputPath(args, "microlink-bulk-import.csv");

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split("\t");
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    const row = {};
    header.forEach((key, idx) => {
      row[key.trim()] = (cols[idx] || "").trim();
    });
    rows.push(row);
  }
  return rows;
}

// Supervisor emails are personal data too, so they are operator-supplied like
// the employee file — never a tracked default.
const mapPath = args.get("supervisors");
if (typeof mapPath !== "string") {
  throw new Error("Pass --supervisors <path> to a JSON map of supervisor employee_id -> email.");
}
const supervisorMap = JSON.parse(fs.readFileSync(path.resolve(mapPath), "utf8"));
const { rows } = loadEmployeeRows(args, { requiredColumns: ["employee_id"] });

const headers = [
  "name",
  "employee_id",
  "position",
  "immediate_supervisor_email",
  "location",
];

const missing = new Set();
const csvRows = rows.map((row) => {
  const supEmpId = String(row.immediate_supervisor_employee_id || "").trim().toLowerCase();
  const supEmail = supEmpId ? String(supervisorMap[supEmpId] || "").trim().toLowerCase() : "";
  if (supEmpId && !supEmail) missing.add(supEmpId);
  if (supEmail.startsWith("replace_with_")) missing.add(supEmpId);

  return [
    row.name,
    row.employee_id,
    row.position || "employee",
    supEmail,
    row.location || "",
  ];
});

if (missing.size > 0) {
  console.error("Missing supervisor email mapping for employee_id(s):", [...missing].join(", "));
  console.error(`Edit ${mapPath} and re-run.`);
  process.exit(1);
}

const csv = [headers.join(","), ...csvRows.map((r) => r.map(csvEscape).join(","))].join("\n");
fs.writeFileSync(outPath, csv, "utf8");
console.log(`Wrote ${csvRows.length} rows to ${outPath}`);
