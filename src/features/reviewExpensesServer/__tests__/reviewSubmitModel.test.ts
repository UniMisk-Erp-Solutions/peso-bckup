/**
 * EngineerReview submit-driven query model wiring (DOC-080 rev 20, §6-§55).
 *
 * Source-level guards so the draft/applied split, the broadened server-query
 * mode, the true page-at-a-time pagination and the KPI/enrichment/version
 * changes cannot silently regress. The pure query/pagination LOGIC is covered
 * behaviourally in src/lib/__tests__/reviewAppliedQuery.test.ts and
 * reviewServerPagination.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/pages/EngineerReview.tsx"), "utf-8");

describe("draft vs applied query state (§6-§8)", () => {
  it("declares draft twins for every staged control", () => {
    for (const name of [
      "draftStatus",
      "draftSortBy",
      "draftSortOrder",
      "draftTimePeriod",
      "draftShowOnlyActionable",
      "draftIncludeTeamLeaderReports",
      "draftIncludeExecutiveReports",
      "draftCustomFieldFilters",
    ]) {
      expect(src).toMatch(new RegExp(`const \\[${name},`));
    }
  });

  it("controls write to DRAFT, never applied, so editing them issues no request (§31/§32)", () => {
    expect(src).toMatch(/value=\{draftStatus\} onValueChange=\{setDraftStatus\}/);
    expect(src).toMatch(/value=\{draftSortBy\} onValueChange=\{setDraftSortBy\}/);
    expect(src).toMatch(/value=\{draftTimePeriod\} onValueChange=\{setDraftTimePeriod\}/);
    expect(src).toMatch(/setDraftSortOrder\(draftSortOrder === "asc"/);
    expect(src).toMatch(/checked=\{draftShowOnlyActionable\}/);
    expect(src).toMatch(/values=\{draftCustomFieldFilters\}/);
    expect(src).toMatch(/onChange=\{setDraftCustomFieldFilters\}/);
  });

  it("the server-query fetch effect keys off the APPLIED query, not draft state", () => {
    // Effect deps are the applied key + revision — draft edits are absent, so a
    // draft change can never trigger a fetch (§30/§31).
    const idx = src.indexOf("SERVER-QUERY mode fetch");
    const block = src.slice(idx, idx + 900);
    expect(block).toMatch(/appliedQueryKey/);
    expect(block).toMatch(/appliedRevision/);
    expect(block).not.toMatch(/draftStatus|draftSortBy|draftTimePeriod|draftCustomFieldFilters/);
  });
});

describe("Search submit coordinator (§8/§9/§29/§47)", () => {
  it("Search/Enter route through the single coordinator", () => {
    expect(src).toMatch(/onSubmit=\{handleSubmitReviewQuery\}/);
  });

  it("an unchanged, already-resolved search commits filters WITHOUT re-hitting the employee RPC (§47)", () => {
    const idx = src.indexOf("const handleSubmitReviewQuery");
    const body = src.slice(idx, idx + 700);
    expect(body).toMatch(/draftText === appliedText && hasResolvedSearch/);
    expect(body).toMatch(/commitDraftFilters\(\);/);
    // Only the changed-search branch delegates to the employee resolution.
    expect(body).toMatch(/pendingSubmitCommitRef\.current = true;\s*\n\s*void singleBar\.submit\(\)/);
  });

  it("commit is atomic: one revision bump + page reset + selection clear (§8/§29)", () => {
    const idx = src.indexOf("const commitDraftFilters = () =>");
    const body = src.slice(idx, idx + 700);
    expect(body).toMatch(/setStatusFilter\(draftStatus\)/);
    expect(body).toMatch(/setCustomFieldFilters\(draftCustomFieldFilters\)/);
    expect(body).toMatch(/setServerPage\(1\)/);
    expect(body).toMatch(/setSelectedKeys\(new Set\(\)\)/);
    expect(body).toMatch(/setAppliedRevision\(\(r\) => r \+ 1\)/);
  });
});

describe("server parameter mapping + true pagination (§16-§27)", () => {
  it("buildServerQueryParams maps status / sort / time / custom server-side", () => {
    const idx = src.indexOf("const buildServerQueryParams");
    const body = src.slice(idx, idx + 700);
    expect(body).toMatch(/statusToServerStatuses\(applied\.status\)/);
    expect(body).toMatch(/appliedSortToServerSort\(applied\.sortBy, applied\.sortOrder\)/);
    expect(body).toMatch(/deriveDateRange\(applied\.timePeriod/);
    expect(body).toMatch(/customFilterRecordToServer\(/);
  });

  it("pages one at a time (cursor history / anchor), never the old 300-row walk", () => {
    expect(src).not.toMatch(/fetchFilteredReviewExpenses/);
    expect(src).toMatch(/fetchServerQueryPage\(params, \{/);
    expect(src).toMatch(/fetchServerQueryPageByNumber\(params, \{/);
    expect(src).toMatch(/recordCursor\(history, page/);
    expect(src).toMatch(/const goServerPage = \(targetPage: number\)/);
  });

  it("pagination controls drive server pages in server-query mode", () => {
    expect(src).toMatch(/if \(reviewFilterActive\) goServerPage\(safeCurrentPage - 1\)/);
    expect(src).toMatch(/if \(reviewFilterActive\) goServerPage\(safeCurrentPage \+ 1\)/);
    expect(src).toMatch(/if \(reviewFilterActive\) goServerPage\(page as number\)/);
  });
});

describe("no enrichment storm + KPI honesty (§20/§28/§44)", () => {
  it("identity + optional-badge enrichment skip for ALL server-query rows (broadened guard)", () => {
    // Both effects early-return on the broadened reviewFilterActive.
    const guards = src.match(/if \(reviewFilterActive\) return;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it("KPI cards use the server filtered_summary in server-query mode, not the 25 held rows (§28)", () => {
    const idx = src.indexOf("const getStats");
    const body = src.slice(idx, idx + 1600);
    expect(body).toMatch(/serverFilteredSummary/);
    expect(body).toMatch(/summary\.pending_review/);
    expect(body).toMatch(/summary\.total_amount/);
  });
});

describe("server-query robustness — no stuck 'counting…' (§27/§28)", () => {
  it("bounds the server-query request with a timeout that surfaces as an error", () => {
    expect(src).toMatch(/SERVER_QUERY_TIMEOUT_MS/);
    expect(src).toMatch(/let timedOut = false/);
    expect(src).toMatch(/timedOut = true;/);
    // A genuine supersession/unmount abort stays silent, but a timeout is shown.
    expect(src).toMatch(/if \(isStale\(\) \|\| \(aborted && !timedOut\)\) return;/);
    expect(src).toMatch(/setServerQueryError\(message\)/);
  });

  it("the search chip reflects the error state instead of counting forever", () => {
    expect(src).toMatch(/countError=\{Boolean\(serverQueryError\)\}/);
  });
});

describe("query key + cache versions (§37)", () => {
  it("the return-cache / workspace key is the applied-query key (custom filters included)", () => {
    expect(src).toMatch(/const currentReviewQueryKey = \(\): string => buildAppliedQueryKey\(appliedQuery\)/);
  });
});
