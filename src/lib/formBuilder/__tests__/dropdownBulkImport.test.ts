import { describe, it, expect } from "vitest";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import {
  parseDelimitedText,
  sniffDelimiter,
  parseTabularText,
  detectImportFormat,
  extractFlatList,
  parseDependentTable,
  indexExistingDependentFields,
  matchHeaderToExistingField,
  mapDependentHeaders,
  dedupePreservingFirst,
  analyzeFlatImport,
  analyzeDependentImport,
  applyFlatImport,
  applyDependentImport,
  computeReplaceImpact,
} from "@/lib/formBuilder/dropdownBulkImport";

function makeDraft(overrides: Partial<DraftOptionBranch>): DraftOptionBranch {
  return {
    localId: crypto.randomUUID(),
    dbId: null,
    parent_option_value: "U1",
    parent_branch_local_id: null,
    field_key: "project_id",
    name: "Project ID",
    field_type: "select",
    required: false,
    placeholder: "",
    help_text: "",
    options: [],
    display_order: 0,
    ...overrides,
  };
}

// ─── parseDelimitedText ─────────────────────────────────────────────────────

describe("parseDelimitedText", () => {
  it("splits simple and quoted comma fields", () => {
    expect(parseDelimitedText("a,b,c", ",")).toEqual([["a", "b", "c"]]);
    expect(parseDelimitedText('a,"b,c",d', ",")).toEqual([["a", "b,c", "d"]]);
    expect(parseDelimitedText('a,"he said ""hi""",c', ",")).toEqual([["a", 'he said "hi"', "c"]]);
  });

  it("handles CRLF and LF, including mixed line endings", () => {
    expect(parseDelimitedText("a,b\r\nc,d\ne,f", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const bom = "﻿";
    expect(parseDelimitedText(`${bom}a,b\nc,d`, ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles a quoted cell containing an embedded newline", () => {
    const text = 'a,"line one\nline two",c\nd,e,f';
    expect(parseDelimitedText(text, ",")).toEqual([
      ["a", "line one\nline two", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("handles a quoted cell containing an embedded CRLF", () => {
    const text = 'a,"line one\r\nline two",c';
    expect(parseDelimitedText(text, ",")).toEqual([["a", "line one\r\nline two", "c"]]);
  });

  it("handles unicode content", () => {
    expect(parseDelimitedText("Ahmedabad,१२३,القاهرة", ",")).toEqual([
      ["Ahmedabad", "१२३", "القاهرة"],
    ]);
  });

  it("drops blank rows and trims cells", () => {
    expect(parseDelimitedText("a,b\n\n  ,  \nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles uneven row widths (short rows keep fewer cells)", () => {
    expect(parseDelimitedText("a,b,c\nd,e", ",")).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  it("parses tab-delimited text", () => {
    expect(parseDelimitedText("a\tb\tc", "\t")).toEqual([["a", "b", "c"]]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseDelimitedText("", ",")).toEqual([]);
  });

  it("handles a trailing row with no newline terminator", () => {
    expect(parseDelimitedText("a,b\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("sniffDelimiter / parseTabularText", () => {
  it("detects comma-delimited text", () => {
    expect(sniffDelimiter("a,b,c\nd,e,f")).toBe(",");
  });

  it("detects tab-delimited text (Excel/Sheets clipboard paste)", () => {
    expect(sniffDelimiter("a\tb\tc\nd\te\tf")).toBe("\t");
  });

  it("a single tab-separated line is a flat list, same as a single comma-separated line", () => {
    const rows = parseTabularText("Ahmedabad\tMumbai\tSurat\tDelhi");
    expect(detectImportFormat(rows)).toBe("flat");
    expect(extractFlatList(rows, false)).toEqual(["Ahmedabad", "Mumbai", "Surat", "Delhi"]);
  });

  it("parseTabularText auto-detects and parses", () => {
    expect(parseTabularText("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseTabularText("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

// ─── Format detection ───────────────────────────────────────────────────────

describe("detectImportFormat", () => {
  it("detects a single-column list as flat", () => {
    expect(detectImportFormat([["Ahmedabad"], ["Mumbai"]])).toBe("flat");
  });

  it("detects 2+ meaningful columns as dependent", () => {
    expect(detectImportFormat([["PID", "Name"], ["U1", "Alpha"]])).toBe("dependent");
  });

  it("ignores blank trailing columns when counting", () => {
    expect(detectImportFormat([["Ahmedabad", ""], ["Mumbai", ""]])).toBe("flat");
  });

  it("treats a single comma-separated line as flat, not a 1-row dependent table", () => {
    // "Ahmedabad,Mumbai,Surat,Delhi" -> one row, 4 columns -- there's no
    // second row to make column 2+ mean anything structurally, so this must
    // resolve to a flat list of 4 options, per the spec's own example.
    expect(detectImportFormat([["Ahmedabad", "Mumbai", "Surat", "Delhi"]])).toBe("flat");
  });

  it("still detects a real dependent table once a second row is present", () => {
    expect(detectImportFormat([["Parent", "A"], ["U1", "x"]])).toBe("dependent");
  });
});

// ─── Flat list extraction ───────────────────────────────────────────────────

describe("extractFlatList", () => {
  it("extracts values from column 0, no header", () => {
    expect(extractFlatList([["Ahmedabad"], ["Mumbai"]], false)).toEqual(["Ahmedabad", "Mumbai"]);
  });

  it("drops the first row when firstRowIsHeader is true", () => {
    expect(extractFlatList([["City"], ["Ahmedabad"], ["Mumbai"]], true)).toEqual(["Ahmedabad", "Mumbai"]);
  });

  it("skips blank cells", () => {
    expect(extractFlatList([["Ahmedabad"], [""], ["Mumbai"]], false)).toEqual(["Ahmedabad", "Mumbai"]);
  });

  it("flattens a single multi-column row into separate options", () => {
    expect(extractFlatList([["Ahmedabad", "Mumbai", "Surat", "Delhi"]], false)).toEqual([
      "Ahmedabad",
      "Mumbai",
      "Surat",
      "Delhi",
    ]);
  });
});

// ─── Dependent table parsing ────────────────────────────────────────────────

describe("parseDependentTable", () => {
  it("parses a well-formed dependent table", () => {
    const rows = [
      ["Project Unique ID", "Project ID", "Project Name"],
      ["UID-001", "P-101", "Alpha Tower"],
      ["UID-001", "P-102", "Alpha Annex"],
      ["UID-002", "P-201", "Beta Plaza"],
    ];
    const result = parseDependentTable(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.parentHeader).toBe("Project Unique ID");
    expect(result.table.dependentHeaders).toEqual(["Project ID", "Project Name"]);
    expect(result.table.dataRows).toHaveLength(3);
    expect(result.table.dataRows[0]).toEqual({ parent: "UID-001", values: ["P-101", "Alpha Tower"] });
  });

  it("rejects empty input", () => {
    expect(parseDependentTable([]).ok).toBe(false);
  });

  it("rejects a missing parent header", () => {
    const result = parseDependentTable([["", "B"], ["x", "y"]]);
    expect(result.ok).toBe(false);
  });

  it("rejects a missing dependent header", () => {
    const result = parseDependentTable([["Parent", ""], ["U1", "X"]]);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate headers", () => {
    const result = parseDependentTable([["Parent", "ID", "ID"], ["U1", "1", "2"]]);
    expect(result.ok).toBe(false);
  });

  it("rejects too many columns", () => {
    const header = ["Parent", ...Array.from({ length: 150 }, (_, i) => `Col${i}`)];
    const result = parseDependentTable([header, ["U1", ...Array(150).fill("x")]]);
    expect(result.ok).toBe(false);
  });

  it("rejects too many rows", () => {
    const header = ["Parent", "A"];
    const rows = [header, ...Array.from({ length: 5001 }, (_, i) => [`U${i}`, "x"])];
    const result = parseDependentTable(rows);
    expect(result.ok).toBe(false);
  });
});

// ─── Header matching ────────────────────────────────────────────────────────

describe("indexExistingDependentFields / matchHeaderToExistingField", () => {
  it("matches by exact field_key", () => {
    const drafts = [makeDraft({ field_key: "project_id", name: "Project ID" })];
    const index = indexExistingDependentFields(drafts);
    const mapping = matchHeaderToExistingField("project_id", index);
    expect(mapping.status).toBe("matched");
    expect(mapping.matchedFieldKey).toBe("project_id");
  });

  it("matches by normalized slug of the header vs an existing field_key", () => {
    const drafts = [makeDraft({ field_key: "project_id", name: "Project ID" })];
    const index = indexExistingDependentFields(drafts);
    const mapping = matchHeaderToExistingField("Project ID", index);
    expect(mapping.status).toBe("matched");
  });

  it("matches case-insensitively by existing name", () => {
    const drafts = [makeDraft({ field_key: "pid", name: "Project ID" })];
    const index = indexExistingDependentFields(drafts);
    expect(matchHeaderToExistingField("project id", index).status).toBe("matched");
    expect(matchHeaderToExistingField("PROJECT ID", index).status).toBe("matched");
  });

  it("does not treat unrelated headers like 'Project ID' / 'project id' / 'project_id' as unrelated fields", () => {
    const drafts = [makeDraft({ field_key: "project_id", name: "Project ID" })];
    const index = indexExistingDependentFields(drafts);
    const a = matchHeaderToExistingField("Project ID", index);
    const b = matchHeaderToExistingField("project id", index);
    const c = matchHeaderToExistingField("project_id", index);
    expect(a.matchedFieldKey).toBe(b.matchedFieldKey);
    expect(b.matchedFieldKey).toBe(c.matchedFieldKey);
  });

  it("reports new for a header with no existing counterpart", () => {
    const index = indexExistingDependentFields([]);
    const mapping = matchHeaderToExistingField("Owner", index);
    expect(mapping.status).toBe("new");
    expect(mapping.proposedFieldKey).toBe("owner");
  });

  it("reports ambiguous when a header could match two distinct existing fields", () => {
    const drafts = [
      // name slugifies to "project_id" -> collides with the OTHER draft's field_key.
      makeDraft({ field_key: "proj_id", name: "Project ID", parent_option_value: "U1" }),
      makeDraft({ field_key: "project_id", name: "Different Name", parent_option_value: "U2" }),
    ];
    const index = indexExistingDependentFields(drafts);
    const mapping = matchHeaderToExistingField("project_id", index);
    // "project_id" exact-matches the second draft's field_key AND slug-matches
    // the first draft's name -> two genuinely different fields -> ambiguous.
    expect(mapping.status).toBe("ambiguous");
    expect(mapping.candidates.sort()).toEqual(["proj_id", "project_id"]);
  });

  it("matches cleanly when only one rule fires and it points to a single field", () => {
    const drafts = [makeDraft({ field_key: "owner_name", name: "Owner Name" })];
    const index = indexExistingDependentFields(drafts);
    expect(matchHeaderToExistingField("owner_name", index).status).toBe("matched");
    expect(matchHeaderToExistingField("Owner Name", index).status).toBe("matched");
  });

  it("ignores nested (non-root) branches when indexing", () => {
    const root = makeDraft({ field_key: "root_key", name: "Root", parent_branch_local_id: null });
    const nested = makeDraft({ field_key: "nested_key", name: "Nested", parent_branch_local_id: root.localId });
    const index = indexExistingDependentFields([root, nested]);
    expect(index.has("nested_key")).toBe(false);
    expect(index.has("root_key")).toBe(true);
  });

  it("mapDependentHeaders maps every header in order", () => {
    const drafts = [makeDraft({ field_key: "project_id", name: "Project ID" })];
    const mappings = mapDependentHeaders(["Project ID", "Owner"], drafts);
    expect(mappings).toHaveLength(2);
    expect(mappings[0].status).toBe("matched");
    expect(mappings[1].status).toBe("new");
  });
});

// ─── Dedup ──────────────────────────────────────────────────────────────────

describe("dedupePreservingFirst", () => {
  it("dedupes case-insensitively and keeps the first spelling", () => {
    const { unique, duplicates } = dedupePreservingFirst(["Mumbai", "mumbai", " MUMBAI "]);
    expect(unique).toEqual(["Mumbai"]);
    expect(duplicates).toBe(2);
  });

  it("drops blanks without counting them as duplicates", () => {
    const { unique, duplicates } = dedupePreservingFirst(["Delhi", "", "  "]);
    expect(unique).toEqual(["Delhi"]);
    expect(duplicates).toBe(0);
  });
});

// ─── Flat import analysis + apply ──────────────────────────────────────────

describe("analyzeFlatImport / applyFlatImport", () => {
  it("analyzes a simple newline list", () => {
    const rows = parseTabularText("Ahmedabad\nMumbai\nSurat\nDelhi");
    const analysis = analyzeFlatImport(rows, false, []);
    expect(analysis.format).toBe("flat");
    expect(analysis.incomingValues).toEqual(["Ahmedabad", "Mumbai", "Surat", "Delhi"]);
    expect(analysis.parentOptions.new).toBe(4);
    expect(analysis.hasBlockingConflicts).toBe(false);
  });

  it("analyzes a comma list end-to-end (format detection -> extraction -> analysis)", () => {
    const rows = parseTabularText("Ahmedabad,Mumbai,Surat,Delhi");
    expect(detectImportFormat(rows)).toBe("flat");
    const analysis = analyzeFlatImport(rows, false, []);
    expect(analysis.incomingValues).toEqual(["Ahmedabad", "Mumbai", "Surat", "Delhi"]);
  });

  it("flags no usable rows as a blocking conflict", () => {
    const analysis = analyzeFlatImport([], false, []);
    expect(analysis.hasBlockingConflicts).toBe(true);
  });

  it("counts existing vs new against current options", () => {
    const rows = parseTabularText("Ahmedabad\nMumbai");
    const analysis = analyzeFlatImport(rows, false, ["ahmedabad"]);
    expect(analysis.parentOptions.existingMatched).toBe(1);
    expect(analysis.parentOptions.new).toBe(1);
  });

  it("applyFlatImport adds only genuinely new values, case-insensitively", () => {
    const result = applyFlatImport(["Ahmedabad"], ["ahmedabad", "Mumbai"]);
    expect(result.options).toEqual(["Ahmedabad", "Mumbai"]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

// ─── Dependent import analysis + apply (MERGE) ─────────────────────────────

const DEPENDENT_CSV = [
  "Project Unique ID,Project ID,Project Name",
  "UID-001,P-101,Alpha Tower",
  "UID-001,P-102,Alpha Annex",
  "UID-002,P-201,Beta Plaza",
].join("\n");

describe("analyzeDependentImport", () => {
  it("produces full stats for a fresh import (no existing data)", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const analysis = analyzeDependentImport(parsed.table, [], []);
    expect(analysis.parentOptions.new).toBe(2);
    expect(analysis.dependentFields.new).toBe(2);
    expect(analysis.dependentFields.matched).toBe(0);
    // 3 data rows x 2 dependent columns = 6 non-blank cell values, all new.
    expect(analysis.choices.new).toBe(6);
  });

  it("marks a header as matched when an existing field_key lines up", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const existingDrafts = [makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001", options: ["P-101"] })];
    const analysis = analyzeDependentImport(parsed.table, ["UID-001"], existingDrafts);
    expect(analysis.dependentFields.matched).toBe(1);
    expect(analysis.dependentFields.new).toBe(1);
    expect(analysis.parentOptions.existingMatched).toBe(1);
    expect(analysis.parentOptions.new).toBe(1);
    // P-101 already exists for UID-001+project_id -> counted as existing, not new
    expect(analysis.choices.existing).toBeGreaterThanOrEqual(1);
  });

  it("flags ambiguous headers as blocking", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const existingDrafts = [
      makeDraft({ field_key: "proj_id_a", name: "Project ID", parent_option_value: "X" }),
      makeDraft({ field_key: "project id", name: "Something Else", parent_option_value: "Y" }),
    ];
    const analysis = analyzeDependentImport(parsed.table, [], existingDrafts);
    // "Project ID" header: exact field_key match against "project id" AND
    // name-match against "proj_id_a" (name="Project ID") -> ambiguous.
    expect(analysis.dependentFields.ambiguous).toBeGreaterThanOrEqual(1);
    expect(analysis.hasBlockingConflicts).toBe(true);
  });

  it("blocks when two distinct headers both MATCH the same existing field (e.g. \"Project ID\" and \"project_id\")", () => {
    const rows = parseTabularText(
      ["Project Unique ID,Project ID,project_id", "UID-001,P-101,P-102"].join("\n"),
    );
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const existingDrafts = [
      makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001" }),
    ];
    const analysis = analyzeDependentImport(parsed.table, ["UID-001"], existingDrafts);

    // Without the fix, both headers silently resolve to matchedFieldKey
    // "project_id" and their values interleave into one field's choices with
    // no warning at all — this must block instead.
    expect(analysis.hasBlockingConflicts).toBe(true);
    expect(analysis.conflicts.some((c) => c.code === "duplicate_target_field")).toBe(true);
  });

  it("blocks when two distinct NEW headers slugify to the same proposed field_key (e.g. \"Project-ID\" and \"Project_ID\")", () => {
    // Distinct after plain .toLowerCase() (hyphen vs underscore, so the
    // earlier raw duplicate-header check does NOT catch this) but identical
    // after slugifyFieldKey's non-alphanumeric-run normalization.
    const rows = parseTabularText(
      ["Project Unique ID,Project-ID,Project_ID", "UID-001,P-101,P-102"].join("\n"),
    );
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    // No existing fields at all — both headers are "new", but both slugify to
    // the same "project_id" proposedFieldKey, so they'd still silently
    // collide under a shared brand-new field without this check.
    const analysis = analyzeDependentImport(parsed.table, [], []);

    expect(analysis.hasBlockingConflicts).toBe(true);
    expect(analysis.conflicts.some((c) => c.code === "duplicate_target_field")).toBe(true);
  });

  it("does NOT flag duplicate_target_field for genuinely distinct headers/fields (no false positive)", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const analysis = analyzeDependentImport(parsed.table, [], []);

    expect(analysis.conflicts.some((c) => c.code === "duplicate_target_field")).toBe(false);
    expect(analysis.hasBlockingConflicts).toBe(false);
  });
});

describe("applyDependentImport — MERGE", () => {
  it("creates fresh parent options and dependent fields when nothing existed", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, []);
    const result = applyDependentImport([], [], parsed.table, mappings, "merge");

    expect(result.options).toEqual(["UID-001", "UID-002"]);
    expect(result.summary.parentOptionsAdded).toBe(2);
    // fieldsCreated counts new DraftOptionBranch ROWS (2 parents x 2 columns),
    // not distinct field_keys — that distinct count is analysis.dependentFields.new.
    expect(result.summary.fieldsCreated).toBe(4);

    const u1Id = result.branchDrafts.find((b) => b.parent_option_value === "UID-001" && b.name === "Project ID");
    const u1Name = result.branchDrafts.find((b) => b.parent_option_value === "UID-001" && b.name === "Project Name");
    expect(u1Id?.options).toEqual(["P-101", "P-102"]);
    expect(u1Name?.options).toEqual(["Alpha Tower", "Alpha Annex"]);

    const u2Id = result.branchDrafts.find((b) => b.parent_option_value === "UID-002" && b.name === "Project ID");
    expect(u2Id?.field_key).toBe(u1Id?.field_key);
    expect(u2Id?.options).toEqual(["P-201"]);
  });

  it("preserves existing metadata on a matched field and only unions choices", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");

    const existingLocalId = crypto.randomUUID();
    const existingDbId = "db-existing-id";
    const existing: DraftOptionBranch[] = [
      makeDraft({
        localId: existingLocalId,
        dbId: existingDbId,
        field_key: "project_id",
        name: "Project ID",
        parent_option_value: "UID-001",
        required: true,
        placeholder: "Pick one",
        help_text: "Choose the project",
        options: ["P-101", "Existing Custom Value"],
        display_order: 7,
      }),
    ];
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, existing);
    const result = applyDependentImport(["UID-001"], existing, parsed.table, mappings, "merge");

    const updated = result.branchDrafts.find((b) => b.localId === existingLocalId)!;
    expect(updated.dbId).toBe(existingDbId);
    expect(updated.required).toBe(true);
    expect(updated.placeholder).toBe("Pick one");
    expect(updated.help_text).toBe("Choose the project");
    expect(updated.display_order).toBe(7);
    // union: existing custom value kept, new imported P-102 added, P-101 not duplicated
    expect(updated.options).toEqual(["P-101", "Existing Custom Value", "P-102"]);
  });

  it("preserves existing parent option casing instead of the imported casing", () => {
    const rows = parseTabularText("Parent,A\nuid-001,x");
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, []);
    const result = applyDependentImport(["UID-001"], [], parsed.table, mappings, "merge");
    expect(result.options).toEqual(["UID-001"]); // not "uid-001"
  });

  it("never touches nested descendant branches", () => {
    const root = makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001" });
    const nested = makeDraft({
      field_key: "sub_field",
      name: "Sub Field",
      parent_option_value: "P-101",
      parent_branch_local_id: root.localId,
    });
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, [root, nested]);
    const result = applyDependentImport(["UID-001"], [root, nested], parsed.table, mappings, "merge");
    const stillThere = result.branchDrafts.find((b) => b.localId === nested.localId);
    expect(stillThere).toBeDefined();
    expect(stillThere?.parent_branch_local_id).toBe(root.localId);
  });

  it("applies a new field's metadata consistently across parents even when only one parent already had it", () => {
    const existing = [
      makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001", field_type: "select", required: true }),
    ];
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, existing);
    const result = applyDependentImport(["UID-001"], existing, parsed.table, mappings, "merge");
    const u2Id = result.branchDrafts.find((b) => b.parent_option_value === "UID-002" && b.field_key === "project_id");
    expect(u2Id?.required).toBe(true); // cloned from the matched field's canonical metadata
  });
});

describe("applyDependentImport — REPLACE", () => {
  it("replaces choices only for imported (parent, field) pairs, dropping old choices", () => {
    const existing = [
      makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001", options: ["OLD-VALUE"] }),
    ];
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, existing);
    const result = applyDependentImport(["UID-001"], existing, parsed.table, mappings, "replace");
    const u1Id = result.branchDrafts.find((b) => b.parent_option_value === "UID-001" && b.field_key === "project_id");
    expect(u1Id?.options).toEqual(["P-101", "P-102"]);
    expect(u1Id?.options).not.toContain("OLD-VALUE");
  });

  it("leaves unrelated manually-configured fields on the same parent option untouched", () => {
    const unrelated = makeDraft({ field_key: "manual_field", name: "Manual Field", parent_option_value: "UID-001", options: ["keep-me"] });
    const existing = [unrelated];
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, existing);
    const result = applyDependentImport(["UID-001"], existing, parsed.table, mappings, "replace");
    const stillThere = result.branchDrafts.find((b) => b.localId === unrelated.localId);
    expect(stillThere).toBeDefined();
    expect(stillThere?.options).toEqual(["keep-me"]);
  });

  it("leaves parent options not present in the import completely untouched", () => {
    const other = makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UNRELATED-OPTION", options: ["keep-me"] });
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, [other]);
    const result = applyDependentImport(["UNRELATED-OPTION"], [other], parsed.table, mappings, "replace");
    const stillThere = result.branchDrafts.find((b) => b.localId === other.localId);
    expect(stillThere?.options).toEqual(["keep-me"]);
  });

  it("removes nested descendants of a replaced root and reports the removal count", () => {
    const root = makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001" });
    const nested = makeDraft({ field_key: "nested", name: "Nested", parent_option_value: "x", parent_branch_local_id: root.localId });
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, [root, nested]);
    const result = applyDependentImport(["UID-001"], [root, nested], parsed.table, mappings, "replace");
    expect(result.branchDrafts.find((b) => b.localId === nested.localId)).toBeUndefined();
    expect(result.summary.branchesRemoved).toBeGreaterThanOrEqual(2); // root + nested
  });

  it("does not shrink options[] — parent options absent from the import are kept", () => {
    const rows = parseTabularText("Parent,A\nUID-001,x");
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, []);
    const result = applyDependentImport(["UID-001", "SOME-OTHER-OPTION"], [], parsed.table, mappings, "replace");
    expect(result.options).toContain("SOME-OTHER-OPTION");
  });
});

describe("computeReplaceImpact", () => {
  it("reports which parent options and fields would be touched, plus removal counts", () => {
    const root = makeDraft({ field_key: "project_id", name: "Project ID", parent_option_value: "UID-001" });
    const nested = makeDraft({ field_key: "nested", name: "Nested", parent_option_value: "x", parent_branch_local_id: root.localId });
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, [root, nested]);
    const impact = computeReplaceImpact([root, nested], parsed.table, mappings);
    expect(impact.parentOptionsTouched).toEqual(["UID-001"]);
    expect(impact.fieldsTouched).toEqual(["Project ID"]);
    expect(impact.branchesRemoved).toBe(2);
    expect(impact.nestedBranchesRemoved).toBe(1);
  });

  it("reports zero impact when nothing in the draft overlaps the import scope", () => {
    const rows = parseTabularText(DEPENDENT_CSV);
    const parsed = parseDependentTable(rows);
    if (!parsed.ok) throw new Error("expected ok");
    const mappings = mapDependentHeaders(parsed.table.dependentHeaders, []);
    const impact = computeReplaceImpact([], parsed.table, mappings);
    expect(impact.parentOptionsTouched).toEqual([]);
    expect(impact.branchesRemoved).toBe(0);
  });
});
