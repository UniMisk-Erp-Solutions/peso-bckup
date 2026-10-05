/**
 * Covers the AMENDED 2026-08-27 addition to
 * supabase/migrations/20260827160000_daily_project_report_shared_core.sql
 * (the `ambiguity` CTE and `project_name_ambiguous` JSON key), ported from
 * Preet-Patel/feature/daily-report-data-recovery-and-render's
 * get_daily_report_project_name_ambiguity_v1 RPC but folded into the shared
 * core instead of shipped as a second, separately-callable function -- see
 * that migration's AMENDED note for why.
 *
 * There is no live database in this integration task (explicitly out of
 * scope -- no migration may be applied), so the SQL's own COUNT(DISTINCT...)
 * signal cannot be exercised directly. What CAN and must be verified here,
 * executed rather than merely reasoned about:
 *
 *   1. The render-time marker functions (resolveProjectIdCell /
 *      resolveProjectNameCell in dailyExpenseReportConfig.ts) -- REAL,
 *      imported code, not a mirror.
 *   2. isDailyReportRowNeedsReview still catches both markers, not just "".
 *   3. Foreground (finalizeDailyReportGroups, real, imported) vs. the
 *      worker's mirrored marker logic (ported byte-for-byte from
 *      run-report-export-job/index.ts, the same pattern
 *      dailyReportRemarksWorkerLogic.test.ts already established for
 *      Remarks) produce IDENTICAL output for every scenario below. This is
 *      the exact class of check that would have caught the Remarks
 *      foreground/worker drift bug before it shipped three times.
 *   4. RFC 4180 escaping of the marker strings themselves -- the ambiguous
 *      marker contains a literal comma ("Ambiguous - multiple names on
 *      record, unresolved") and must be quoted as a single CSV field.
 */
import { describe, expect, it } from "vitest";
import {
  DAILY_REPORT_AMBIGUOUS_NAME_MARKER,
  DAILY_REPORT_NO_DATA_MARKER,
  isDailyReportRowNeedsReview,
  resolveProjectIdCell,
  resolveProjectNameCell,
  type DailyProjectExpenseReportRow,
} from "@/lib/dailyExpenseReportConfig";
import {
  finalizeDailyReportGroups,
  type DailyReportGroup,
} from "@/lib/buildDailyProjectExpenseReport";

describe("resolveProjectIdCell / resolveProjectNameCell (real, imported)", () => {
  it("a real project id passes through untouched", () => {
    expect(resolveProjectIdCell("P-100")).toBe("P-100");
  });

  it("a blank/whitespace-only project id becomes the no-data marker", () => {
    expect(resolveProjectIdCell("")).toBe(DAILY_REPORT_NO_DATA_MARKER);
    expect(resolveProjectIdCell("   ")).toBe(DAILY_REPORT_NO_DATA_MARKER);
  });

  it("a real project name passes through untouched regardless of the ambiguous flag", () => {
    // A row with its OWN resolved name is never itself ambiguous, even if
    // sibling expenses under the same project id disagree.
    expect(resolveProjectNameCell("Highway Extension", false)).toBe("Highway Extension");
    expect(resolveProjectNameCell("Highway Extension", true)).toBe("Highway Extension");
  });

  it("a blank project name with no ambiguity signal becomes the no-data marker", () => {
    expect(resolveProjectNameCell("", false)).toBe(DAILY_REPORT_NO_DATA_MARKER);
    expect(resolveProjectNameCell("   ", false)).toBe(DAILY_REPORT_NO_DATA_MARKER);
  });

  it("a blank project name WITH the ambiguity signal becomes the ambiguous marker, not no-data", () => {
    expect(resolveProjectNameCell("", true)).toBe(DAILY_REPORT_AMBIGUOUS_NAME_MARKER);
  });
});

describe("isDailyReportRowNeedsReview catches markers, not just blank strings", () => {
  function row(projectId: string, projectName: string): DailyProjectExpenseReportRow {
    return { "project id": projectId, "project name": projectName } as DailyProjectExpenseReportRow;
  }

  it("a fully resolved row does not need review", () => {
    expect(isDailyReportRowNeedsReview(row("P1", "Alpha"))).toBe(false);
  });

  it("the no-data marker on project id still flags for review", () => {
    expect(isDailyReportRowNeedsReview(row(DAILY_REPORT_NO_DATA_MARKER, "Alpha"))).toBe(true);
  });

  it("the no-data marker on project name still flags for review", () => {
    expect(isDailyReportRowNeedsReview(row("P1", DAILY_REPORT_NO_DATA_MARKER))).toBe(true);
  });

  it("the ambiguous marker on project name still flags for review", () => {
    expect(isDailyReportRowNeedsReview(row("P1", DAILY_REPORT_AMBIGUOUS_NAME_MARKER))).toBe(true);
  });

  it("a raw blank string (pre-marker data, or a caller that never applied the marker) still flags for review", () => {
    expect(isDailyReportRowNeedsReview(row("", ""))).toBe(true);
  });
});

/**
 * Mirror of run-report-export-job/index.ts's `resolveProjectIdCell` /
 * `resolveProjectNameCell` (ported verbatim there from
 * dailyExpenseReportConfig.ts -- see that file's own comment). Byte-for-byte
 * identical: same trim, same marker strings, same precedence.
 */
function workerResolveProjectIdCell(projectId: string): string {
  const trimmed = String(projectId ?? "").trim();
  return trimmed || DAILY_REPORT_NO_DATA_MARKER;
}
function workerResolveProjectNameCell(projectName: string, isAmbiguous: boolean): string {
  const trimmed = String(projectName ?? "").trim();
  if (trimmed) return trimmed;
  return isAmbiguous ? DAILY_REPORT_AMBIGUOUS_NAME_MARKER : DAILY_REPORT_NO_DATA_MARKER;
}

describe("output parity: worker (mirrored) vs foreground finalizeDailyReportGroups for markers", () => {
  function group(overrides: Partial<DailyReportGroup> = {}): DailyReportGroup {
    return {
      trackDate: "10-05-2026",
      userId: "user-1",
      projectId: "P1",
      projectName: "Alpha",
      location: "Site A",
      voucherNo: "V1",
      employeeName: "Ravi",
      employeeCode: "EMP01",
      costs: {
        petrol_cost: 0, material_cost: 0, travelling_cost: 0, phone_exp: 0,
        hotel_exp: 0, transport_exp: 0, contra_bill: 0, other_exp: 0,
      },
      sourceExpenses: [],
      ...overrides,
    };
  }

  const CASES: Array<{
    name: string;
    projectId: string;
    projectName: string;
    projectNameAmbiguous: boolean;
  }> = [
    { name: "fully resolved row", projectId: "P1", projectName: "Alpha", projectNameAmbiguous: false },
    { name: "blank id, resolved name", projectId: "", projectName: "Alpha", projectNameAmbiguous: false },
    { name: "resolved id, blank unambiguous name -> N/A", projectId: "P1", projectName: "", projectNameAmbiguous: false },
    { name: "resolved id, blank ambiguous name -> Ambiguous", projectId: "P1", projectName: "", projectNameAmbiguous: true },
    { name: "both blank, not flagged ambiguous", projectId: "", projectName: "", projectNameAmbiguous: false },
    { name: "both blank, flagged ambiguous (id still N/A, name still Ambiguous)", projectId: "", projectName: "", projectNameAmbiguous: true },
    { name: "resolved name wins even when the row is (incorrectly) flagged ambiguous", projectId: "P1", projectName: "Alpha", projectNameAmbiguous: true },
  ];

  it.each(CASES)(
    "$name: foreground and worker-mirror render identical project id / project name cells",
    ({ projectId, projectName, projectNameAmbiguous }) => {
      const [foregroundResult] = finalizeDailyReportGroups([
        group({ projectId, projectName, projectNameAmbiguous }),
      ]);

      const workerRow = {
        "project id": workerResolveProjectIdCell(projectId),
        "project name": workerResolveProjectNameCell(projectName, projectNameAmbiguous),
      };

      expect(foregroundResult.row["project id"]).toBe(workerRow["project id"]);
      expect(foregroundResult.row["project name"]).toBe(workerRow["project name"]);
    },
  );

  it("the legacy all-client-side pipeline (no ambiguity signal available) renders a blank name as no-data, never ambiguous", () => {
    // DailyReportGroup.projectNameAmbiguous is optional; the legacy pipeline
    // (buildDailyProjectExpenseReportRows, which never touches the RPC) never
    // sets it, so it must default to "not ambiguous" rather than throwing or
    // silently claiming ambiguity it has no evidence for.
    const [result] = finalizeDailyReportGroups([group({ projectId: "P1", projectName: "" })]);
    expect(result.row["project name"]).toBe(DAILY_REPORT_NO_DATA_MARKER);
  });
});

describe("RFC 4180 escaping of the marker strings", () => {
  // Mirrors expenseReports.ts / index.ts's csvCell exactly.
  function csvCell(v: string | number): string {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  it("the ambiguous marker contains a literal comma and must be quoted as one field", () => {
    expect(DAILY_REPORT_AMBIGUOUS_NAME_MARKER).toContain(",");
    expect(csvCell(DAILY_REPORT_AMBIGUOUS_NAME_MARKER)).toBe(
      `"${DAILY_REPORT_AMBIGUOUS_NAME_MARKER}"`,
    );
  });

  it("the no-data marker contains no special characters and is not quoted", () => {
    expect(csvCell(DAILY_REPORT_NO_DATA_MARKER)).toBe(DAILY_REPORT_NO_DATA_MARKER);
  });

  it("a quoted ambiguous-marker cell round-trips back to the exact original string", () => {
    const cell = csvCell(DAILY_REPORT_AMBIGUOUS_NAME_MARKER);
    const unescaped = cell.slice(1, -1).replace(/""/g, '"');
    expect(unescaped).toBe(DAILY_REPORT_AMBIGUOUS_NAME_MARKER);
  });
});

/**
 * Mirror of the SQL `ambiguity` CTE's core signal:
 *   count(DISTINCT NULLIF(btrim(en.project_name_branch), '')) > 1
 * grouped by project_id, computed over every sibling expense sharing that
 * project id -- NOT the branch DEFINITION's option count (a different,
 * pre-existing signal: the `defn` fallback tier three lines above the CTE,
 * unrelated to this addition and untouched by it).
 */
function computeAmbiguousProjectIds(
  expenses: Array<{ projectId: string; submittedProjectName: string }>,
): Set<string> {
  const byProject = new Map<string, Set<string>>();
  for (const e of expenses) {
    const pid = e.projectId.trim();
    if (!pid) continue;
    const name = e.submittedProjectName.trim();
    if (!name) continue;
    if (!byProject.has(pid)) byProject.set(pid, new Set());
    byProject.get(pid)!.add(name);
  }
  const ambiguous = new Set<string>();
  for (const [pid, names] of byProject) {
    if (names.size > 1) ambiguous.add(pid);
  }
  return ambiguous;
}

describe("ambiguity signal (mirror of the SQL CTE's COUNT(DISTINCT ...) > 1 logic)", () => {
  it("a project id with a single real submitted name is not ambiguous", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "P1", submittedProjectName: "Alpha" },
      { projectId: "P1", submittedProjectName: "Alpha" },
    ]);
    expect(result.has("P1")).toBe(false);
  });

  it("a project id with two distinct real submitted names is ambiguous", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "P1", submittedProjectName: "Alpha" },
      { projectId: "P1", submittedProjectName: "Beta" },
    ]);
    expect(result.has("P1")).toBe(true);
  });

  it("blank submitted names never count toward the distinct-name tally", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "P1", submittedProjectName: "Alpha" },
      { projectId: "P1", submittedProjectName: "" },
      { projectId: "P1", submittedProjectName: "   " },
    ]);
    expect(result.has("P1")).toBe(false);
  });

  it("a project id with zero submitted names anywhere is not ambiguous -- it is 'no data', a different marker", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "P1", submittedProjectName: "" },
    ]);
    expect(result.has("P1")).toBe(false);
  });

  it("different project ids are scored independently", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "P1", submittedProjectName: "Alpha" },
      { projectId: "P1", submittedProjectName: "Beta" },
      { projectId: "P2", submittedProjectName: "Gamma" },
      { projectId: "P2", submittedProjectName: "Gamma" },
    ]);
    expect(result.has("P1")).toBe(true);
    expect(result.has("P2")).toBe(false);
  });

  it("a blank project id is never itself flagged ambiguous (it has no identity to group by)", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "", submittedProjectName: "Alpha" },
      { projectId: "", submittedProjectName: "Beta" },
    ]);
    expect(result.size).toBe(0);
  });

  it("three or more distinct names are still just 'ambiguous' -- no higher-severity tier", () => {
    const result = computeAmbiguousProjectIds([
      { projectId: "P1", submittedProjectName: "Alpha" },
      { projectId: "P1", submittedProjectName: "Beta" },
      { projectId: "P1", submittedProjectName: "Gamma" },
    ]);
    expect(result.has("P1")).toBe(true);
  });

  it("many organizations' data mixed together: ambiguity is scoped by project id only in this mirror, matching that the real SQL additionally scopes by organization_id via p_organization_id -- a project id string is not expected to collide across orgs in the real schema", () => {
    // Documents the scoping assumption rather than re-deriving org isolation,
    // which is already covered by the RPC's own p_organization_id filter on
    // `filtered`/`enriched` upstream of this CTE (every row already belongs
    // to exactly one organization before ambiguity is ever computed).
    const result = computeAmbiguousProjectIds([
      { projectId: "SHARED-ID", submittedProjectName: "Org A Name" },
      { projectId: "SHARED-ID", submittedProjectName: "Org B Name" },
    ]);
    expect(result.has("SHARED-ID")).toBe(true);
  });
});
