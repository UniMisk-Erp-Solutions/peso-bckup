/**
 * DOC-108 follow-up — parsing for the bulk admin-submit-on-behalf-of-employee
 * import, now org-config-driven: recognizes an org's custom base-field labels
 * (not just the English defaults) plus dynamic `Field: <name>` / `Branch: ...`
 * columns produced by generateBulkExpenseExcelTemplate.ts for that same org's
 * category templates and conditional branch fields.
 *
 * Reuses the two spreadsheet readers this codebase already has, rather than
 * writing a third: `parseTabularText` (CSV/TSV, RFC4180-ish, quote and
 * embedded-newline aware) for text files, `readWorkbookFromArrayBuffer`
 * (dynamic `xlsx` import) for .xlsx/.xls. Both already return the same
 * `string[][]` shape.
 *
 * Validation and payload-building reuse the exact same primitives the live
 * "My Expenses" form uses (buildExpenseCustomFieldPayload), not a re-derived
 * copy of its rules — required-ness, option-value membership and branch
 * visibility here mean exactly what they mean there.
 */
import { parseTabularText } from "@/lib/formBuilder/dropdownBulkImport";
import { readWorkbookFromArrayBuffer, isExcelExtension } from "@/lib/formBuilder/dropdownBulkImportExcel";
import type { BaseExpenseFieldKey } from "@/lib/expenseFormConfig";
import type { OrganizationExpenseFieldConfig } from "@/lib/orgExpenseFieldConfig";
import { branchColumnHeader } from "@/lib/orgExpenseFieldConfig";
import { buildExpenseCustomFieldPayload, type ExpenseCustomFieldValuePayload } from "@/lib/expenseFormFieldPayload";

/** Hard ceiling protecting the browser (table rendering), not a backend limit. */
export const MAX_BULK_IMPORT_ROWS = 5000;
/** Rows per admin_bulk_submit_expenses_v1 call — server rejects above 250. */
export const BULK_SUBMIT_CHUNK_SIZE = 200;

const BASE_FIELDS = ["title", "destination", "expenseDate", "category", "amount", "purpose"] as const;
type BaseField = (typeof BASE_FIELDS)[number];

export interface BulkExpenseRow {
  rowIndex: number; // 1-based spreadsheet row, header excluded (row 1 = first data row)
  referenceName: string; // display-only, e.g. from the pre-filled template's "Employee Name" column — never validated or submitted
  employeeId: string;
  email: string;
  title: string;
  destination: string;
  /**
   * User-facing format is DD-MM-YYYY (India standard). Holds the raw typed
   * text until validated; validateBulkRows rewrites it to ISO (YYYY-MM-DD)
   * on success so downstream code (the RPC payload) always gets an
   * unambiguous string — Postgres's date parsing is DateStyle-dependent, so
   * a DD-MM-YYYY string sent as-is could silently be read as MM-DD-YYYY.
   */
  expenseDate: string;
  category: string;
  amount: string; // unparsed — validated in validateBulkRows
  purpose: string;
  /** Raw text entered in "Field: <template name>" columns, keyed by template id. */
  templateValues: Record<string, string>;
  /** Raw text entered in "Branch: ..." columns, keyed by the branch column group's key (see orgExpenseFieldConfig.ts). */
  branchGroupValues: Record<string, string>;
  /** Resolved, ready-to-send custom-field payload for this row — built during validateBulkRows once the row's category and parent-field values are known. Only meaningful when issues.length === 0. */
  customFieldPayload: ExpenseCustomFieldValuePayload[];
  issues: string[]; // client-side validation problems; empty = ready to submit
}

export interface BulkExpenseParseResult {
  rows: BulkExpenseRow[];
  unmappedHeaders: string[];
  missingColumns: string[];
}

/** Every plain string column this row shape can hold — base fields plus the three identity columns. */
type SimpleField = "referenceName" | "employeeId" | "email" | BaseField;

type ColumnTarget =
  | { kind: "simple"; field: SimpleField }
  | { kind: "template"; templateId: string }
  | { kind: "branch"; groupKey: string };

const STATIC_BASE_ALIASES: Record<string, BaseField> = {
  "title": "title",
  "expense title": "title",
  "destination": "destination",
  "vendor": "destination",
  "vendor / location": "destination",
  "location": "destination",
  "date": "expenseDate",
  "expense date": "expenseDate",
  "date (dd-mm-yyyy)": "expenseDate",
  "category": "category",
  "expense type": "category",
  "amount": "amount",
  "expense amount": "amount",
  "purpose": "purpose",
  "description": "purpose",
  "notes": "purpose",
};

const IDENTITY_ALIASES: Record<string, "referenceName" | "employeeId" | "email"> = {
  "employee name": "referenceName",
  "name": "referenceName",
  "employee id": "employeeId",
  "employee_id": "employeeId",
  "emp id": "employeeId",
  "emp_id": "employeeId",
  "employee code": "employeeId",
  "email": "email",
  "employee email": "email",
};

const BASE_FIELD_KEY_TO_FIELD: Record<BaseExpenseFieldKey, BaseField | null> = {
  title: "title",
  destination: "destination",
  expense_date: "expenseDate",
  category: "category",
  amount: "amount",
  purpose: "purpose",
};

/** DD-MM-YYYY — the India-standard format this import requires. */
const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

/**
 * Parses a strict DD-MM-YYYY string into an ISO YYYY-MM-DD string, or null if
 * the text doesn't match the format or isn't a real calendar date (e.g.
 * 31-02-2026). Round-trips through Date to catch JS's silent day/month
 * rollover (new Date(2026, 1, 31) quietly becomes March 3) rather than
 * trusting the regex alone.
 */
export function parseDDMMYYYYToIso(text: string): string | null {
  const m = DATE_RE.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Inverse of parseDDMMYYYYToIso — for pre-filling/round-tripping display values. */
export function formatIsoToDDMMYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strips trailing " (...)" annotation groups the generator appends (required
 *  markers, "for: cat1, cat2", "see Reference sheet") so header matching
 *  survives those notes changing shape without needing to reconstruct them
 *  exactly — matching is on the core "Field: <name>" / "Branch: ..." text.
 *
 *  Depth-tracked, not a naive regex: a "for: ..." annotation can itself
 *  contain parens when an org's own category names do — e.g. MicroLink has
 *  "Travelling (Public and Private Transport)" — so the trailing group to
 *  strip is often NESTED, not flat. A `[^()]*`-style regex can't match
 *  across that nesting and would silently fail to strip anything. */
function stripAnnotations(h: string): string {
  let s = h.trim();
  for (;;) {
    if (!s.endsWith(")")) break;
    let depth = 0;
    let i = s.length - 1;
    for (; i >= 0; i--) {
      if (s[i] === ")") depth++;
      else if (s[i] === "(") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i < 0 || depth !== 0) break; // unbalanced parens — don't strip, leave as-is
    s = s.slice(0, i).trim();
  }
  return s;
}

export function isSupportedBulkImportExtension(fileName: string): boolean {
  return /\.(csv|txt|xlsx|xls)$/i.test(fileName);
}

async function readRows(file: File): Promise<string[][]> {
  if (isExcelExtension(file.name)) {
    const buffer = await file.arrayBuffer();
    const workbook = await readWorkbookFromArrayBuffer(buffer);
    const firstSheet = workbook.sheetNames[0];
    return firstSheet ? workbook.getSheetRows(firstSheet) : [];
  }
  const text = await file.text();
  return parseTabularText(text);
}

/** Builds the header → column-target map for one org's field config (or the plain 9-column defaults when null). */
function buildColumnTargets(
  headerRow: string[],
  fieldConfig: OrganizationExpenseFieldConfig | null,
): (ColumnTarget | null)[] {
  const baseAliases: Record<string, BaseField> = { ...STATIC_BASE_ALIASES };
  if (fieldConfig) {
    for (const key of Object.keys(BASE_FIELD_KEY_TO_FIELD) as BaseExpenseFieldKey[]) {
      const field = BASE_FIELD_KEY_TO_FIELD[key];
      if (!field) continue;
      const label = fieldConfig.baseFieldConfig[key]?.label;
      if (label) baseAliases[normalizeHeader(label)] = field;
    }
  }

  const templateHeaderMap = new Map<string, string>(); // normalized "field: name" -> templateId
  if (fieldConfig) {
    const seen = new Map<string, string>();
    for (const a of fieldConfig.categoryAssignments) {
      const norm = normalizeHeader(`Field: ${a.template.name}`);
      if (!seen.has(norm)) {
        seen.set(norm, a.template.id);
        templateHeaderMap.set(norm, a.template.id);
      }
    }
  }

  const branchHeaderMap = new Map<string, string>(); // normalized header -> group key
  if (fieldConfig) {
    for (const group of fieldConfig.branchGroups) {
      // Disambiguated form always accepted; bare form only when unambiguous
      // for THIS group (matches what the generator would have produced, and
      // avoids resolving an ambiguous bare header to the wrong group).
      branchHeaderMap.set(normalizeHeader(branchColumnHeader(group)), group.key);
      if (!group.ambiguousName) {
        branchHeaderMap.set(normalizeHeader(`Branch: ${group.name}`), group.key);
      }
    }
  }

  return headerRow.map((raw): ColumnTarget | null => {
    const norm = normalizeHeader(raw);
    if (IDENTITY_ALIASES[norm]) return { kind: "simple", field: IDENTITY_ALIASES[norm] };
    if (baseAliases[norm]) return { kind: "simple", field: baseAliases[norm] };

    // The generator appends " (required)" / "(for: ...)" annotations to EVERY
    // header it writes, not just Field:/Branch: ones — strip them before
    // matching against base aliases too, or every roster-generated base
    // column (e.g. "Purpose / Title (required)") fails to map back.
    const stripped = normalizeHeader(stripAnnotations(raw));
    if (baseAliases[stripped]) return { kind: "simple", field: baseAliases[stripped] };
    if (templateHeaderMap.has(stripped)) return { kind: "template", templateId: templateHeaderMap.get(stripped)! };
    if (branchHeaderMap.has(stripped)) return { kind: "branch", groupKey: branchHeaderMap.get(stripped)! };
    return null;
  });
}

/**
 * Reads the file and maps columns by header — no validation of cell values
 * yet (that's `validateBulkRows`, run separately so the UI can show a
 * per-row issue list rather than a single all-or-nothing parse failure).
 *
 * `fieldConfig` is the org's custom-field configuration (see
 * fetchOrganizationExpenseFieldConfig) — pass null for an org with none
 * configured, which falls back to plain 9-column parsing.
 */
export async function parseBulkExpenseFile(
  file: File,
  fieldConfig: OrganizationExpenseFieldConfig | null = null,
): Promise<BulkExpenseParseResult> {
  const allRows = await readRows(file);
  if (allRows.length === 0) {
    return { rows: [], unmappedHeaders: [], missingColumns: ["employee_id or email", "title", "destination", "date", "category", "amount"] };
  }

  const [headerRow, ...dataRows] = allRows;
  const columnTargets = buildColumnTargets(headerRow, fieldConfig);
  const unmappedHeaders = headerRow.filter((_, i) => columnTargets[i] === null && headerRow[i].trim() !== "");

  const mappedSimpleFields = new Set(
    columnTargets.filter((t): t is Extract<ColumnTarget, { kind: "simple" }> => t?.kind === "simple").map((t) => t.field),
  );
  const missingColumns: string[] = [];
  if (!mappedSimpleFields.has("employeeId") && !mappedSimpleFields.has("email")) {
    missingColumns.push("Employee ID or Email");
  }
  for (const [field, label] of [
    ["title", "Title"], ["destination", "Destination"], ["expenseDate", "Date"],
    ["category", "Category"], ["amount", "Amount"],
  ] as const) {
    if (!mappedSimpleFields.has(field)) missingColumns.push(label);
  }

  const capped = dataRows.slice(0, MAX_BULK_IMPORT_ROWS);
  const rows: BulkExpenseRow[] = capped.map((cells, i) => {
    const row: BulkExpenseRow = {
      rowIndex: i + 1,
      referenceName: "", employeeId: "", email: "", title: "", destination: "",
      expenseDate: "", category: "", amount: "", purpose: "",
      templateValues: {}, branchGroupValues: {}, customFieldPayload: [],
      issues: [],
    };
    columnTargets.forEach((target, colIdx) => {
      const value = (cells[colIdx] ?? "").trim();
      if (!target) return;
      if (target.kind === "simple") row[target.field] = value;
      else if (target.kind === "template") row.templateValues[target.templateId] = value;
      else if (target.kind === "branch") row.branchGroupValues[target.groupKey] = value;
    });
    return row;
  });

  return { rows: validateBulkRows(rows, fieldConfig), unmappedHeaders, missingColumns };
}

/**
 * Row-level validation — mirrors what the server will reject, plus the same
 * category-template / conditional-branch rules the live "My Expenses" form
 * enforces, so problems surface before any RPC call. Also resolves and
 * attaches customFieldPayload for rows with no issues.
 */
export function validateBulkRows(
  rows: BulkExpenseRow[],
  fieldConfig: OrganizationExpenseFieldConfig | null = null,
): BulkExpenseRow[] {
  return rows.map((row) => {
    const issues: string[] = [];
    if (!row.employeeId && !row.email) issues.push("Missing Employee ID or Email");
    if (!row.title) issues.push("Missing Title");
    if (!row.destination) issues.push("Missing Destination");

    let expenseDate = row.expenseDate;
    if (!expenseDate) {
      issues.push("Missing Date");
    } else {
      const iso = parseDDMMYYYYToIso(expenseDate);
      if (!iso) {
        issues.push("Date must be DD-MM-YYYY, e.g. 24-08-2026");
      } else {
        expenseDate = iso; // normalized for the RPC payload; original stays visible only when invalid
      }
    }

    if (!row.category) issues.push("Missing Category");
    const amountNum = Number(row.amount);
    if (!row.amount) issues.push("Missing Amount");
    else if (!Number.isFinite(amountNum) || amountNum <= 0) issues.push("Amount must be a number greater than 0");

    let customFieldPayload: ExpenseCustomFieldValuePayload[] = [];
    if (fieldConfig && row.category) {
      const relevantTemplateValues: Record<string, string> = {};
      const relevantBranchValues: Record<string, string> = {};
      const visibleBranchIds = new Set<string>();

      const assignmentsForCategory = fieldConfig.categoryAssignments.filter(
        (a) => a.categoryName.trim().toLowerCase() === row.category.trim().toLowerCase(),
      );

      for (const a of assignmentsForCategory) {
        const template = a.template;
        const isRequired = a.requiredOverride !== null ? a.requiredOverride : template.required;
        const value = row.templateValues[template.id] || "";

        if (isRequired && !value.trim()) {
          issues.push(`${template.name} is required`);
        }
        if (value) {
          if (template.field_type === "number") {
            const n = parseFloat(value);
            if (isNaN(n)) issues.push(`${template.name} must be a valid number`);
            else if (template.validation_rules?.min !== undefined && n < template.validation_rules.min) issues.push(`${template.name} must be at least ${template.validation_rules.min}`);
            else if (template.validation_rules?.max !== undefined && n > template.validation_rules.max) issues.push(`${template.name} must be at most ${template.validation_rules.max}`);
          }
          if (template.field_type === "select" && template.options && !template.options.includes(value)) {
            issues.push(`${template.name} must be one of: ${template.options.join(", ")}`);
          }
          relevantTemplateValues[template.id] = value;
        }

        // Conditional branches under this template, visible only when this
        // row's own value for the parent field matches a configured option.
        for (const group of fieldConfig.branchGroups) {
          if (group.parentTemplateId !== template.id) continue;
          const parentValue = value;
          if (!parentValue) continue; // parent not chosen on this row — branch not visible, any stray value is dropped below
          const matched = group.rows.find((r) => r.parentOptionValue === parentValue);
          if (!matched) continue; // this parent value has no configured branch here — not visible

          const branchValue = row.branchGroupValues[group.key] || "";
          if (matched.required && !branchValue.trim()) {
            issues.push(`${group.name} is required (${template.name} = ${parentValue})`);
          }
          if (branchValue) {
            if (matched.options && matched.options.length > 0 && !matched.options.includes(branchValue)) {
              issues.push(`${group.name} must be one of: ${matched.options.join(", ")} (for ${template.name} = ${parentValue})`);
            } else if (matched.fieldType === "number") {
              if (isNaN(parseFloat(branchValue))) issues.push(`${group.name} must be a valid number`);
            }
            relevantBranchValues[matched.id] = branchValue;
            visibleBranchIds.add(matched.id);
          }
        }
      }

      customFieldPayload = buildExpenseCustomFieldPayload({
        templateValues: relevantTemplateValues,
        branchValues: relevantBranchValues,
        visibleBranchIds,
      });
    }

    return { ...row, expenseDate, issues, customFieldPayload };
  });
}
