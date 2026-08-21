import { slugifyFieldKey } from "@/lib/conditionalFormFields";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import { parseDelimitedText, MAX_IMPORT_ROWS, MAX_IMPORT_COLUMNS } from "@/lib/formBuilder/dropdownBulkImport";

/**
 * Bulk import for dependent (conditional) dropdowns.
 *
 * Model: the FIRST column is the parent dropdown (the template being edited).
 * EVERY other column is an independent dependent dropdown that is shown at the
 * same time once a parent option is selected, filtered to the rows for that
 * parent option.
 *
 * Example:
 *   Project Unique ID,Project ID,Project Name
 *   U1,P-101,Alpha Tower
 *   U1,P-102,Alpha Annex
 *   U2,P-201,Beta Plaza
 *
 * Selecting "U1" shows two dropdowns together:
 *   - Project ID   -> [P-101, P-102]
 *   - Project Name -> [Alpha Tower, Alpha Annex]
 *
 * Each dependent column becomes a root branch per parent option (depth 1), so
 * this only needs the conditional-dropdown feature (not nested).
 */

export type DependentImportStats = {
  dataRows: number;
  dependentFields: number;
  parentOptions: number;
  branchRows: number;
};

export type DependentImportResult = {
  parentLabel: string;
  dependentLabels: string[];
  templateOptions: string[];
  branchDrafts: DraftOptionBranch[];
  stats: DependentImportStats;
  warnings: string[];
};

export type ParseDependentResult =
  | { ok: true; result: DependentImportResult }
  | { ok: false; error: string };

// Not architectural limits \u2014 see MAX_IMPORT_ROWS/MAX_IMPORT_COLUMNS in
// dropdownBulkImport.ts for why these are generous browser guardrails rather
// than a real backend/schema constraint (there isn't one).
const MAX_DEPENDENT_COLUMNS = MAX_IMPORT_COLUMNS - 1; // one column is the parent
const MAX_DATA_ROWS = MAX_IMPORT_ROWS;

/**
 * Quote-aware single CSV line splitter (handles "a,b" and escaped "").
 * Kept as a thin wrapper over the shared state-machine parser so existing
 * callers/tests keep working unchanged.
 */
export function parseCsvLine(line: string): string[] {
  return parseDelimitedText(line, ",")[0] ?? [];
}

/**
 * Split the whole CSV text into rows using the shared quote-aware parser.
 * Unlike the old line-by-line splitter, this correctly handles a quoted cell
 * that contains an embedded newline (it does not naively split on \r?\n
 * before quote parsing).
 */
function splitRows(text: string): string[][] {
  return parseDelimitedText(text, ",");
}

/**
 * Parse a dependent-dropdowns CSV into parent template options + sibling branch
 * drafts (all shown together under the selected parent option).
 */
export function parseCascadingOptionsCsv(text: string): ParseDependentResult {
  const rows = splitRows(text);
  if (rows.length === 0) {
    return { ok: false, error: "The file is empty." };
  }

  const headers = rows[0].map((h) => h.trim());
  const columns = headers.length;

  if (columns < 2) {
    return {
      ok: false,
      error:
        "Need at least 2 columns: the parent dropdown (column 1) and one dependent dropdown.",
    };
  }
  if (!headers[0]) {
    return { ok: false, error: "The first column header (parent dropdown name) is required." };
  }
  for (let c = 1; c < columns; c++) {
    if (!headers[c]) {
      return { ok: false, error: `Column ${c + 1} needs a header (the dependent dropdown name).` };
    }
  }

  const dependentCount = columns - 1;
  if (dependentCount > MAX_DEPENDENT_COLUMNS) {
    return {
      ok: false,
      error: `Too many dependent dropdowns (${dependentCount}). Maximum supported is ${MAX_DEPENDENT_COLUMNS}.`,
    };
  }

  // Unique field keys per dependent column.
  const dependentLabels = headers.slice(1);
  const fieldKeys = dependentLabels.map((label, i) => {
    const base = slugifyFieldKey(label) || `field_${i + 1}`;
    return base;
  });
  const seenKeys = new Set<string>();
  for (let i = 0; i < fieldKeys.length; i++) {
    let key = fieldKeys[i];
    let n = 2;
    while (seenKeys.has(key)) {
      key = `${fieldKeys[i]}_${n++}`;
    }
    seenKeys.add(key);
    fieldKeys[i] = key;
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_DATA_ROWS) {
    return {
      ok: false,
      error: `Too many rows (${dataRows.length}). Maximum supported is ${MAX_DATA_ROWS}.`,
    };
  }

  const warnings: string[] = [];

  const templateOptions: string[] = [];
  const templateSeen = new Set<string>();

  // Map: `${parentLower}\u0001${columnIndex}` -> { draft, optionSet }
  const branchByKey = new Map<string, { draft: DraftOptionBranch; optionSet: Set<string> }>();
  let order = 0;
  let usedRows = 0;

  for (const cells of dataRows) {
    const parent = (cells[0] || "").trim();
    if (!parent) continue;
    usedRows++;

    if (!templateSeen.has(parent.toLowerCase())) {
      templateSeen.add(parent.toLowerCase());
      templateOptions.push(parent);
    }

    for (let c = 1; c < columns; c++) {
      const value = (cells[c] || "").trim();
      if (!value) continue;

      const key = `${parent.toLowerCase()}\u0001${c}`;
      let accum = branchByKey.get(key);
      if (!accum) {
        const localId = crypto.randomUUID();
        accum = {
          draft: {
            localId,
            dbId: null,
            parent_option_value: parent,
            parent_branch_local_id: null,
            field_key: fieldKeys[c - 1],
            name: dependentLabels[c - 1],
            field_type: "select",
            required: false,
            placeholder: "",
            help_text: "",
            options: [],
            display_order: order++,
          },
          optionSet: new Set<string>(),
        };
        branchByKey.set(key, accum);
      }
      if (!accum.optionSet.has(value.toLowerCase())) {
        accum.optionSet.add(value.toLowerCase());
        accum.draft.options.push(value);
      }
    }
  }

  if (templateOptions.length === 0) {
    return { ok: false, error: "No parent options were found in the first column." };
  }

  const branchDrafts = Array.from(branchByKey.values()).map((a) => a.draft);

  return {
    ok: true,
    result: {
      parentLabel: headers[0],
      dependentLabels,
      templateOptions,
      branchDrafts,
      stats: {
        dataRows: usedRows,
        dependentFields: dependentCount,
        parentOptions: templateOptions.length,
        branchRows: branchDrafts.length,
      },
      warnings,
    },
  };
}

/** Build a small sample CSV string for the given parent dropdown label. */
export function buildCascadingSampleCsv(parentLabel: string): string {
  const p = (parentLabel || "Project Unique ID").replace(/[\r\n,"]/g, "").trim() || "Project Unique ID";
  return [
    `${p},Project ID,Project Name`,
    "UID-001,P-101,Alpha Tower",
    "UID-001,P-102,Alpha Annex",
    "UID-002,P-201,Beta Plaza",
    "UID-003,P-301,Gamma House",
  ].join("\n");
}

/** A copy-paste prompt the admin can give to an AI to reshape their data into the import format. */
export function buildCascadingAiPrompt(parentLabel?: string): string {
  const parent = (parentLabel || "Project Unique ID").trim() || "Project Unique ID";
  return [
    "Convert my data into a CSV for a dependent-dropdown import. Rules:",
    "",
    "1) Output ONLY raw CSV text (no code fences, no commentary).",
    "2) The FIRST row is headers. The FIRST column is the parent dropdown; every",
    "   other column is a dependent dropdown that appears after the parent is chosen.",
    `3) Use these headers (rename to match my data if needed): "${parent}","Project ID","Project Name".`,
    "4) One row per valid combination. Repeat the parent value on each of its rows.",
    "5) For a given parent value, each dependent column lists the values that belong",
    "   to that parent; duplicates are fine (they are de-duplicated on import).",
    "6) Quote any value that contains a comma. Do not add empty columns.",
    "",
    "Example of the exact format:",
    `${parent},Project ID,Project Name`,
    "UID-001,P-101,Alpha Tower",
    "UID-001,P-102,Alpha Annex",
    "UID-002,P-201,Beta Plaza",
    "",
    "Here is my data (reshape it into the CSV above):",
    "<PASTE YOUR DATA HERE>",
  ].join("\n");
}
