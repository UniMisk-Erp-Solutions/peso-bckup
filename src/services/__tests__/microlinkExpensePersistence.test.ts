import { describe, expect, it, vi, beforeEach } from "vitest";

const { rpcMock, fromMock, supabaseStub } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  const fromMock = vi.fn();
  /** Behaves like the real client in the way that matters: rpc reads `this`. */
  const supabaseStub = {
    __isSupabaseClient: true,
    rpc(this: unknown, ...args: unknown[]) {
      if (!(this as { __isSupabaseClient?: boolean } | undefined)?.__isSupabaseClient) {
        throw new TypeError("supabase.rpc called without its client");
      }
      return rpcMock(...args);
    },
    from(...args: unknown[]) {
      return fromMock(...args);
    },
  };
  return { rpcMock, fromMock, supabaseStub };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseStub }));

import {
  lookupSubmissionResult,
  saveMicroLinkExpenseDraft,
  submitMicroLinkExpense,
  submitMicroLinkExpenseBatch,
  updateSubmittedMicroLinkExpense,
  usesAtomicSubmissionV1,
  verifyPersistedExpense,
  type SubmissionReceipt,
} from "@/services/microlinkExpensePersistence";
import {
  buildMicroLinkExpenseSnapshotV1,
  MICROLINK_ORGANIZATION_ID,
} from "@/lib/microlinkExpenseSnapshot";

const KEY = "11111111-1111-1111-1111-111111111111";

const snapshot = () =>
  buildMicroLinkExpenseSnapshotV1(
    {
      title: "Site visit",
      destination: "Halol",
      tripStart: "2026-09-09",
      category: "Travelling (Public and Private Transport)",
      totalAmount: 123.45,
      projectUniqueId: "202605M117",
      fromLocation: "Ahmedabad",
      toLocation: "Gandhinagar",
    },
    {
      idempotencyKey: KEY,
      visibility: { projectUniqueId: true, fromLocation: true, toLocation: true },
      configResolved: true,
    },
  );

const receipt = (over: Partial<SubmissionReceipt> = {}): SubmissionReceipt => ({
  committed: true,
  replayed: false,
  expense_id: "exp-1",
  transaction_number: "19838",
  status: "submitted",
  revision: 0,
  submitted_at: "2026-09-09T10:00:00Z",
  snapshot_hash: "abc",
  persisted_core_fields: 5,
  persisted_custom_fields: 5,
  idempotency_key: KEY,
  ...over,
});

/** How many MUTATING business requests the client issued. */
function mutatingCalls() {
  return rpcMock.mock.calls.filter(([fn]) =>
    ["submit_microlink_expense_v1", "save_microlink_expense_draft_v1",
     "submit_microlink_expense_batch_v1", "replace_expense_form_field_values"].includes(fn as string),
  );
}

describe("MicroLink atomic persistence — one request, one transaction", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
  });

  it("routes only MicroLink to V1", () => {
    expect(usesAtomicSubmissionV1(MICROLINK_ORGANIZATION_ID)).toBe(true);
    expect(usesAtomicSubmissionV1("e0e9c7a9-555f-448a-8ba2-10fae8e0bf64")).toBe(false);
    expect(usesAtomicSubmissionV1(null)).toBe(false);
    expect(usesAtomicSubmissionV1(undefined)).toBe(false);
  });

  it("§30 a submit issues EXACTLY ONE mutating request, and no custom-field call", async () => {
    rpcMock.mockResolvedValue({ data: receipt(), error: null });

    const out = await submitMicroLinkExpense(snapshot());

    expect(out.kind).toBe("committed");
    expect(mutatingCalls()).toHaveLength(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe("submit_microlink_expense_v1");
    // the exact failures we are removing
    expect(rpcMock.mock.calls.map((c) => c[0])).not.toContain("replace_expense_form_field_values");
    expect(fromMock).not.toHaveBeenCalled(); // no PATCH /rest/v1/expenses
  });

  it("§13 a draft save is also exactly one request", async () => {
    rpcMock.mockResolvedValue({ data: receipt({ status: "draft", transaction_number: null }), error: null });

    const out = await saveMicroLinkExpenseDraft(snapshot());

    expect(out.kind).toBe("committed");
    expect(mutatingCalls()).toHaveLength(1);
    expect(rpcMock.mock.calls[0][0]).toBe("save_microlink_expense_draft_v1");
  });

  describe("hotfix 2026-09-09: updating an already-submitted expense", () => {
    it("calls the dedicated update_microlink_submitted_expense_v1 RPC, not submit", async () => {
      rpcMock.mockResolvedValue({ data: receipt(), error: null });

      const out = await updateSubmittedMicroLinkExpense(snapshot());

      expect(out.kind).toBe("committed");
      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcMock.mock.calls[0][0]).toBe("update_microlink_submitted_expense_v1");
      expect(rpcMock.mock.calls.map((c) => c[0])).not.toContain("submit_microlink_expense_v1");
    });

    it("a status-eligibility rejection from the server surfaces as a clean rejection", async () => {
      rpcMock.mockResolvedValue({
        data: null,
        error: { code: "22023", message: "This expense can no longer be edited (status approved)." },
      });
      const out = await updateSubmittedMicroLinkExpense(snapshot());
      expect(out).toEqual({
        kind: "rejected",
        code: "22023",
        message: "This expense can no longer be edited (status approved).",
        conflict: false,
      });
    });
  });

  it("sends the snapshot through unchanged, with its project values", async () => {
    rpcMock.mockResolvedValue({ data: receipt(), error: null });
    await submitMicroLinkExpense(snapshot());
    const sent = rpcMock.mock.calls[0][1] as { p_snapshot: ReturnType<typeof snapshot> };
    expect(sent.p_snapshot.microlink.project_unique_id).toBe("202605M117");
    expect(sent.p_snapshot.microlink.from_location).toBe("Ahmedabad");
    expect(sent.p_snapshot.microlink.to_location).toBe("Gandhinagar");
    expect(sent.p_snapshot.idempotency_key).toBe(KEY);
  });

  describe("failure matrix", () => {
    it("400-class validation is a clean rejection with the server's own message", async () => {
      rpcMock.mockResolvedValue({
        data: null,
        error: { code: "PW001", message: "Required project details are incomplete." },
      });
      const out = await submitMicroLinkExpense(snapshot());
      expect(out).toEqual({
        kind: "rejected",
        code: "PW001",
        message: "Required project details are incomplete.",
        conflict: false,
      });
    });

    it("409 revision conflict is flagged as a conflict, not a generic error", async () => {
      rpcMock.mockResolvedValue({
        data: null,
        error: { code: "PW409", message: "This expense changed in another session." },
      });
      const out = await submitMicroLinkExpense(snapshot());
      expect(out.kind).toBe("rejected");
      if (out.kind === "rejected") expect(out.conflict).toBe(true);
    });

    it("500 is a rejection, not a silent success", async () => {
      rpcMock.mockResolvedValue({ data: null, error: { code: "XX000", message: "internal error" } });
      const out = await submitMicroLinkExpense(snapshot());
      expect(out.kind).toBe("rejected");
    });

    it("§18 a 504 asks the server what happened rather than declaring failure", async () => {
      rpcMock
        .mockResolvedValueOnce({ data: null, error: { message: "gateway timeout", status: 504 } })
        .mockResolvedValueOnce({ data: { ...receipt(), committed: true, known: true }, error: null });

      const out = await submitMicroLinkExpense(snapshot());

      expect(rpcMock.mock.calls[1][0]).toBe("get_expense_submission_result_v1");
      expect(rpcMock.mock.calls[1][1]).toEqual({ p_idempotency_key: KEY });
      expect(out.kind).toBe("committed");
    });

    it("§34 response lost AFTER commit resolves to success, with no second write", async () => {
      rpcMock
        .mockRejectedValueOnce(new Error("Failed to fetch"))
        .mockResolvedValueOnce({ data: { ...receipt(), committed: true, known: true }, error: null });

      const out = await submitMicroLinkExpense(snapshot());

      expect(out.kind).toBe("committed");
      if (out.kind === "committed") expect(out.receipt.transaction_number).toBe("19838");
      // exactly one mutating attempt; the second call is a read-only lookup
      expect(mutatingCalls()).toHaveLength(1);
    });

    it("a timeout that truly did not commit stays UNKNOWN, never 'saved as draft'", async () => {
      rpcMock
        .mockResolvedValueOnce({ data: null, error: { message: "network error" } })
        .mockResolvedValueOnce({ data: { committed: false, known: false }, error: null });

      const out = await submitMicroLinkExpense(snapshot());
      expect(out.kind).toBe("unknown");
    });

    it("HTTP success without a committed receipt is NOT treated as success", async () => {
      rpcMock
        .mockResolvedValueOnce({ data: { committed: false }, error: null })
        .mockResolvedValueOnce({ data: { committed: false, known: false }, error: null });
      const out = await submitMicroLinkExpense(snapshot());
      expect(out.kind).toBe("unknown");
    });

    it("§17 a retry reuses the same key, so the server can replay one receipt", async () => {
      rpcMock.mockResolvedValue({ data: receipt({ replayed: true }), error: null });
      const s = snapshot();
      await submitMicroLinkExpense(s);
      await submitMicroLinkExpense(s);
      const keys = rpcMock.mock.calls.map((c) => (c[1] as { p_snapshot?: { idempotency_key: string } }).p_snapshot?.idempotency_key);
      expect(new Set(keys)).toEqual(new Set([KEY]));
    });
  });

  describe("batch", () => {
    it("defaults to all-or-none", async () => {
      rpcMock.mockResolvedValue({
        data: { batch_valid: false, committed: false, submitted_count: 0,
                failed: [{ index: 3, sqlstate: "PW001", message: "missing", title: "line 3" }] },
        error: null,
      });
      const out = await submitMicroLinkExpenseBatch([snapshot(), snapshot()]);
      expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_allow_partial: false });
      expect(out.kind).toBe("ok");
      if (out.kind === "ok") {
        expect(out.result.submitted_count).toBe(0);
        expect(out.result.failed[0].index).toBe(3);
      }
    });

    it("§26 partial submission requires an explicit opt-in", async () => {
      rpcMock.mockResolvedValue({
        data: { batch_valid: false, committed: true, submitted_count: 2, failed: [] },
        error: null,
      });
      await submitMicroLinkExpenseBatch([snapshot()], true);
      expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_allow_partial: true });
    });

    it("sends the whole batch in ONE request", async () => {
      rpcMock.mockResolvedValue({
        data: { batch_valid: true, committed: true, submitted_count: 3, failed: [] },
        error: null,
      });
      await submitMicroLinkExpenseBatch([snapshot(), snapshot(), snapshot()]);
      expect(mutatingCalls()).toHaveLength(1);
    });
  });

  describe("§22 readback verification", () => {
    const mockRow = (row: unknown, error: unknown = null) =>
      fromMock.mockReturnValue({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }),
      });

    it("passes when the database agrees with the receipt", async () => {
      mockRow({ id: "exp-1", status: "submitted", transaction_number: "19838" });
      const bad = await verifyPersistedExpense(receipt(), {
        status: "submitted", transactionNumberPresent: true,
      });
      expect(bad).toEqual([]);
    });

    it("reports a status mismatch instead of continuing silently", async () => {
      mockRow({ id: "exp-1", status: "draft", transaction_number: "19838" });
      const bad = await verifyPersistedExpense(receipt(), {
        status: "submitted", transactionNumberPresent: true,
      });
      expect(bad).toContain("status is draft, expected submitted");
    });

    it("reports a missing transaction number after a committed submit", async () => {
      mockRow({ id: "exp-1", status: "submitted", transaction_number: null });
      const bad = await verifyPersistedExpense(receipt({ transaction_number: null }), {
        status: "submitted", transactionNumberPresent: true,
      });
      expect(bad).toContain("transaction number missing after commit");
    });

    it("reports a receipt/database transaction-number disagreement", async () => {
      mockRow({ id: "exp-1", status: "submitted", transaction_number: "99999" });
      const bad = await verifyPersistedExpense(receipt(), {
        status: "submitted", transactionNumberPresent: true,
      });
      expect(bad).toContain("transaction number differs from the receipt");
    });
  });

  it("lookupSubmissionResult reports committed for a known key", async () => {
    rpcMock.mockResolvedValue({ data: { ...receipt(), committed: true, known: true }, error: null });
    const out = await lookupSubmissionResult(KEY);
    expect(out.kind).toBe("committed");
    if (out.kind === "committed") expect(out.receipt.replayed).toBe(true);
  });
});
