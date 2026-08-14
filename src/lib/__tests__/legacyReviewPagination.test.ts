/**
 * Tests for legacy-mode "Load All" (DOC-074 follow-up).
 *
 * Reported failure: with the canonical RPCs absent (404), clicking
 * "Load all older expenses" did nothing. Cause: the handler branched only on
 * the canonical keyset `nextCursor`, which is always null in legacy mode, so it
 * returned immediately AND set allExpensesLoaded(true).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  loadLegacyReviewPages,
  initLegacyCursors,
  legacyCursorsComplete,
  fetchLegacyPage,
  HIERARCHY_LEGACY_SOURCES,
  MANAGER_LEGACY_SOURCES,
  LEGACY_PAGE_SIZE,
  LEGACY_INITIAL_ROWS,
  type LegacyReviewRow,
} from "../legacyReviewPagination";

const engineerReview = readFileSync(
  resolve(process.cwd(), "src/pages/EngineerReview.tsx"),
  "utf-8",
);

type Call = { source: string; from: number; to: number };

/** Supabase double that records the exact range of every rpc().range() call. */
function makeLegacySupabase(
  respond: (source: string, from: number, to: number) => { rows?: LegacyReviewRow[]; error?: string },
) {
  const calls: Call[] = [];
  const client = {
    rpc: (source: string) => ({
      range: (from: number, to: number) => {
        calls.push({ source, from, to });
        const r = respond(source, from, to);
        return Promise.resolve(
          r.error ? { data: null, error: { message: r.error } } : { data: r.rows ?? [], error: null },
        );
      },
    }),
  };
  return { client: client as never, calls };
}

const rows = (n: number, start = 0, tag = "x"): LegacyReviewRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}-${start + i}`, updated_at: "2026-07-30" }));

/** A source with `total` rows, served correctly for any requested range. */
const finiteSource = (total: number, tag = "x") =>
  (_s: string, from: number, to: number) => {
    const size = to - from + 1;
    const n = Math.max(0, Math.min(size, total - from));
    return { rows: rows(n, from, tag) };
  };

describe("legacy pagination — offsets and continuation", () => {
  it("3/8/9. resumes from the stored offset and never restarts at zero", async () => {
    const { client, calls } = makeLegacySupabase(finiteSource(1000));
    const resumed = [
      { source: "list_hierarchy_reviewer_expenses", nextOffset: 300, complete: false, error: null },
    ];
    await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: resumed,
      maxRows: 250,
    });
    expect(calls[0].from).toBe(300);
    expect(calls.every((c) => c.from !== 0)).toBe(true);
  });

  it("2/3. the initial load stops at 300 rows and records offset 300", async () => {
    const { client, calls } = makeLegacySupabase(finiteSource(5000));
    const res = await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
      maxRows: LEGACY_INITIAL_ROWS,
    });
    expect(res.rows).toHaveLength(300);
    expect(res.cursors[0].nextOffset).toBe(300);
    expect(res.complete).toBe(false); // 300 of 5000 is not complete
    // Page 1 = rows 0-249, page 2 = only the remaining 50 (250-299).
    expect(calls[0]).toMatchObject({ from: 0, to: LEGACY_PAGE_SIZE - 1 });
    expect(calls[1]).toMatchObject({ from: 250, to: 299 });
  });

  it("10/30/31. pages past the 1,000-row PostgREST cap for hierarchy reviewers", async () => {
    const { client } = makeLegacySupabase(finiteSource(6088));
    const res = await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
    });
    expect(res.rows).toHaveLength(6088);
    expect(res.complete).toBe(true);
  });

  it("12/13. a short page completes a source; a full page does not", async () => {
    const short = makeLegacySupabase(finiteSource(10));
    const a = await loadLegacyReviewPages(short.client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
    });
    expect(a.complete).toBe(true);

    const full = makeLegacySupabase(finiteSource(100000));
    const b = await loadLegacyReviewPages(full.client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
      maxPages: 2,
    });
    expect(b.complete).toBe(false);
  });

  it("11. deduplicates against rows already held and across pages", async () => {
    const { client } = makeLegacySupabase(() => ({ rows: rows(3, 0) }));
    const seen = new Set(["x-0"]);
    const res = await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
      seenIds: seen,
      pageSize: 3,
      maxPages: 2,
    });
    const ids = res.rows.map((r) => r.id);
    expect(ids).not.toContain("x-0");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("10. appends progressively via onPage", async () => {
    const { client } = makeLegacySupabase(finiteSource(600));
    const onPage = vi.fn();
    await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
      onPage,
    });
    expect(onPage.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onPage.mock.calls[0][0]).toHaveLength(LEGACY_PAGE_SIZE);
  });
});

describe("legacy pagination — failure and retry", () => {
  it("14/15. a later-page failure preserves rows and the failed offset", async () => {
    let hit = 0;
    const { client } = makeLegacySupabase((_s, from, to) => {
      hit++;
      if (hit === 2) return { error: "canceling statement due to statement timeout" };
      const size = to - from + 1;
      return { rows: rows(size, from) };
    });

    const res = await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
    });

    expect(res.rows).toHaveLength(LEGACY_PAGE_SIZE); // page 1 kept
    expect(res.error).toMatch(/timeout/i);
    expect(res.complete).toBe(false);
    // Offset NOT advanced past the failed page.
    expect(res.cursors[0].nextOffset).toBe(LEGACY_PAGE_SIZE);

    // Retry resumes from exactly that offset.
    const retry = makeLegacySupabase(finiteSource(400));
    await loadLegacyReviewPages(retry.client, {
      organizationId: "org",
      cursors: res.cursors,
    });
    expect(retry.calls[0].from).toBe(LEGACY_PAGE_SIZE);
  });

  it("12. an abort stops further requests and never claims completion", async () => {
    const controller = new AbortController();
    const { client, calls } = makeLegacySupabase((_s, from, to) => {
      controller.abort();
      return { rows: rows(to - from + 1, from) };
    });
    const res = await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
      signal: controller.signal,
    });
    expect(calls).toHaveLength(1);
    expect(res.aborted).toBe(true);
    expect(res.complete).toBe(false);
  });

  it("surfaces an RPC error rather than throwing", async () => {
    const { client } = makeLegacySupabase(() => ({ error: "boom" }));
    const r = await fetchLegacyPage(client, "list_hierarchy_reviewer_expenses", "org", 0, 10);
    expect(r.error).toBe("boom");
    expect(r.rows).toEqual([]);
  });
});

describe("legacy pagination — multi-source (manager)", () => {
  it("29. completion requires EVERY source to be exhausted", async () => {
    const cursors = initLegacyCursors(MANAGER_LEGACY_SOURCES);
    expect(cursors).toHaveLength(2);

    // Only the first source is done.
    const partial = [
      { ...cursors[0], complete: true },
      { ...cursors[1], complete: false },
    ];
    expect(legacyCursorsComplete(partial)).toBe(false);
    expect(legacyCursorsComplete(partial.map((c) => ({ ...c, complete: true })))).toBe(true);
  });

  it("29. pages each manager source independently, then completes", async () => {
    const totals: Record<string, number> = {
      list_manager_pending_expenses: 300,
      list_manager_reviewer_expenses: 120,
    };
    const { client, calls } = makeLegacySupabase((source, from, to) => {
      const size = to - from + 1;
      const n = Math.max(0, Math.min(size, (totals[source] ?? 0) - from));
      return { rows: rows(n, from, source) };
    });

    const res = await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(MANAGER_LEGACY_SOURCES),
    });

    expect(res.rows).toHaveLength(420);
    expect(res.complete).toBe(true);
    expect(res.cursors.every((c) => c.complete)).toBe(true);
    // Both sources were actually queried.
    expect(new Set(calls.map((c) => c.source)).size).toBe(2);
  });

  it("never issues an unbounded request", async () => {
    const { client, calls } = makeLegacySupabase(finiteSource(10));
    await loadLegacyReviewPages(client, {
      organizationId: "org",
      cursors: initLegacyCursors(HIERARCHY_LEGACY_SOURCES),
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.to - c.from + 1).toBeLessThanOrEqual(LEGACY_PAGE_SIZE);
    }
  });
});

/* ========================================================================== */
/* WIRING                                                                      */
/* ========================================================================== */

describe("EngineerReview — legacy Load All wiring", () => {
  it("1. a missing count RPC selects legacy mode explicitly", () => {
    expect(engineerReview).toContain(
      'setPaginationMode(countResult.missingFunction ? "legacy" : "canonical")',
    );
  });

  it("4/19. Load All branches on mode before ever consulting nextCursor", () => {
    const legacyBranch = engineerReview.indexOf('if (paginationMode === "legacy") {');
    expect(legacyBranch).toBeGreaterThan(-1);
    // The canonical cursor guard must sit AFTER the legacy branch, so a null
    // cursor in legacy mode can never short-circuit the handler.
    const cursorGuard = engineerReview.indexOf("Canonical cursor exhausted");
    expect(cursorGuard).toBeGreaterThan(legacyBranch);
    expect(engineerReview).toContain("await loadLegacyRemainingPages(controller.signal)");
  });

  it("9. legacy continuation resumes from stored cursors, not offset zero", () => {
    expect(engineerReview).toContain("cursors: startCursors, // ← resume, never offset 0");
  });

  it("16. the missing count RPC is probed once per session, not per page", () => {
    expect(engineerReview).toContain("readCanonicalCapability()");
    expect(engineerReview).toContain("writeCanonicalCapability(");
    expect(engineerReview).toContain('known === false');
  });

  it("18. canonical and legacy resume state are separate fields", () => {
    expect(engineerReview).toContain("const [legacyCursors, setLegacyCursors]");
    expect(engineerReview).toContain("const [nextCursor, setNextCursor]");
    expect(engineerReview).toContain("setNextCursor(null); // not applicable in legacy mode");
  });

  it("20/21. an unknown total renders N+ and never a fabricated N of N", () => {
    expect(engineerReview).toContain("`(${allExpenses.length}+ loaded)`");
    expect(engineerReview).toContain("`Loaded ${allExpenses.length}+ expenses`");
    expect(engineerReview).not.toContain("total: totalAvailable ?? allExpenses.length");
  });

  it("22/23. compatibility mode is explained, with no raw error surfaced", () => {
    expect(engineerReview).toContain("Using compatibility loading because the latest database");
    // The raw RPC error must stay in the console/state, never rendered as JSX.
    expect(engineerReview).not.toContain("{loadError}");
    expect(engineerReview).not.toContain("{countResult.error}");
    // Any mention of the status code lives in comments, not user-facing strings.
    const jsxMentions = engineerReview
      .split("\n")
      .filter((l) => l.includes("404") && !l.trimStart().startsWith("*") && !l.includes("//"));
    expect(jsxMentions).toEqual([]);
  });

  it("27/28. only a fully exhausted legacy load marks everything loaded", () => {
    expect(engineerReview).toContain(
      "const complete = legacy.complete && legacyCursorsComplete(legacy.cursors)",
    );
  });

  it("6. re-entry is guarded so a double click cannot double-append", () => {
    expect(engineerReview).toContain("if (loadingAllExpenses || allExpensesLoaded) return;");
  });
});
