/**
 * Tests for the Reports.tsx `loading` free-identifier bug fix.
 *
 * Root cause: `loading` at line 2534 was an undeclared free identifier (no
 * useState / const declaration in scope). At runtime this throws
 * `ReferenceError: loading is not defined` when the Detailed tab renders
 * balance columns, crashing the entire /admin/reports page.
 *
 * Fix: replaced `loading` with `detailedQuery.isLoading` — the TanStack
 * Query loading flag already used throughout the same component
 * (see line 2398: loading={detailedQuery.isLoading}).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const src = readFileSync(resolve(cwd, "src/pages/Reports.tsx"), "utf-8");

describe("Reports.tsx — loading identifier fix", () => {
  it("does not contain a bare `!loading` reference outside of JSX prop assignments", () => {
    // The old crash site: `!loading &&` with no declared `loading` variable.
    // Every valid remaining reference is `loading={...}` (prop passing) or
    // `isLoading` (query field). A standalone `!loading` is the bug.
    const bareRef = /[^.{]!loading\b/.test(src);
    expect(bareRef).toBe(false);
  });

  it("uses detailedQuery.isLoading in the balance row guard", () => {
    expect(src).toContain("!detailedQuery.isLoading");
  });

  it("does not declare a [loading, setLoading] useState pair", () => {
    // There should be no `const [loading, setLoading]` pattern — the component
    // relies on TanStack Query's isLoading flag, not manual state.
    expect(src).not.toMatch(/const\s+\[loading\s*,\s*setLoading\]/);
  });

  it("detailedQuery is declared with useQuery", () => {
    expect(src).toContain("const detailedQuery = useQuery(");
  });

  it("passes detailedQuery.isLoading to the table component at the existing prop site", () => {
    expect(src).toContain("loading={detailedQuery.isLoading}");
  });
});
