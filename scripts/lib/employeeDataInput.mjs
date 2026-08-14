/**
 * Runtime input contract for scripts that consume employee operational data.
 *
 * WHY THIS EXISTS
 * ---------------
 * These generators used to read a tracked file, `scripts/data/microlink-remove-
 * employees.tsv`, that held real employee records including plaintext logins.
 * A default path pointing at committed employee data is the root cause: it makes
 * committing the data the path of least resistance, so it happens once and then
 * stays forever.
 *
 * There is deliberately NO default path. A caller must pass `--input` or set
 * PESOWISE_EMPLOYEE_DATA_FILE, and the value must resolve outside the repository
 * working tree. Running these scripts without operator-supplied data is meant to
 * fail, loudly and immediately.
 *
 * See Documentations MD/sensitive-local-data-policy.md.
 */

import fs from "fs";
import path from "path";
import process from "process";

/** Columns these generators are permitted to consume. */
export const ALLOWED_COLUMNS = new Set([
  "name",
  "employee_id",
  "position",
  "immediate_supervisor_employee_id",
  "location",
  "email",
]);

/**
 * Columns rejected outright. A credential must never reach these tools: the
 * import path uses server-side administrative authorization and immutable user
 * IDs, so it has no legitimate use for one.
 */
export const REJECTED_COLUMNS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "private_key",
  "service_role",
]);

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

/** Files created during a run, removed by `cleanup()` even on failure. */
const temporaries = new Set();

export function registerTemporary(file) {
  temporaries.add(path.resolve(file));
}

export function cleanup() {
  for (const file of temporaries) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      /* best effort — never mask the original failure */
    }
  }
  temporaries.clear();
}

process.on("exit", cleanup);

/**
 * These generators are top-level module scripts, so there is no call site to
 * wrap. A process-level handler gives them all the same contract: an input
 * problem prints one clear message and exits 1, with no stack trace — a stack
 * can carry a record through an interpolated template.
 */
process.on("uncaughtException", (error) => {
  cleanup();
  if (error instanceof InputError) {
    console.error(`
${error.message}
`);
  } else {
    console.error(`
${error?.name ?? "Error"}: ${error?.message ?? "unknown failure"}
`);
  }
  process.exit(1);
});

/** Minimal `--flag value` parser. Returns a Map. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out.set(key, true);
    } else {
      out.set(key, next);
      i += 1;
    }
  }
  return out;
}

/**
 * Resolve and validate the operator-supplied input path.
 *
 * `lstat` is used rather than `stat` so a symlink is rejected explicitly instead
 * of being followed somewhere unintended.
 */
export function resolveInputPath(args, { repoRoot = process.cwd() } = {}) {
  const supplied =
    (typeof args.get("input") === "string" ? args.get("input") : null) ??
    process.env.PESOWISE_EMPLOYEE_DATA_FILE ??
    null;

  if (!supplied) {
    throw new InputError(
      "No input file. Pass --input <path> or set PESOWISE_EMPLOYEE_DATA_FILE.\n" +
        "The file must live outside the repository — see " +
        "Documentations MD/sensitive-local-data-policy.md.",
    );
  }

  const resolved = path.resolve(supplied);

  const stats = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stats) throw new InputError(`Input file does not exist: ${resolved}`);
  if (stats.isSymbolicLink()) {
    throw new InputError(`Input must be a regular file, not a symlink: ${resolved}`);
  }
  if (stats.isDirectory()) throw new InputError(`Input is a directory, not a file: ${resolved}`);
  if (!stats.isFile()) throw new InputError(`Input is not a regular file: ${resolved}`);

  // Inside the repo the file can be committed by accident, which is exactly the
  // failure being designed out. An explicitly ignored local directory is fine.
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, resolved);
  const insideRepo = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  const inIgnoredLocalDir = relative.split(path.sep)[0] === ".local-sensitive-data";
  if (insideRepo && !inIgnoredLocalDir) {
    throw new InputError(
      `Input must not live inside the repository: ${resolved}\n` +
        "Move it outside the working tree, or under .local-sensitive-data/ which is gitignored.",
    );
  }

  // POSIX only; Windows ACLs are not represented in st_mode.
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    console.warn(
      `[warn] ${resolved} is readable by other users. chmod 600 it before it holds employee data.`,
    );
  }

  return resolved;
}

/**
 * Parse a TSV into rows, enforcing the column allowlist.
 *
 * Errors name only the row number and the field, never a value — a validation
 * message must not become the place personal data leaks.
 */
export function parseEmployeeTsv(text, { requiredColumns = [] } = {}) {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new InputError("Input file is empty.");

  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());

  const rejected = header.filter((h) => REJECTED_COLUMNS.has(h));
  if (rejected.length > 0) {
    throw new InputError(
      `Input contains prohibited column(s): ${rejected.join(", ")}. ` +
        "These tools never consume credentials; remove the column and retry.",
    );
  }

  const unknown = header.filter((h) => h && !ALLOWED_COLUMNS.has(h));
  if (unknown.length > 0) {
    throw new InputError(`Input contains unsupported column(s): ${unknown.join(", ")}.`);
  }

  for (const required of requiredColumns) {
    if (!header.includes(required)) {
      throw new InputError(`Input is missing the required column: ${required}`);
    }
  }

  const rows = [];
  const seenEmployeeIds = new Set();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    const row = {};
    header.forEach((key, idx) => {
      if (key) row[key] = (cols[idx] ?? "").trim();
    });

    for (const required of requiredColumns) {
      if (!row[required]) {
        throw new InputError(`Row ${i + 1}: required field "${required}" is blank.`);
      }
    }

    if (row.employee_id) {
      if (seenEmployeeIds.has(row.employee_id)) {
        // Position only — the duplicated ID itself is not echoed.
        throw new InputError(`Row ${i + 1}: duplicate employee_id.`);
      }
      seenEmployeeIds.add(row.employee_id);
    }

    rows.push(row);
  }

  return { header, rows };
}

/** Load + parse in one call. Never logs a record. */
export function loadEmployeeRows(args, options = {}) {
  const inputPath = resolveInputPath(args, options);
  const text = fs.readFileSync(inputPath, "utf8");
  const parsed = parseEmployeeTsv(text, options);
  console.log(`Loaded ${parsed.rows.length} rows from the operator-supplied input file.`);
  return { ...parsed, inputPath };
}

/**
 * Where generated output containing personal data may be written. Anything else
 * risks a generated export becoming the next tracked file.
 */
export function resolveOutputPath(args, defaultName, { repoRoot = process.cwd() } = {}) {
  const supplied = typeof args.get("out") === "string" ? args.get("out") : null;
  if (supplied) return path.resolve(supplied);
  const dir = path.resolve(repoRoot, ".local-sensitive-data", "exports");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, defaultName);
}

/** Destructive operations require an explicit, typed acknowledgement. */
export function requireConfirmation(args, what) {
  if (args.get("confirm") === true || args.get("confirm") === "yes") return;
  throw new InputError(
    `Refusing to ${what} without --confirm. Re-run with --confirm once you have reviewed the plan.`,
  );
}

/** Standard entrypoint wrapper: clean exit codes, no stack trace with records. */
export function runScript(main) {
  try {
    main();
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    // Message only — a stack could carry a row through a template literal.
    console.error(`\n${error?.name ?? "Error"}: ${error?.message ?? "unknown failure"}\n`);
    process.exit(1);
  } finally {
    cleanup();
  }
}
