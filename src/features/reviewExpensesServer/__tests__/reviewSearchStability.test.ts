/**
 * Review search stability guards (incident: request storm / 504s / normal-vs-
 * filtered races). Source-level assertions that pin the lifecycle fixes so they
 * cannot silently regress (§3-§8, §14, §25, §26, §30).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/pages/EngineerReview.tsx"), "utf-8");
const filtered = readFileSync(resolve(process.cwd(), "src/lib/filteredReviewFetch.ts"), "utf-8");

describe("one current-query refresh dispatcher (§3/§4/§26)", () => {
  it("defines refreshCurrentReviewQuery routing by the current filter mode", () => {
    expect(src).toMatch(/const refreshCurrentReviewQuery = \(options\?: \{ background\?: boolean \}\)/);
    expect(src).toMatch(/if \(reviewFilterActiveRef\.current\) \{\s*return fetchFilteredExpensesRef\.current/);
  });

  it("the debounced background refresh routes through the dispatcher, not the normal fetch directly", () => {
    const idx = src.indexOf("const scheduleBackgroundRefetch");
    const body = src.slice(idx, idx + 320);
    expect(body).toMatch(/refreshCurrentReviewQueryRef\.current\(\{ background: true \}\)/);
    expect(body).not.toMatch(/fetchAssignedExpensesRef\.current\(\{ background: true \}\)/);
  });

  it("mutation completions no longer call the normal fetch directly", () => {
    // Every bare fetchAssignedExpenses() mutation-refresh was replaced. Only the
    // NORMAL-mode fetch effect may still call it (guarded by reviewFilterActive).
    const bare = src.match(/^\s*(await |void )?fetchAssignedExpenses\(\);/gm) ?? [];
    // Exactly one remaining bare call — the normal-mode fetch effect trigger.
    expect(bare.length).toBe(1);
  });
});

describe("no redundant enrichment for filtered rows (§14/§43 — the storm)", () => {
  it("both the identity effect and the optional-badge effect skip filtered mode", () => {
    const skips = src.match(/if \(reviewFilterActive\) return;/g) ?? [];
    // At least: identity effect + badge effect + normal-fetch gate.
    expect(skips.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Load All is a normal-only operation (§8)", () => {
  it("handleLoadAllExpenses returns early in filtered mode", () => {
    const idx = src.indexOf("const handleLoadAllExpenses");
    const body = src.slice(idx, idx + 400);
    expect(body).toMatch(/if \(reviewFilterActiveRef\.current\) return;/);
  });
  it("entering filtered mode aborts an in-flight Load All", () => {
    expect(src).toMatch(/if \(reviewFilterActive\) \{\s*loadAllAbortRef\.current\?\.abort\(\)/);
  });
});

describe("no double filtering in server-query mode (§15/§25/§32)", () => {
  it("applyFilters trusts the server in server-query mode and does not re-filter/re-sort", () => {
    // The server already applied employee/search/status/time/custom + sort over
    // the whole population, so applyFilters returns early in server-query mode
    // (only the client-side "Needs my verification" refinement, §41).
    const idx = src.indexOf("const applyFilters =");
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/if \(reviewFilterActive\) \{/);
    expect(body).toMatch(/isReadyForManagerReview/);
  });
});

describe("filtered download is bounded (§9/§32/§46)", () => {
  it("uses a small page cap so a broad search cannot download everything", () => {
    expect(filtered).toMatch(/FILTERED_MAX_PAGES = 3/);
  });
});

describe("chip count source of truth (§4/§5)", () => {
  it("passes the authoritative filtered count to the search bar, set from the queue result", () => {
    expect(src).toMatch(/selectedEmployeeCount=\{filteredResultCount\}/);
    expect(src).toMatch(/setFilteredResultCount\(result\.filteredTotal\)/);
    // A foreground filtered query clears the count (and any prior error) first so
    // no stale/false "0" — or stale error — shows while it reloads.
    expect(src).toMatch(/if \(!options\?\.background\) \{\s*\n\s*setFilteredResultCount\(null\);/);
  });
});

describe("instant return via the return cache (§9-§14)", () => {
  it("saves the list cache before leaving and paints it on return before the refresh", () => {
    expect(src).toMatch(/saveReviewReturnCache\(\{/);
    expect(src).toMatch(/loadReviewReturnCache\(organizationId, user\.id/);
    // Cached rows painted + loader cleared for an instant repaint.
    expect(src).toMatch(/setAllExpenses\(cachedRows\)/);
  });
});

describe("true request cancellation (§19-§21)", () => {
  it("wires an AbortSignal through the queue RPC layer", () => {
    const api = readFileSync(resolve(process.cwd(), "src/features/reviewQueueServer/api.ts"), "utf-8");
    expect(api).toMatch(/signal\?: AbortSignal/);
    expect(api).toMatch(/builder\.abortSignal\(signal\)/);
  });
  it("EngineerReview owns one core AbortController for both modes", () => {
    expect(src).toMatch(/coreRequestAbortRef/);
    expect(src).toMatch(/coreRequestAbortRef\.current\?\.abort\(\)/);
  });
});

describe("filtered KPI truthfulness (§23/§28)", () => {
  it("the Assigned card uses the server filtered total, not the 25 held rows", () => {
    // In server-query mode getStats returns filteredResultCount (server total),
    // falling back to the summary/loaded count only when it is unknown.
    expect(src).toMatch(
      /filteredResultCount != null\s*\?\s*filteredResultCount\s*:\s*summary\?\.assigned_to_me \?\? allExpenses\.length/,
    );
  });
});
