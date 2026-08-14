/**
 * DOC-047 — Branch Config Atomic Save & Data-Integrity Repair
 *
 * BAS-1   createDraftBranch — initialises dbId: null
 * BAS-2   loadDraftBranchesForTemplate — maps DB row.id to dbId
 * BAS-3   loadDraftBranchesForTemplate — includes retired_at IS NULL filter
 * BAS-4   loadDraftBranchesForTemplate — resolves parent_branch_id → parent_branch_local_id
 * BAS-5   loadDraftBranchesForTemplate — returns [] on Supabase error
 * BAS-6   saveOptionBranchConfigurationAtomically — calls supabase.rpc with correct name
 * BAS-7   saveOptionBranchConfigurationAtomically — db_id sent for loaded (existing) branches
 * BAS-8   saveOptionBranchConfigurationAtomically — db_id: null for new branches
 * BAS-9   saveOptionBranchConfigurationAtomically — parent_branch_local_id → parent_local_id
 * BAS-10  saveOptionBranchConfigurationAtomically — root branches have parent_local_id: null
 * BAS-11  saveOptionBranchConfigurationAtomically — p_expected_updated_at forwarded from arg
 * BAS-12  saveOptionBranchConfigurationAtomically — null expectedUpdatedAt sent as null
 * BAS-13  saveOptionBranchConfigurationAtomically — returns AtomicSaveResult on success
 * BAS-14  saveOptionBranchConfigurationAtomically — throws when RPC returns error
 * BAS-15  saveOptionBranchConfigurationAtomically — stale_edit error propagated intact
 * BAS-16  saveOptionBranchConfigurationAtomically — project_integrity error propagated intact
 * BAS-17  saveOptionBranchConfigurationAtomically — options array forwarded for select type
 * BAS-18  saveOptionBranchConfigurationAtomically — options: null for non-select/checkbox types
 * BAS-19  saveOptionBranchConfigurationAtomically — no .delete() call in the save path
 * BAS-20  saveOptionBranchConfigurationAtomically — local_id matches DraftOptionBranch.localId
 * BAS-21  saveOptionBranchConfigurationAtomically — p_parent_options forwarded as array
 * BAS-22  correction-dialog module has no dependency on branch persistence save path
 */

import { describe, it, expect, vi, type Mock, beforeEach } from "vitest";
import {
  createDraftBranch,
  loadDraftBranchesForTemplate,
  saveOptionBranchConfigurationAtomically,
  type DraftOptionBranch,
  type AtomicSaveResult,
} from "@/lib/optionBranchPersistence";
import { EMPTY_CORRECTION_FIELDS } from "@/lib/loadCorrectionCustomFields";

// ── Mutable state that the top-level vi.mock factory reads at call-time ────────
// Using an object wrapper so the mock closure captures the reference, not the
// value. Tests mutate mockState before calling the function under test; the
// mock reads the current value of mockState.fromResult at call-time.
const mockState = {
  fromResult: { data: [] as unknown, error: null as unknown },
  calledMethods: [] as string[],
  deleteCalled: false,
};

let mockRpc: Mock;

// vi.mock is hoisted above imports by Vitest. The `from` function closes over
// `mockState` and `mockRpc` — they are READ at call-time (test execution), not
// at factory execution time, so the TDZ does not apply.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(_table: string) {
      const chain: Record<string, unknown> = {};
      const track = (name: string) =>
        (..._args: unknown[]) => {
          mockState.calledMethods.push(name);
          if (name === "delete") mockState.deleteCalled = true;
          return chain;
        };
      chain.select = track("select");
      chain.eq    = track("eq");
      chain.is    = track("is");
      chain.order = track("order");
      chain.in    = track("in");
      chain.limit = () => Promise.resolve(mockState.fromResult);
      chain.delete = track("delete");
      chain.insert = track("insert");
      chain.update = track("update");
      chain.upsert = track("upsert");
      chain.single = () => Promise.resolve(mockState.fromResult);
      chain.then = (
        resolve: (v: unknown) => unknown,
        reject?: (v: unknown) => unknown,
      ) => Promise.resolve(mockState.fromResult).then(resolve, reject);
      return chain;
    },
    get rpc() {
      return mockRpc;
    },
  },
}));

// ── Shared success result ───────────────────────────────────────────────────
const SUCCESS_RESULT: AtomicSaveResult = {
  ok: true,
  revision_id: "rev-uuid-001",
  latest_updated_at: "2026-07-07T10:00:00.000Z",
  branches_inserted: 0,
  branches_updated: 2,
  branches_retired: 0,
};

beforeEach(() => {
  mockState.fromResult    = { data: [], error: null };
  mockState.calledMethods = [];
  mockState.deleteCalled  = false;
  mockRpc = vi.fn().mockResolvedValue({ data: SUCCESS_RESULT, error: null });
});

// ── BAS-1 ──────────────────────────────────────────────────────────────────────

describe("BAS-1 — createDraftBranch initialises dbId: null", () => {
  it("returns a draft with dbId set to null", () => {
    const draft = createDraftBranch("opt-1", null, 0);
    expect(draft.dbId).toBeNull();
  });
});

// ── BAS-2 ──────────────────────────────────────────────────────────────────────

describe("BAS-2 — loadDraftBranchesForTemplate maps DB row.id to dbId", () => {
  it("sets dbId to the database row id", async () => {
    const dbId = "db-uuid-001";
    mockState.fromResult = {
      data: [
        {
          id: dbId,
          parent_option_value: "OPT1",
          parent_branch_id: null,
          field_key: "project_id",
          name: "Project ID",
          field_type: "select",
          required: false,
          placeholder: null,
          help_text: null,
          options: ["101", "102"],
          display_order: 0,
          retired_at: null,
        },
      ],
      error: null,
    };

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts.length).toBe(1);
    expect(drafts[0].dbId).toBe(dbId);
  });
});

// ── BAS-3 ──────────────────────────────────────────────────────────────────────

describe("BAS-3 — loadDraftBranchesForTemplate applies retired_at IS NULL filter", () => {
  it("calls .is('retired_at', null) on the query chain", async () => {
    await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(mockState.calledMethods).toContain("is");
  });
});

// ── BAS-4 ──────────────────────────────────────────────────────────────────────

describe("BAS-4 — loadDraftBranchesForTemplate resolves parent_branch_id to parent_branch_local_id", () => {
  it("sets parent_branch_local_id to the parent's localId", async () => {
    const parentDbId = "parent-db-uuid";
    const childDbId  = "child-db-uuid";

    mockState.fromResult = {
      data: [
        {
          id: parentDbId,
          parent_option_value: "OPT1",
          parent_branch_id: null,
          field_key: "project_id",
          name: "Project ID",
          field_type: "select",
          required: false,
          placeholder: null,
          help_text: null,
          options: [],
          display_order: 0,
          retired_at: null,
        },
        {
          id: childDbId,
          parent_option_value: "OPT1",
          parent_branch_id: parentDbId,
          field_key: "sub_field",
          name: "Sub Field",
          field_type: "text",
          required: false,
          placeholder: null,
          help_text: null,
          options: null,
          display_order: 1,
          retired_at: null,
        },
      ],
      error: null,
    };

    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    const parent = drafts.find((d) => d.dbId === parentDbId)!;
    const child  = drafts.find((d) => d.dbId === childDbId)!;

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent.parent_branch_local_id).toBeNull();
    expect(child.parent_branch_local_id).toBe(parent.localId);
  });
});

// ── BAS-5 ──────────────────────────────────────────────────────────────────────

describe("BAS-5 — loadDraftBranchesForTemplate returns [] on error", () => {
  it("returns an empty array when Supabase returns an error", async () => {
    mockState.fromResult = { data: null, error: { message: "network error" } };
    const drafts = await loadDraftBranchesForTemplate("org-1", "tpl-1");
    expect(drafts).toEqual([]);
  });
});

// ── BAS-6 ──────────────────────────────────────────────────────────────────────

describe("BAS-6 — saveOptionBranchConfigurationAtomically calls supabase.rpc with correct name", () => {
  it("calls 'save_option_branch_configuration_atomically'", async () => {
    await saveOptionBranchConfigurationAtomically("org-1", "tpl-1", null, ["OPT1"], []);
    expect(mockRpc).toHaveBeenCalledWith(
      "save_option_branch_configuration_atomically",
      expect.any(Object),
    );
  });
});

// ── BAS-7 ──────────────────────────────────────────────────────────────────────

describe("BAS-7 — saveOptionBranchConfigurationAtomically sends db_id for existing branches", () => {
  it("payload contains the dbId of a loaded branch", async () => {
    const existingDraft: DraftOptionBranch = {
      localId: "local-001",
      dbId: "db-uuid-001",
      parent_option_value: "OPT1",
      parent_branch_local_id: null,
      field_key: "project_id",
      name: "Project ID",
      field_type: "select",
      required: false,
      placeholder: "",
      help_text: "",
      options: ["101"],
      display_order: 0,
    };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", "2026-07-01T00:00:00Z", ["OPT1"], [existingDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { db_id: string | null }[];
    expect(payload[0].db_id).toBe("db-uuid-001");
  });
});

// ── BAS-8 ──────────────────────────────────────────────────────────────────────

describe("BAS-8 — saveOptionBranchConfigurationAtomically sends db_id: null for new branches", () => {
  it("payload contains null db_id for a branch created in the editor", async () => {
    const newDraft: DraftOptionBranch = {
      localId: "local-002",
      dbId: null,
      parent_option_value: "OPT2",
      parent_branch_local_id: null,
      field_key: "project_name",
      name: "Project Name",
      field_type: "select",
      required: false,
      placeholder: "",
      help_text: "",
      options: ["Alpha"],
      display_order: 0,
    };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT2"], [newDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { db_id: string | null }[];
    expect(payload[0].db_id).toBeNull();
  });
});

// ── BAS-9 ──────────────────────────────────────────────────────────────────────

describe("BAS-9 — saveOptionBranchConfigurationAtomically maps parent_branch_local_id to parent_local_id", () => {
  it("nested branch carries the parent's localId as parent_local_id", async () => {
    const parentDraft: DraftOptionBranch = {
      localId: "local-parent",
      dbId: "db-parent",
      parent_option_value: "OPT1",
      parent_branch_local_id: null,
      field_key: "project_id",
      name: "Project ID",
      field_type: "select",
      required: false,
      placeholder: "",
      help_text: "",
      options: [],
      display_order: 0,
    };
    const childDraft: DraftOptionBranch = {
      localId: "local-child",
      dbId: null,
      parent_option_value: "OPT1",
      parent_branch_local_id: "local-parent",
      field_key: "sub",
      name: "Sub Field",
      field_type: "text",
      required: false,
      placeholder: "",
      help_text: "",
      options: [],
      display_order: 1,
    };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [parentDraft, childDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { local_id: string; parent_local_id: string | null }[];
    const child   = payload.find((b) => b.local_id === "local-child")!;
    expect(child.parent_local_id).toBe("local-parent");
  });
});

// ── BAS-10 ─────────────────────────────────────────────────────────────────────

describe("BAS-10 — root branches have parent_local_id: null", () => {
  it("root branch has parent_local_id null in payload", async () => {
    const rootDraft: DraftOptionBranch = {
      localId: "local-root",
      dbId: null,
      parent_option_value: "OPT1",
      parent_branch_local_id: null,
      field_key: "project_id",
      name: "Project ID",
      field_type: "text",
      required: false,
      placeholder: "",
      help_text: "",
      options: [],
      display_order: 0,
    };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [rootDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { parent_local_id: string | null }[];
    expect(payload[0].parent_local_id).toBeNull();
  });
});

// ── BAS-11 ─────────────────────────────────────────────────────────────────────

describe("BAS-11 — p_expected_updated_at forwarded from argument", () => {
  it("passes the expectedUpdatedAt string to the RPC", async () => {
    const ts = "2026-06-30T12:00:00.000Z";
    await saveOptionBranchConfigurationAtomically("org-1", "tpl-1", ts, ["OPT1"], []);
    const call = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(call.p_expected_updated_at).toBe(ts);
  });
});

// ── BAS-12 ─────────────────────────────────────────────────────────────────────

describe("BAS-12 — null expectedUpdatedAt sent as null to RPC", () => {
  it("passes null when expectedUpdatedAt is null (new template)", async () => {
    await saveOptionBranchConfigurationAtomically("org-1", "tpl-1", null, ["OPT1"], []);
    const call = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(call.p_expected_updated_at).toBeNull();
  });
});

// ── BAS-13 ─────────────────────────────────────────────────────────────────────

describe("BAS-13 — returns AtomicSaveResult on success", () => {
  it("resolves with the AtomicSaveResult from the RPC", async () => {
    const result = await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [],
    );
    expect(result).toMatchObject<Partial<AtomicSaveResult>>({
      ok: true,
      revision_id: expect.any(String),
      latest_updated_at: expect.any(String),
    });
  });
});

// ── BAS-14 ─────────────────────────────────────────────────────────────────────

describe("BAS-14 — throws when RPC returns error", () => {
  it("rejects with the Supabase error object", async () => {
    const rpcError = { message: "permission denied", code: "42501" };
    mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

    await expect(
      saveOptionBranchConfigurationAtomically("org-1", "tpl-1", null, ["OPT1"], []),
    ).rejects.toMatchObject({ message: "permission denied" });
  });
});

// ── BAS-15 ─────────────────────────────────────────────────────────────────────

describe("BAS-15 — stale_edit error propagated intact", () => {
  it("error message starts with 'stale_edit:' when RPC rejects stale save", async () => {
    const staleError = {
      message:
        "stale_edit: Template configuration was modified by another session. " +
        "Close and reopen the editor to reload the latest version.",
      code: "P0001",
    };
    mockRpc.mockResolvedValueOnce({ data: null, error: staleError });

    await expect(
      saveOptionBranchConfigurationAtomically(
        "org-1", "tpl-1", "2026-06-01T00:00:00Z", ["OPT1"], [],
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("stale_edit:") });
  });
});

// ── BAS-16 ─────────────────────────────────────────────────────────────────────

describe("BAS-16 — project_integrity error propagated intact", () => {
  it("error message starts with 'project_integrity:' when a parent option is incomplete", async () => {
    const integrityError = {
      message:
        'project_integrity: Parent option "OPT1" is missing a required ' +
        "project_id or project_name root branch",
      code: "P0002",
    };
    mockRpc.mockResolvedValueOnce({ data: null, error: integrityError });

    await expect(
      saveOptionBranchConfigurationAtomically(
        "org-1", "51181324-68cc-4174-bbe0-4834e5e22c48",
        null, ["OPT1"], [],
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("project_integrity:") });
  });
});

// ── BAS-17 ─────────────────────────────────────────────────────────────────────

describe("BAS-17 — options array forwarded for select-type branch", () => {
  it("select branch carries its options array in the payload", async () => {
    const selectDraft: DraftOptionBranch = {
      localId: "local-sel",
      dbId: null,
      parent_option_value: "OPT1",
      parent_branch_local_id: null,
      field_key: "project_id",
      name: "Project ID",
      field_type: "select",
      required: false,
      placeholder: "",
      help_text: "",
      options: ["101", "102", "103"],
      display_order: 0,
    };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [selectDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { options: string[] | null }[];
    expect(payload[0].options).toEqual(["101", "102", "103"]);
  });
});

// ── BAS-18 ─────────────────────────────────────────────────────────────────────

describe("BAS-18 — options: null for non-select/checkbox types", () => {
  it("text-type branch has options: null in the payload", async () => {
    const textDraft: DraftOptionBranch = {
      localId: "local-txt",
      dbId: null,
      parent_option_value: "OPT1",
      parent_branch_local_id: null,
      field_key: "project_name",
      name: "Project Name",
      field_type: "text",
      required: false,
      placeholder: "",
      help_text: "",
      options: [],
      display_order: 1,
    };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [textDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { options: string[] | null }[];
    expect(payload[0].options).toBeNull();
  });
});

// ── BAS-19 ─────────────────────────────────────────────────────────────────────

describe("BAS-19 — saveOptionBranchConfigurationAtomically has no .delete() call", () => {
  it("does not trigger a DELETE on the branches table", async () => {
    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [],
    );
    expect(mockState.deleteCalled).toBe(false);
  });
});

// ── BAS-20 ─────────────────────────────────────────────────────────────────────

describe("BAS-20 — local_id in payload matches DraftOptionBranch.localId", () => {
  it("payload item carries the browser-generated localId as local_id", async () => {
    const draft = createDraftBranch("OPT1", null, 0);
    const namedDraft: DraftOptionBranch = { ...draft, name: "Some Field" };

    await saveOptionBranchConfigurationAtomically(
      "org-1", "tpl-1", null, ["OPT1"], [namedDraft],
    );

    const call    = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    const payload = call.p_branches as { local_id: string }[];
    expect(payload[0].local_id).toBe(namedDraft.localId);
  });
});

// ── BAS-21 ─────────────────────────────────────────────────────────────────────

describe("BAS-21 — p_parent_options forwarded as array to RPC", () => {
  it("sends the parent options array as p_parent_options", async () => {
    const opts = ["UID-001", "UID-002", "UID-003"];
    await saveOptionBranchConfigurationAtomically("org-1", "tpl-1", null, opts, []);
    const call = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(call.p_parent_options).toEqual(opts);
  });
});

// ── BAS-22 ─────────────────────────────────────────────────────────────────────

describe("BAS-22 — correction-dialog module has no dependency on branch persistence save path", () => {
  it("EMPTY_CORRECTION_FIELDS does not contain branchDrafts (correction-dialog unchanged)", () => {
    expect(EMPTY_CORRECTION_FIELDS).not.toHaveProperty("branchDrafts");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("categoryFormFields");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("optionBranches");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("formFieldValues");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("branchValues");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("initialFormFieldValues");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("initialBranchValues");
    expect(EMPTY_CORRECTION_FIELDS).toHaveProperty("categoryId");
  });

  it("EMPTY_CORRECTION_FIELDS.optionBranches is an array (not DraftOptionBranch[])", () => {
    expect(Array.isArray(EMPTY_CORRECTION_FIELDS.optionBranches)).toBe(true);
  });
});
