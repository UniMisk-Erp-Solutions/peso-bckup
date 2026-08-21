/**
 * Shared bulk-import engine for Form Field Template dropdowns (DOC-094; builds on
 * and supersedes the UI-unreachable dependent-table model in DOC-005's
 * cascadingOptionsCsv.ts — DOC-093 is an unrelated Batch Review hotfix).
 *
 * Handles two shapes of imported data:
 *
 *   FLAT LIST — one column of values, becomes template.options[]:
 *     Ahmedabad
 *     Mumbai
 *
 *   DEPENDENT TABLE — first column is the parent option, every other column is
 *   an independent sibling dependent dropdown shown together once that parent
 *   is selected (NOT a chained parent->child->child path):
 *     Project Unique ID,Project ID,Project Name
 *     UID-001,P-101,Alpha Tower
 *     UID-001,P-102,Alpha Annex
 *     UID-002,P-201,Beta Plaza
 *
 * Pure, no React/Supabase/browser imports (Excel parsing — which needs the
 * `xlsx` package and ArrayBuffer/File — lives in the sibling module
 * `dropdownBulkImportExcel.ts` so this file stays synchronously unit-testable
 * and does not pull the xlsx bundle into every caller).
 *
 * IMPORTANT ARCHITECTURE RULE: nothing here writes to Supabase. Every function
 * returns plain data; the caller decides when (and whether) to fold the result
 * into the editor's `options[]` / `branchDrafts[]` draft state. Persistence
 * remains solely `saveOptionBranchConfigurationAtomically` via the normal
 * template Save/Update button.
 */

import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import { slugifyFieldKey } from "@/lib/conditionalFormFields";

// ─── Limits ─────────────────────────────────────────────────────────────────
//
// The editor's list/matrix views already paginate hundreds of options and
// dependent fields, so these are guardrails against pathological input, not
// architectural limits. There is no known backend/RPC/schema limit on branch
// count or column count — `save_option_branch_configuration_atomically` takes
// the full branch array as jsonb, and `expense_form_field_option_branches` is a
// plain unindexed-on-count table. Kept generous but bounded to protect the
// browser (DOM/table rendering, not the parser) from an accidental multi-MB
// paste.

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_COLUMNS = 100;
export const PREVIEW_ROW_LIMIT = 25;

// ─── Tabular parsing (CSV / TSV, quote + embedded-newline aware) ──────────────

/**
 * RFC4180-ish state-machine parser for one delimiter over a whole text blob.
 * Handles (unlike a `.split(/\r?\n/)` + per-line parser):
 *   - quoted cells containing embedded \n / \r\n
 *   - CRLF and LF line endings, mixed
 *   - a leading UTF-8 BOM
 *   - doubled-quote escaping ("" -> ")
 *   - unicode content (no assumptions beyond JS string iteration)
 * Cells are trimmed (matches the existing `parseCsvLine` contract that callers
 * already depend on).
 */
export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const len = src.length;
  let sawAnyContentOnRow = false;

  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    sawAnyContentOnRow = false;
  };

  while (i < len) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      sawAnyContentOnRow = true;
      i++;
      continue;
    }

    if (ch === delimiter) {
      pushCell();
      sawAnyContentOnRow = true;
      i++;
      continue;
    }

    if (ch === "\r") {
      // Treat \r\n and lone \r as a single row break.
      if (src[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }

    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }

    cell += ch;
    sawAnyContentOnRow = true;
    i++;
  }

  // Flush a trailing cell/row that wasn't newline-terminated.
  if (cell.length > 0 || sawAnyContentOnRow || row.length > 0) {
    pushRow();
  }

  // Drop fully-blank rows (every cell empty after trim) — matches the
  // existing blank-row-skipping behaviour callers already rely on.
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/** Detects whether pasted/uploaded text is tab- or comma-delimited. */
export function sniffDelimiter(text: string): "\t" | "," {
  const firstLine = text.split(/\r?\n/, 5).find((l) => l.trim().length > 0) ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/**
 * Parse pasted or uploaded tabular text (CSV or TSV — including clipboard
 * content copied straight out of Excel or Google Sheets, which is TSV) into
 * a normalized string[][] table.
 */
export function parseTabularText(text: string, delimiterOverride?: "\t" | ","): string[][] {
  const delimiter = delimiterOverride ?? sniffDelimiter(text);
  return parseDelimitedText(text, delimiter);
}

// ─── Format detection ──────────────────────────────────────────────────────

export type DetectedFormat = "flat" | "dependent";

/**
 * A table is "dependent" when it has a header row PLUS at least one data row
 * (2+ rows total) and 2+ meaningful columns. Column-count is computed from
 * the widest row, ignoring wholly-blank trailing cells some spreadsheet
 * exports pad with.
 *
 * A single row is always "flat", regardless of column count — a lone line
 * like "Ahmedabad,Mumbai,Surat,Delhi" has nothing to be a dependent COLUMN
 * of (there's no second row to make "Mumbai" mean anything structurally); it
 * is simply a comma-separated flat list, exactly like a newline-separated one.
 */
export function detectImportFormat(rows: string[][]): DetectedFormat {
  if (rows.length <= 1) return "flat";
  const meaningfulColumns = rows.reduce((max, row) => {
    let lastNonBlank = -1;
    row.forEach((cell, i) => {
      if (cell.trim() !== "") lastNonBlank = i;
    });
    return Math.max(max, lastNonBlank + 1);
  }, 0);
  return meaningfulColumns >= 2 ? "dependent" : "flat";
}

// ─── Flat list parsing ─────────────────────────────────────────────────────

/**
 * Extract a flat option list from parsed rows. When `firstRowIsHeader` is
 * true the first row is dropped (used only for the ambiguous one-column case
 * where the user has confirmed row 1 is a label, not a real option).
 */
export function extractFlatList(rows: string[][], firstRowIsHeader: boolean): string[] {
  // A single row is the flat list itself — every cell in it is one option
  // ("Ahmedabad,Mumbai,Surat,Delhi" -> 4 options), not "column 0 of 1 row".
  if (rows.length === 1 && !firstRowIsHeader) {
    return rows[0].map((c) => c.trim()).filter(Boolean);
  }
  const dataRows = firstRowIsHeader ? rows.slice(1) : rows;
  const values: string[] = [];
  for (const row of dataRows) {
    const value = (row[0] ?? "").trim();
    if (value) values.push(value);
  }
  return values;
}

/**
 * Back-compat, simple flat parser used by the existing "Add pasted options" /
 * "Upload CSV/TXT" affordance in the Parent Options panel (parseBulkOptionValues
 * in templateEditor.ts). Kept separate on purpose: that path intentionally has
 * no CSV-quote awareness — it is comma/newline splitting for the "just paste a
 * quick list" case and predates this module. The richer import dialog always
 * goes through parseTabularText + extractFlatList instead.
 */

// ─── Dependent table parsing ───────────────────────────────────────────────

export type DependentTable = {
  parentHeader: string;
  dependentHeaders: string[];
  /** One entry per (parent value) with each dependent column's raw values (may contain blanks). */
  dataRows: { parent: string; values: string[] }[];
};

export type ParseTableResult =
  | { ok: true; table: DependentTable }
  | { ok: false; error: string };

/** Parse rows already known to be in "dependent table" shape (2+ columns, header row first). */
export function parseDependentTable(rows: string[][]): ParseTableResult {
  if (rows.length === 0) {
    return { ok: false, error: "The data is empty." };
  }
  const headerRow = rows[0];
  const columns = headerRow.length;

  if (columns > MAX_IMPORT_COLUMNS) {
    return {
      ok: false,
      error: `Too many columns (${columns}). Maximum supported is ${MAX_IMPORT_COLUMNS}.`,
    };
  }
  if (!headerRow[0]?.trim()) {
    return { ok: false, error: "The first column header (parent dropdown name) is required." };
  }
  for (let c = 1; c < columns; c++) {
    if (!headerRow[c]?.trim()) {
      return { ok: false, error: `Column ${c + 1} needs a header (the dependent dropdown name).` };
    }
  }

  const seenHeaderNorm = new Set<string>();
  for (let c = 1; c < columns; c++) {
    const norm = headerRow[c].trim().toLowerCase();
    if (seenHeaderNorm.has(norm)) {
      return {
        ok: false,
        error: `Duplicate column header "${headerRow[c]}". Each dependent dropdown needs a unique header.`,
      };
    }
    seenHeaderNorm.add(norm);
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `Too many rows (${dataRows.length}). Maximum supported is ${MAX_IMPORT_ROWS}.`,
    };
  }

  const parentHeader = headerRow[0].trim();
  const dependentHeaders = headerRow.slice(1).map((h) => h.trim());

  const parsedRows = dataRows.map((cells) => ({
    parent: (cells[0] ?? "").trim(),
    values: dependentHeaders.map((_, i) => (cells[i + 1] ?? "").trim()),
  }));

  return { ok: true, table: { parentHeader, dependentHeaders, dataRows: parsedRows } };
}

// ─── Header -> existing field matching ─────────────────────────────────────

export type ExistingFieldInfo = {
  fieldKey: string;
  name: string;
  fieldType: DraftOptionBranch["field_type"];
  required: boolean;
  placeholder: string;
  helpText: string;
};

/**
 * Build one representative entry per distinct existing root field_key (a
 * dependent field's identity is its field_key, shared across whichever parent
 * options currently configure it — mirrors the model already produced by
 * parseCascadingOptionsCsv and relied on by existing tests).
 */
export function indexExistingDependentFields(
  branchDrafts: DraftOptionBranch[],
): Map<string, ExistingFieldInfo> {
  const index = new Map<string, ExistingFieldInfo>();
  for (const d of branchDrafts) {
    if (d.parent_branch_local_id !== null) continue; // roots only
    if (!d.name.trim()) continue;
    const key = d.field_key.trim().toLowerCase();
    if (!key || index.has(key)) continue;
    index.set(key, {
      fieldKey: d.field_key,
      name: d.name,
      fieldType: d.field_type,
      required: d.required,
      placeholder: d.placeholder,
      helpText: d.help_text,
    });
  }
  return index;
}

export type HeaderMapping = {
  header: string;
  status: "matched" | "new" | "ambiguous";
  matchedFieldKey: string | null;
  candidates: string[];
  /** The field_key that will be used if this header creates a new field. */
  proposedFieldKey: string;
};

/**
 * Match one imported header against the existing-field index using, in order:
 *   1) exact field_key
 *   2) normalized (slugified) header vs existing field_key
 *   3) case-insensitive existing name
 *   4) normalized slug of existing name
 * If different rules resolve to different underlying field_keys, the header
 * is ambiguous and must be surfaced to the user rather than guessed.
 */
export function matchHeaderToExistingField(
  header: string,
  existingIndex: Map<string, ExistingFieldInfo>,
): HeaderMapping {
  const trimmed = header.trim();
  const proposedFieldKey = slugifyFieldKey(trimmed);
  const candidates = new Set<string>();

  if (existingIndex.has(trimmed.toLowerCase())) {
    candidates.add(trimmed.toLowerCase());
  }
  if (existingIndex.has(proposedFieldKey)) {
    candidates.add(proposedFieldKey);
  }
  for (const [key, info] of existingIndex) {
    if (info.name.trim().toLowerCase() === trimmed.toLowerCase()) candidates.add(key);
    if (slugifyFieldKey(info.name) === proposedFieldKey) candidates.add(key);
  }

  if (candidates.size === 0) {
    return { header: trimmed, status: "new", matchedFieldKey: null, candidates: [], proposedFieldKey };
  }
  if (candidates.size === 1) {
    const [only] = candidates;
    return { header: trimmed, status: "matched", matchedFieldKey: only, candidates: [only], proposedFieldKey };
  }
  return {
    header: trimmed,
    status: "ambiguous",
    matchedFieldKey: null,
    candidates: Array.from(candidates),
    proposedFieldKey,
  };
}

export function mapDependentHeaders(
  headers: string[],
  branchDrafts: DraftOptionBranch[],
): HeaderMapping[] {
  const existingIndex = indexExistingDependentFields(branchDrafts);
  return headers.map((h) => matchHeaderToExistingField(h, existingIndex));
}

// ─── Case-insensitive value normalization helpers ──────────────────────────

/** Dedupe a list case-insensitively, keeping the first-seen spelling. */
export function dedupePreservingFirst(values: string[]): { unique: string[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicates = 0;
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return { unique, duplicates };
}

// ─── Analysis (preview, before Apply) ──────────────────────────────────────

export type ImportConflict = {
  blocking: boolean;
  code: string;
  message: string;
};

export type FlatImportAnalysis = {
  format: "flat";
  rowsRead: number;
  usableRows: number;
  blankRowsSkipped: number;
  parentOptions: { existingMatched: number; new: number; duplicatesInImport: number };
  conflicts: ImportConflict[];
  hasBlockingConflicts: boolean;
  incomingValues: string[];
  preview: string[];
};

export type DependentImportAnalysis = {
  format: "dependent";
  rowsRead: number;
  usableRows: number;
  blankRowsSkipped: number;
  parentHeader: string;
  parentOptions: { existingMatched: number; new: number; duplicatesInImport: number };
  dependentFields: {
    matched: number;
    new: number;
    ambiguous: number;
    mappings: HeaderMapping[];
  };
  choices: { existing: number; new: number; duplicates: number; blankSkipped: number };
  conflicts: ImportConflict[];
  hasBlockingConflicts: boolean;
  table: DependentTable;
  preview: string[][];
};

export type ImportAnalysis = FlatImportAnalysis | DependentImportAnalysis;

export function analyzeFlatImport(
  rows: string[][],
  firstRowIsHeader: boolean,
  existingOptions: string[],
): FlatImportAnalysis {
  const rowsRead = rows.length;
  const raw = extractFlatList(rows, firstRowIsHeader);
  const blankRowsSkipped = (firstRowIsHeader ? rows.length - 1 : rows.length) - raw.length;
  const { unique, duplicates } = dedupePreservingFirst(raw);

  const existingLower = new Set(existingOptions.map((o) => o.toLowerCase()));
  const newCount = unique.filter((v) => !existingLower.has(v.toLowerCase())).length;
  const existingMatched = unique.length - newCount;

  const conflicts: ImportConflict[] = [];
  if (unique.length === 0) {
    conflicts.push({ blocking: true, code: "no_usable_rows", message: "No usable option values were found." });
  }

  return {
    format: "flat",
    rowsRead,
    usableRows: unique.length,
    blankRowsSkipped: Math.max(0, blankRowsSkipped),
    parentOptions: { existingMatched, new: newCount, duplicatesInImport: duplicates },
    conflicts,
    hasBlockingConflicts: conflicts.some((c) => c.blocking),
    incomingValues: unique,
    preview: unique.slice(0, PREVIEW_ROW_LIMIT),
  };
}

export function analyzeDependentImport(
  table: DependentTable,
  existingOptions: string[],
  existingBranchDrafts: DraftOptionBranch[],
): DependentImportAnalysis {
  const mappings = mapDependentHeaders(table.dependentHeaders, existingBranchDrafts);
  const conflicts: ImportConflict[] = [];

  const dupHeaderCheck = new Set<string>();
  for (const h of table.dependentHeaders) {
    const norm = h.toLowerCase();
    if (dupHeaderCheck.has(norm)) {
      conflicts.push({
        blocking: true,
        code: "duplicate_header",
        message: `Duplicate column header "${h}".`,
      });
    }
    dupHeaderCheck.add(norm);
  }

  const ambiguous = mappings.filter((m) => m.status === "ambiguous");
  for (const m of ambiguous) {
    conflicts.push({
      blocking: true,
      code: "ambiguous_mapping",
      message: `"${m.header}" matches more than one existing dependent field — choose which one it maps to.`,
    });
  }

  // Detect DISTINCT headers that resolve to the SAME effective field_key —
  // whether by matching the same existing field (e.g. "Project ID" and
  // "project_id" both matching field_key "project_id") or by slugifying to
  // the same brand-new field_key (e.g. "Project ID" and "project id" both
  // proposing "project_id" as a new field). Without this check both columns'
  // values would silently interleave into one field's choice list with no
  // warning — this must block rather than guess which column wins.
  const targetKeyGroups = new Map<string, string[]>();
  for (const m of mappings) {
    if (m.status === "ambiguous") continue; // already reported above
    const effectiveKey = (
      m.status === "matched" && m.matchedFieldKey ? m.matchedFieldKey : m.proposedFieldKey
    ).toLowerCase();
    const headers = targetKeyGroups.get(effectiveKey) ?? [];
    headers.push(m.header);
    targetKeyGroups.set(effectiveKey, headers);
  }
  for (const headers of targetKeyGroups.values()) {
    if (headers.length > 1) {
      conflicts.push({
        blocking: true,
        code: "duplicate_target_field",
        message: `Columns ${headers.map((h) => `"${h}"`).join(", ")} all resolve to the same field — rename one of them so each column maps to a distinct field before importing.`,
      });
    }
  }

  const usableRows = table.dataRows.filter((r) => r.parent).length;
  const blankRowsSkipped = table.dataRows.length - usableRows;

  const parentValues = table.dataRows.map((r) => r.parent).filter(Boolean);
  const { unique: uniqueParents, duplicates: dupParents } = dedupePreservingFirst(parentValues);
  const existingLower = new Set(existingOptions.map((o) => o.toLowerCase()));
  const newParents = uniqueParents.filter((v) => !existingLower.has(v.toLowerCase())).length;

  // Choice-level stats: for each (parent,column) cell, is the value new or a
  // duplicate against what's already saved for a MATCHED field + that parent?
  let existingChoices = 0;
  let newChoices = 0;
  let duplicateChoices = 0;
  let blankChoicesSkipped = 0;

  const existingChoiceSets = new Map<string, Set<string>>(); // `${fieldKey}${parentLower}` -> lowercased choice set
  for (const d of existingBranchDrafts) {
    if (d.parent_branch_local_id !== null) continue;
    const k = `${d.field_key.toLowerCase()}${d.parent_option_value.toLowerCase()}`;
    existingChoiceSets.set(k, new Set(d.options.map((o) => o.toLowerCase())));
  }

  const seenInImport = new Map<string, Set<string>>(); // dedupe within the import itself too

  for (const row of table.dataRows) {
    if (!row.parent) continue;
    row.values.forEach((value, i) => {
      if (!value) {
        blankChoicesSkipped++;
        return;
      }
      const mapping = mappings[i];
      const fieldKey = mapping.status === "matched" && mapping.matchedFieldKey
        ? mapping.matchedFieldKey
        : mapping.proposedFieldKey;
      const dedupeKey = `${fieldKey}${row.parent.toLowerCase()}`;
      let seenSet = seenInImport.get(dedupeKey);
      if (!seenSet) {
        seenSet = new Set();
        seenInImport.set(dedupeKey, seenSet);
      }
      const valueLower = value.toLowerCase();
      if (seenSet.has(valueLower)) {
        duplicateChoices++;
        return;
      }
      seenSet.add(valueLower);

      const existingSet = existingChoiceSets.get(dedupeKey);
      if (existingSet?.has(valueLower)) {
        existingChoices++;
      } else {
        newChoices++;
      }
    });
  }

  if (uniqueParents.length === 0) {
    conflicts.push({ blocking: true, code: "no_parent_values", message: "No parent option values were found in the first column." });
  }

  return {
    format: "dependent",
    rowsRead: table.dataRows.length,
    usableRows,
    blankRowsSkipped,
    parentHeader: table.parentHeader,
    parentOptions: { existingMatched: uniqueParents.length - newParents, new: newParents, duplicatesInImport: dupParents },
    dependentFields: {
      matched: mappings.filter((m) => m.status === "matched").length,
      new: mappings.filter((m) => m.status === "new").length,
      ambiguous: ambiguous.length,
      mappings,
    },
    choices: { existing: existingChoices, new: newChoices, duplicates: duplicateChoices, blankSkipped: blankChoicesSkipped },
    conflicts,
    hasBlockingConflicts: conflicts.some((c) => c.blocking),
    table,
    preview: [
      [table.parentHeader, ...table.dependentHeaders],
      ...table.dataRows.slice(0, PREVIEW_ROW_LIMIT).map((r) => [r.parent, ...r.values]),
    ],
  };
}

// ─── Apply to draft (Merge / Replace) ──────────────────────────────────────

export type ImportMode = "merge" | "replace";

export type ApplyFlatResult = {
  options: string[];
  added: number;
  skipped: number;
};

export function applyFlatImport(
  existingOptions: string[],
  incomingValues: string[],
): ApplyFlatResult {
  const existingSet = new Set(existingOptions.map((o) => o.toLowerCase()));
  const toAdd: string[] = [];
  let skipped = 0;
  for (const v of incomingValues) {
    const lower = v.toLowerCase();
    if (existingSet.has(lower)) {
      skipped++;
      continue;
    }
    existingSet.add(lower);
    toAdd.push(v);
  }
  return { options: [...existingOptions, ...toAdd], added: toAdd.length, skipped };
}

export type ApplyDependentResult = {
  options: string[];
  branchDrafts: DraftOptionBranch[];
  summary: {
    parentOptionsAdded: number;
    fieldsCreated: number;
    fieldsUpdated: number;
    choicesAdded: number;
    branchesRemoved: number;
  };
};

/**
 * Apply a parsed dependent table onto the current draft.
 *
 * MERGE (default, safe):
 *   - existing parent options are kept; missing imported parent values are
 *     appended (case-insensitive, preserving existing casing already in the
 *     draft — an imported value never overwrites how an option is already
 *     spelled in options[]).
 *   - a header that MATCHED an existing field_key never has its metadata
 *     (localId / dbId / field_type / name / field_key / required /
 *     placeholder / help_text / display_order) overwritten — only its
 *     choices are unioned in, case-insensitively, per parent option.
 *   - a header with no match creates one new root DraftOptionBranch per
 *     parent option that has a value for it (dbId: null, field_type:
 *     "select", a fresh field_key/localId).
 *   - nested descendant branches (parent_branch_local_id !== null) are never
 *     touched — the importer only ever produces/edits root siblings.
 *
 * REPLACE (explicit, scoped):
 *   - touches ONLY the (parent option x column) pairs actually present in the
 *     imported table. For each such pair, any existing root branch for that
 *     field_key + parent option (and that branch's nested descendants, if
 *     any) is removed and replaced with a fresh branch built purely from the
 *     import (no choice-merging with what was there before).
 *   - parent options not present in the import, dependent fields not present
 *     in the import, and any manually-configured field on a parent option
 *     that ISN'T one of the imported columns are left completely untouched.
 *   - options[] itself is never shrunk by Replace — parent options already in
 *     the draft are kept even if absent from this particular import; new
 *     imported parent options are still appended, exactly as in Merge.
 */
export function applyDependentImport(
  existingOptions: string[],
  existingBranchDrafts: DraftOptionBranch[],
  table: DependentTable,
  mappings: HeaderMapping[],
  mode: ImportMode,
): ApplyDependentResult {
  // 1) Options: append missing parent values (case-insensitive), same rule for both modes.
  const existingOptionsLower = new Map(existingOptions.map((o) => [o.toLowerCase(), o]));
  const nextOptions = [...existingOptions];
  let parentOptionsAdded = 0;
  const importedParentsSeen = new Set<string>(); // lowercased, de-duped in import order
  for (const row of table.dataRows) {
    if (!row.parent) continue;
    const lower = row.parent.toLowerCase();
    if (!importedParentsSeen.has(lower)) {
      importedParentsSeen.add(lower);
      if (!existingOptionsLower.has(lower)) {
        nextOptions.push(row.parent);
        existingOptionsLower.set(lower, row.parent);
        parentOptionsAdded++;
      }
    }
  }

  // Resolve each column to the field_key it will use, and (for new fields) a
  // shared display_order tail so multiple parents' new branches line up.
  const existingIndex = indexExistingDependentFields(existingBranchDrafts);
  let nextDisplayOrder =
    existingBranchDrafts.reduce((max, d) => Math.max(max, d.display_order), -1) + 1;

  const columnFieldKeys = mappings.map((m) =>
    m.status === "matched" && m.matchedFieldKey ? m.matchedFieldKey : m.proposedFieldKey,
  );
  const columnIsNew = mappings.map((m) => m.status !== "matched");
  const columnDisplayOrder: number[] = columnIsNew.map((isNew) => (isNew ? nextDisplayOrder++ : -1));

  let drafts = [...existingBranchDrafts];
  let fieldsCreated = 0;
  let fieldsUpdated = 0;
  let choicesAdded = 0;
  let branchesRemoved = 0;

  if (mode === "replace") {
    // Scoped removal: only roots whose (field_key, parent_option_value) pair
    // is actually represented in this import.
    const scopeParents = new Set(
      table.dataRows.filter((r) => r.parent).map((r) => r.parent.toLowerCase()),
    );
    const scopeFieldKeys = new Set(columnFieldKeys.map((k) => k.toLowerCase()));

    const toRemove = new Set<string>();
    for (const d of drafts) {
      if (d.parent_branch_local_id !== null) continue;
      if (!scopeParents.has(d.parent_option_value.toLowerCase())) continue;
      if (!scopeFieldKeys.has(d.field_key.toLowerCase())) continue;
      // Remove this root and its full nested subtree.
      const stack = [d.localId];
      while (stack.length) {
        const id = stack.pop()!;
        if (toRemove.has(id)) continue;
        toRemove.add(id);
        for (const child of drafts) {
          if (child.parent_branch_local_id === id) stack.push(child.localId);
        }
      }
    }
    branchesRemoved = toRemove.size;
    drafts = drafts.filter((d) => !toRemove.has(d.localId));
  }

  // 2) Fold in each imported (parent, column) value.
  //    Build/lookup one draft per (fieldKey, parentOptionValue) pair.
  const draftIndex = new Map<string, DraftOptionBranch>();
  for (const d of drafts) {
    if (d.parent_branch_local_id !== null) continue;
    draftIndex.set(`${d.field_key.toLowerCase()}${d.parent_option_value.toLowerCase()}`, d);
  }

  for (const row of table.dataRows) {
    if (!row.parent) continue;
    row.values.forEach((value, i) => {
      if (!value) return;
      const mapping = mappings[i];
      const fieldKey = columnFieldKeys[i];
      const key = `${fieldKey.toLowerCase()}${row.parent.toLowerCase()}`;
      let existing = draftIndex.get(key);

      if (!existing) {
        const template = mapping.status === "matched" && mapping.matchedFieldKey
          ? existingIndex.get(mapping.matchedFieldKey)
          : undefined;
        const newDraft: DraftOptionBranch = {
          localId: crypto.randomUUID(),
          dbId: null,
          parent_option_value: row.parent,
          parent_branch_local_id: null,
          field_key: fieldKey,
          name: template?.name ?? mapping.header,
          field_type: template?.fieldType ?? "select",
          required: template?.required ?? false,
          placeholder: template?.placeholder ?? "",
          help_text: template?.helpText ?? "",
          options: [],
          display_order:
            columnDisplayOrder[i] >= 0 ? columnDisplayOrder[i] : nextDisplayOrder++,
        };
        drafts.push(newDraft);
        draftIndex.set(key, newDraft);
        existing = newDraft;
        if (!template) fieldsCreated++;
      }

      if (!existing.options.some((o) => o.toLowerCase() === value.toLowerCase())) {
        existing.options = [...existing.options, value];
        choicesAdded++;
      }
    });
  }

  for (const m of mappings) {
    if (m.status === "matched") fieldsUpdated++;
  }

  return {
    options: nextOptions,
    branchDrafts: drafts,
    summary: { parentOptionsAdded, fieldsCreated, fieldsUpdated, choicesAdded, branchesRemoved },
  };
}

// ─── Replace-mode impact preview (shown before the user confirms) ─────────

export type ReplaceImpact = {
  parentOptionsTouched: string[];
  fieldsTouched: string[];
  branchesRemoved: number;
  nestedBranchesRemoved: number;
};

export function computeReplaceImpact(
  existingBranchDrafts: DraftOptionBranch[],
  table: DependentTable,
  mappings: HeaderMapping[],
): ReplaceImpact {
  const scopeParents = new Set(
    table.dataRows.filter((r) => r.parent).map((r) => r.parent.toLowerCase()),
  );
  const columnFieldKeys = mappings.map((m) =>
    m.status === "matched" && m.matchedFieldKey ? m.matchedFieldKey : m.proposedFieldKey,
  );
  const scopeFieldKeys = new Set(columnFieldKeys.map((k) => k.toLowerCase()));

  const touchedRoots: DraftOptionBranch[] = existingBranchDrafts.filter(
    (d) =>
      d.parent_branch_local_id === null &&
      scopeParents.has(d.parent_option_value.toLowerCase()) &&
      scopeFieldKeys.has(d.field_key.toLowerCase()),
  );

  let nestedBranchesRemoved = 0;
  const toRemove = new Set<string>();
  for (const root of touchedRoots) {
    const stack = [root.localId];
    while (stack.length) {
      const id = stack.pop()!;
      if (toRemove.has(id)) continue;
      toRemove.add(id);
      for (const child of existingBranchDrafts) {
        if (child.parent_branch_local_id === id) {
          stack.push(child.localId);
          nestedBranchesRemoved++;
        }
      }
    }
  }

  return {
    parentOptionsTouched: Array.from(new Set(touchedRoots.map((r) => r.parent_option_value))),
    fieldsTouched: Array.from(new Set(touchedRoots.map((r) => r.name || r.field_key))),
    branchesRemoved: toRemove.size,
    nestedBranchesRemoved,
  };
}

// ─── Sample data ────────────────────────────────────────────────────────────

export function buildFlatSampleList(): string {
  return ["Ahmedabad", "Mumbai", "Surat", "Delhi"].join("\n");
}
