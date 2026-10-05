/**
 * Tests for the Reports.tsx `loading` free-identifier bug fix.
 *
 * Root cause: `loading` was an undeclared free identifier (no useState /
 * const declaration in scope). At runtime this threw `ReferenceError:
 * loading is not defined` when the Detailed tab rendered balance columns,
 * crashing the entire /admin/reports page.
 *
 * Fix (original): replaced `loading` with `detailedQuery.isLoading` — the
 * TanStack Query loading flag already used throughout the same component.
 *
 * SERVER-SIDE REPORT GENERATION INTEGRATION: Detailed Expense generation
 * moved server-side (report_export_jobs + worker) because the client-side
 * path this guard protected had no row cap at all -- an undisclosed,
 * documented silent-truncation bug on any organization with more approved
 * expenses than this deployment's PostgREST row limit. The balance-column
 * preview table `detailedQuery` fed (and the `!detailedQuery.isLoading`
 * guard around it) is gone along with that unbounded fetch; `detailedQuery`
 * itself is still declared (its queryFn/derived memos are left intact) but
 * is now permanently `enabled: false`. The two assertions this removed are
 * therefore no longer meaningful and have been replaced below -- the
 * negative "no bare !loading identifier" guard, the real regression this
 * file exists to catch, still applies and still passes.
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

  it("does not declare a [loading, setLoading] useState pair", () => {
    // There should be no `const [loading, setLoading]` pattern — the component
    // relies on TanStack Query's isLoading flag, not manual state.
    expect(src).not.toMatch(/const\s+\[loading\s*,\s*setLoading\]/);
  });

  it("detailedQuery is declared with useQuery, permanently disabled now that generation is server-side", () => {
    expect(src).toContain("const detailedQuery = useQuery(");
    const declStart = src.indexOf("const detailedQuery = useQuery(");
    const declEnd = src.indexOf("});", declStart);
    expect(src.slice(declStart, declEnd)).toContain("enabled: false");
  });

  it("Detailed Expense generation goes through the server-side export panel, not a client-rendered balance table", () => {
    const detailedTabStart = src.indexOf('<TabsContent value="detailed"');
    const detailedTabEnd = src.indexOf("</TabsContent>", detailedTabStart);
    const detailedTab = src.slice(detailedTabStart, detailedTabEnd);
    expect(detailedTab).toContain('reportType="detailed_expense"');
    expect(detailedTab).not.toContain("loading={detailedQuery.isLoading}");
  });
});
