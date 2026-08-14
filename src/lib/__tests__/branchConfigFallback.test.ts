/**
 * Tests for the retired_at graceful fallback in loadDraftBranchesForTemplate.
 *
 * BCF-1  Primary query succeeds (retired_at column exists) → data returned, no fallback
 * BCF-2  Primary query fails with PostgREST 400 → fallback runs without retired_at filter
 * BCF-3  Both primary and fallback fail → returns []
 * BCF-4  Fallback data is correctly mapped (dbId, field_key, parent resolution)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadDraftBranchesForTemplate } from "@/lib/optionBranchPersistence";

// Per-call response sequence — reset before each test
let callIndex = 0;
let responseSequence: Array<{ data: unknown; error: unknown }> = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(_table: string) {
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      chain.select = passthrough;
      chain.eq     = passthrough;
      chain.is     = passthrough;
      chain.order  = passthrough;
      chain.then   = (
        resolve: (v: unknown) => unknown,
        reject?: (v: unknown) => unknown,
      ) => {
        const response = responseSequence[callIndex] ?? { data: [], error: null };
        callIndex++;
        return Promise.resolve(response).then(resolve, reject);
      };
      return chain;
    },
    rpc: vi.fn(),
  },
}));

beforeEach(() => {
  callIndex = 0;
  responseSequence = [];
});

// ── BCF-1 ──────────────────────────────────────────────────────────────────────

describe("BCF-1 — primary query succeeds, no fallback needed", () => {
  it("returns mapped drafts when retired_at column exists", async () => {
    responseSequence = [
      {
        data: [
          {
            id: "db-1",
            parent_option_value: "OPT1",
            parent_branch_id: null,
            field_key: "project_code",
            name: "Project Code",
            field_type: "text",
            required: false,
            placeholder: null,
            help_text: null,
            options: null,
            display_order: 0,
            retired_at: null,
          },
        ],
        error: null,
      },
    ];

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].dbId).toBe("db-1");
    expect(drafts[0].field_key).toBe("project_code");
    // Only one DB call should have been made (no fallback)
    expect(callIndex).toBe(1);
  });
});

// ── BCF-2 ──────────────────────────────────────────────────────────────────────

describe("BCF-2 — primary fails with 400, fallback runs without retired_at", () => {
  it("falls back to the unfiltered query and returns data", async () => {
    responseSequence = [
      // Primary: PostgREST 400 — column does not exist
      { data: null, error: { message: 'column "retired_at" does not exist', code: "42703" } },
      // Fallback: succeeds
      {
        data: [
          {
            id: "db-fallback-1",
            parent_option_value: "OPT2",
            parent_branch_id: null,
            field_key: "department",
            name: "Department",
            field_type: "select",
            required: true,
            placeholder: "Select department",
            help_text: null,
            options: ["Engineering", "Finance"],
            display_order: 0,
          },
        ],
        error: null,
      },
    ];

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].dbId).toBe("db-fallback-1");
    expect(drafts[0].field_key).toBe("department");
    expect(drafts[0].field_type).toBe("select");
    expect(drafts[0].options).toEqual(["Engineering", "Finance"]);
    // Two DB calls: primary (failed) + fallback
    expect(callIndex).toBe(2);
  });
});

// ── BCF-3 ──────────────────────────────────────────────────────────────────────

describe("BCF-3 — both primary and fallback fail → returns []", () => {
  it("returns an empty array when both queries return errors", async () => {
    responseSequence = [
      { data: null, error: { message: "network timeout" } },
      { data: null, error: { message: "connection refused" } },
    ];

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts).toEqual([]);
    expect(callIndex).toBe(2);
  });

  it("returns an empty array when primary fails and fallback returns null data", async () => {
    responseSequence = [
      { data: null, error: { message: "column error" } },
      { data: null, error: null },
    ];

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts).toEqual([]);
  });
});

// ── BCF-4 ──────────────────────────────────────────────────────────────────────

describe("BCF-4 — fallback data is correctly mapped including parent resolution", () => {
  it("resolves parent_branch_local_id from fallback rows", async () => {
    const parentDbId = "parent-fb-1";
    const childDbId  = "child-fb-1";

    responseSequence = [
      // Primary fails
      { data: null, error: { message: "retired_at missing" } },
      // Fallback succeeds with parent + child
      {
        data: [
          {
            id: parentDbId,
            parent_option_value: "OPT1",
            parent_branch_id: null,
            field_key: "region",
            name: "Region",
            field_type: "select",
            required: false,
            placeholder: null,
            help_text: null,
            options: ["North", "South"],
            display_order: 0,
          },
          {
            id: childDbId,
            parent_option_value: "OPT1",
            parent_branch_id: parentDbId,
            field_key: "city",
            name: "City",
            field_type: "text",
            required: false,
            placeholder: null,
            help_text: null,
            options: null,
            display_order: 1,
          },
        ],
        error: null,
      },
    ];

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts).toHaveLength(2);

    const parent = drafts.find((d) => d.dbId === parentDbId)!;
    const child  = drafts.find((d) => d.dbId === childDbId)!;

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent.parent_branch_local_id).toBeNull();
    expect(child.parent_branch_local_id).toBe(parent.localId);
  });
});
