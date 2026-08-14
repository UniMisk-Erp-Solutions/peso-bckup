import { describe, it, expect } from "vitest";
import {
  parseCascadingOptionsCsv,
  parseCsvLine,
  buildCascadingSampleCsv,
  buildCascadingAiPrompt,
} from "@/lib/cascadingOptionsCsv";

describe("parseCsvLine", () => {
  it("splits simple and quoted fields", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    expect(parseCsvLine('a,"he said ""hi""",c')).toEqual(["a", 'he said "hi"', "c"]);
  });
});

describe("parseCascadingOptionsCsv (dependent dropdowns)", () => {
  const csv = [
    "Project Unique ID,Project ID,Project Name",
    "U1,P-101,Alpha Tower",
    "U1,P-102,Alpha Annex",
    "U2,P-201,Beta Plaza",
  ].join("\n");

  it("builds parent options and TWO sibling dropdowns shown together", () => {
    const parsed = parseCascadingOptionsCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { templateOptions, branchDrafts, dependentLabels, stats } = parsed.result;

    expect(templateOptions).toEqual(["U1", "U2"]);
    expect(dependentLabels).toEqual(["Project ID", "Project Name"]);

    // All siblings are root branches (shown at the same time, depth 1).
    expect(branchDrafts.every((b) => b.parent_branch_local_id === null)).toBe(true);
    expect(branchDrafts.every((b) => b.field_type === "select")).toBe(true);

    // U1 -> Project ID [P-101, P-102] and Project Name [Alpha Tower, Alpha Annex]
    const u1Id = branchDrafts.find(
      (b) => b.parent_option_value === "U1" && b.name === "Project ID",
    );
    const u1Name = branchDrafts.find(
      (b) => b.parent_option_value === "U1" && b.name === "Project Name",
    );
    expect(u1Id?.options).toEqual(["P-101", "P-102"]);
    expect(u1Name?.options).toEqual(["Alpha Tower", "Alpha Annex"]);

    // both dependents share the same field_key across parents (distinct parent_option_value)
    const u2Id = branchDrafts.find(
      (b) => b.parent_option_value === "U2" && b.name === "Project ID",
    );
    expect(u2Id?.field_key).toBe(u1Id?.field_key);
    expect(u2Id?.options).toEqual(["P-201"]);

    expect(stats.parentOptions).toBe(2);
    expect(stats.dependentFields).toBe(2);
    // U1 has 2 dependents, U2 has 2 dependents => 4 branch rows
    expect(stats.branchRows).toBe(4);
  });

  it("dedupes parent options case-insensitively, preserves first spelling", () => {
    const c = "PID,Name\nU1,A\nu1,B";
    const parsed = parseCascadingOptionsCsv(c);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.templateOptions).toEqual(["U1"]);
    const b = parsed.result.branchDrafts.find((x) => x.name === "Name");
    expect(b?.options).toEqual(["A", "B"]);
  });

  it("requires at least two columns", () => {
    const parsed = parseCascadingOptionsCsv("OnlyOne\na\nb");
    expect(parsed.ok).toBe(false);
  });

  it("requires headers on dependent columns", () => {
    const parsed = parseCascadingOptionsCsv("Parent,\nU1,X");
    expect(parsed.ok).toBe(false);
  });

  it("skips empty parent rows and empty dependent cells", () => {
    const c = "PID,A,B\n,orphan,x\nU1,,only-b";
    const parsed = parseCascadingOptionsCsv(c);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.templateOptions).toEqual(["U1"]);
    // U1 has no A value, only B
    const a = parsed.result.branchDrafts.find(
      (x) => x.parent_option_value === "U1" && x.name === "A",
    );
    const b = parsed.result.branchDrafts.find(
      (x) => x.parent_option_value === "U1" && x.name === "B",
    );
    expect(a).toBeUndefined();
    expect(b?.options).toEqual(["only-b"]);
  });

  it("supports three dependent dropdowns", () => {
    const c = "PID,ID,Name,Owner\nU1,P1,Alpha,Sam\nU1,P2,Beta,Sam";
    const parsed = parseCascadingOptionsCsv(c);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.stats.dependentFields).toBe(3);
    const owner = parsed.result.branchDrafts.find((x) => x.name === "Owner");
    expect(owner?.options).toEqual(["Sam"]); // deduped
  });

  it("sample CSV parses cleanly and yields 2 dependents", () => {
    const parsed = parseCascadingOptionsCsv(buildCascadingSampleCsv("Project Unique ID"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.dependentLabels).toEqual(["Project ID", "Project Name"]);
  });

  it("AI prompt includes the parent label and example", () => {
    const prompt = buildCascadingAiPrompt("Project Unique ID");
    expect(prompt).toContain("Project Unique ID");
    expect(prompt).toContain("Project ID");
    expect(prompt).toContain("PASTE YOUR DATA HERE");
  });
});
