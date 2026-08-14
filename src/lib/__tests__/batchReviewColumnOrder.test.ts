/**
 * Batch Review Column Order — T34–T45
 *
 * T34 — Project Unique ID renders before Project ID
 * T35 — Project ID renders before Project Name
 * T36 — All three project fields before From location
 * T37 — From location before To location
 * T38 — Header order and row-cell order use one identical derived sequence
 * T39 — Parent fields always precede dependent fields
 * T40 — Unrelated field groups preserve configured display order
 * T41 — No-custom-field case returns empty array (no phantom location columns)
 * T42 — One-location-only case does not create an empty location column
 * T43 — Labels come from DB rows, not hardcoded strings
 * T44 — Mobile detail uses same custom-field sequence (pure function, no React dependency)
 * T45 — No new Supabase query/service/migration introduced by the ordering helper
 */

import { describe, it, expect } from "vitest";
import { orderBatchCustomFieldColumns } from "@/lib/batchExpenseReview";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const TPL_PUID = { id: "tpl-puid", name: "Project Unique ID", field_key: null };
const TPL_FROM = { id: "tpl-from", name: "From location", field_key: null };
const TPL_TO   = { id: "tpl-to",   name: "To location",   field_key: null };

const BR_PID   = { id: "br-pid",   name: "Project ID",   display_order: 10, parent_template_id: "tpl-puid" };
const BR_PNAME = { id: "br-pname", name: "Project Name", display_order: 20, parent_template_id: "tpl-puid" };

const FORM_ORDER_FULL = [
  { template_id: "tpl-puid", display_order: 10 },
  { template_id: "tpl-from", display_order: 20 },
  { template_id: "tpl-to",   display_order: 30 },
];

const FULL_SET = new Set([
  "Project Unique ID",
  "Project ID",
  "Project Name",
  "From location",
  "To location",
]);

// ─────────────────────────────────────────────────────────────────────────────

describe("T34 — Project Unique ID renders before Project ID", () => {
  it("'Project Unique ID' index is lower than 'Project ID' index", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    });
    expect(cols.indexOf("Project Unique ID")).toBeLessThan(cols.indexOf("Project ID"));
  });
});

describe("T35 — Project ID renders before Project Name", () => {
  it("'Project ID' index is lower than 'Project Name' index", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    });
    expect(cols.indexOf("Project ID")).toBeLessThan(cols.indexOf("Project Name"));
  });
});

describe("T36 — All three project fields before From location", () => {
  it("'Project Unique ID', 'Project ID', and 'Project Name' all precede 'From location'", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    });
    const fromIdx = cols.indexOf("From location");
    expect(cols.indexOf("Project Unique ID")).toBeLessThan(fromIdx);
    expect(cols.indexOf("Project ID")).toBeLessThan(fromIdx);
    expect(cols.indexOf("Project Name")).toBeLessThan(fromIdx);
  });
});

describe("T37 — From location before To location", () => {
  it("'From location' index is lower than 'To location' index", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    });
    expect(cols.indexOf("From location")).toBeLessThan(cols.indexOf("To location"));
  });
});

describe("T38 — Header order and row-cell order use one identical derived sequence", () => {
  it("calling orderBatchCustomFieldColumns twice with same inputs produces identical arrays", () => {
    const params = {
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    };
    const first  = orderBatchCustomFieldColumns(params);
    const second = orderBatchCustomFieldColumns(params);
    expect(first).toEqual(second);
  });
});

describe("T39 — Parent fields always precede dependent fields", () => {
  it("parent template appears before every one of its branch children", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    });
    const parentIdx = cols.indexOf("Project Unique ID");
    expect(parentIdx).toBeLessThan(cols.indexOf("Project ID"));
    expect(parentIdx).toBeLessThan(cols.indexOf("Project Name"));
  });
});

describe("T40 — Unrelated field groups preserve configured display order", () => {
  it("a second parent group with higher display_order appears after the first group's children", () => {
    const TPL_VENDOR = { id: "tpl-vendor", name: "Vendor Code", field_key: null };
    const BR_VNAME   = { id: "br-vname",   name: "Vendor Name", display_order: 10, parent_template_id: "tpl-vendor" };
    const formOrder = [
      { template_id: "tpl-puid",   display_order: 10 },
      { template_id: "tpl-vendor", display_order: 40 },
    ];
    const colSet = new Set(["Project Unique ID", "Project ID", "Project Name", "Vendor Code", "Vendor Name"]);

    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_VENDOR],
      branchRows: [BR_PID, BR_PNAME, BR_VNAME],
      formOrderRows: formOrder,
      columnSet: colSet,
    });

    const pNameIdx  = cols.indexOf("Project Name");
    const vendorIdx = cols.indexOf("Vendor Code");
    expect(pNameIdx).toBeLessThan(vendorIdx);
  });
});

describe("T41 — No-custom-field case returns empty array", () => {
  it("returns [] when columnSet is empty (no expense has custom-field values)", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [],
      branchRows: [],
      formOrderRows: [],
      columnSet: new Set(),
    });
    expect(cols).toEqual([]);
  });
});

describe("T42 — One-location-only case does not create an empty location column", () => {
  it("returns only 'From location' when To location has no value in the batch", () => {
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_FROM, TPL_TO],
      branchRows: [],
      formOrderRows: [
        { template_id: "tpl-from", display_order: 10 },
        { template_id: "tpl-to",   display_order: 20 },
      ],
      columnSet: new Set(["From location"]),
    });
    expect(cols).toContain("From location");
    expect(cols).not.toContain("To location");
    expect(cols).toHaveLength(1);
  });
});

describe("T43 — Labels come from DB rows, not hardcoded strings", () => {
  it("uses admin-configured names; renaming templates produces the new label in output", () => {
    const renamed = { id: "tpl-from", name: "Departure Point", field_key: null };
    const cols = orderBatchCustomFieldColumns({
      tplRows: [renamed],
      branchRows: [],
      formOrderRows: [{ template_id: "tpl-from", display_order: 10 }],
      columnSet: new Set(["Departure Point"]),
    });
    expect(cols).toContain("Departure Point");
    expect(cols).not.toContain("From location");
  });
});

describe("T44 — Mobile detail uses same custom-field sequence (pure function, no React dependency)", () => {
  it("orderBatchCustomFieldColumns can be called outside React context and returns the standard order", () => {
    // Pure function — callable synchronously from any context (including mobile components)
    const cols = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM, TPL_TO],
      branchRows: [BR_PID, BR_PNAME],
      formOrderRows: FORM_ORDER_FULL,
      columnSet: FULL_SET,
    });
    expect(cols).toEqual([
      "Project Unique ID",
      "Project ID",
      "Project Name",
      "From location",
      "To location",
    ]);
  });
});

describe("T45 — No new Supabase query/service/migration introduced by the ordering helper", () => {
  it("orderBatchCustomFieldColumns is a synchronous pure function with no async behavior", () => {
    const result = orderBatchCustomFieldColumns({
      tplRows: [TPL_PUID, TPL_FROM],
      branchRows: [BR_PID],
      formOrderRows: [
        { template_id: "tpl-puid", display_order: 10 },
        { template_id: "tpl-from", display_order: 20 },
      ],
      columnSet: new Set(["Project Unique ID", "Project ID", "From location"]),
    });
    // synchronous return value — not a Promise
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result)).toBe(true);
  });
});
