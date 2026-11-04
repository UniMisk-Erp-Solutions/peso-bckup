/**
 * MicroLink "attach first, then submit": a draft receipt must never answer a
 * submit (DOC-140).
 *
 * Incident (Oct 2026): for a new expense that needs a bill, ExpenseForm saved a
 * draft, attached the files, then called submit -- all with ONE idempotency
 * key. The server kept one receipt per key and answered a repeated key with the
 * stored receipt without looking at its action, so the submit was answered with
 * the draft receipt and never ran. The expense stayed a draft while the form
 * announced success. An HTTP/RPC "success" was not a successful transition.
 *
 * Two fake servers are modelled and BOTH are exercised:
 *   - "legacy"       : the old rule (one receipt per key, action ignored)
 *   - "action-scoped": the rule from migration 20261007120000
 *                      (receipt identity = (key, action)), including the new
 *                      response contract.
 * Every test asserts the resulting BUSINESS STATE (expense status, expense
 * count), not just that an RPC resolved.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { rpcMock, supabaseStub } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  const supabaseStub = {
    __isSupabaseClient: true,
    rpc(this: unknown, ...args: unknown[]) {
      return rpcMock(...args);
    },
    from() {
      throw new Error("not used");
    },
  };
  return { rpcMock, supabaseStub };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseStub }));

import {
  lookupSubmissionResult,
  saveMicroLinkExpenseDraft,
  semanticMismatchTags,
  snapshotWithIdempotencyKey,
  submitMicroLinkExpense,
  unsubmittedReceiptMessage,
  type ReceiptAction,
  type SubmissionReceipt,
} from "@/services/microlinkExpensePersistence";
import { buildMicroLinkExpenseSnapshotV1 } from "@/lib/microlinkExpenseSnapshot";
import { prepareAttachFirstSubmit } from "@/services/microlinkAttachFirstFlow";

const SUBMIT_KEY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DRAFT_KEY = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const baseSnapshot = () =>
  buildMicroLinkExpenseSnapshotV1(
    {
      title: "Site visit",
      destination: "Halol",
      tripStart: "2026-10-01",
      category: "Travelling (Public and Private Transport)",
      totalAmount: 1200,
      projectUniqueId: "202605M117",
      fromLocation: "Ahmedabad",
      toLocation: "Gandhinagar",
    },
    {
      idempotencyKey: SUBMIT_KEY,
      visibility: { projectUniqueId: true, fromLocation: true, toLocation: true },
      configResolved: true,
    },
  );

const ACTION_BY_FN: Record<string, ReceiptAction> = {
  submit_microlink_expense_v1: "submit",
  save_microlink_expense_draft_v1: "save_draft",
  update_microlink_submitted_expense_v1: "update_submitted",
};

type Mode = "legacy" | "action-scoped";
type StoredReceipt = SubmissionReceipt & { action: ReceiptAction };

function installFakeServer(mode: Mode, opts: { lookupLacksAction?: boolean } = {}) {
  const receipts = new Map<string, StoredReceipt>();
  const expenses = new Map<string, { status: "draft" | "submitted"; revision: number }>();
  const calls: { fn: string; key: string; action?: ReceiptAction }[] = [];
  let seq = 0;
  const rkey = (key: string, action: ReceiptAction) => (mode === "legacy" ? key : `${key}|${action}`);

  rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "get_expense_submission_result_v1") {
      const key = args.p_idempotency_key as string;
      const wanted = args.p_action as ReceiptAction | undefined;
      calls.push({ fn, key, action: wanted });
      if (wanted && opts.lookupLacksAction) {
        return { data: null, error: { code: "PGRST202", message: "function not found" } };
      }
      const order: ReceiptAction[] = ["submit", "update_submitted", "save_draft"];
      const hit = (wanted ? [wanted] : order)
        .map((a) => receipts.get(rkey(key, a)))
        .find(Boolean);
      if (!hit) return { data: { committed: false, known: false }, error: null };
      const row = expenses.get(hit.expense_id);
      return {
        data: {
          ...hit,
          known: true,
          replayed: true,
          ...(mode === "action-scoped" ? { receipt_action: hit.action, actual_status: row?.status } : {}),
        },
        error: null,
      };
    }

    const snap = args.p_snapshot as { idempotency_key: string; expense_id?: string | null };
    const action = ACTION_BY_FN[fn];
    calls.push({ fn, key: snap.idempotency_key, action });
    const stored = receipts.get(rkey(snap.idempotency_key, action));
    if (stored) {
      const row = expenses.get(stored.expense_id);
      return {
        data: {
          ...stored,
          replayed: true,
          ...(mode === "action-scoped"
            ? {
                requested_action: action,
                receipt_action: stored.action,
                actual_status: row?.status,
                idempotency_result: "replayed",
              }
            : {}),
        },
        error: null,
      };
    }
    const expenseId = snap.expense_id ?? `expense-${++seq}`;
    const status = action === "submit" ? "submitted" : "draft";
    const prior = expenses.get(expenseId);
    expenses.set(expenseId, {
      // a draft save can never move a submitted expense backwards
      status: action === "save_draft" && prior?.status === "submitted" ? "submitted" : status,
      revision: (prior?.revision ?? -1) + 1,
    });
    const r: StoredReceipt = {
      committed: true,
      replayed: false,
      expense_id: expenseId,
      transaction_number: action === "submit" ? "01234" : null,
      status,
      revision: expenses.get(expenseId)!.revision,
      submitted_at: "2026-10-07T00:00:00Z",
      snapshot_hash: "h",
      persisted_core_fields: 1,
      persisted_custom_fields: 0,
      idempotency_key: snap.idempotency_key,
      action,
    };
    receipts.set(rkey(snap.idempotency_key, action), r);
    return {
      data: {
        ...r,
        ...(mode === "action-scoped"
          ? { requested_action: action, receipt_action: action, actual_status: status, idempotency_result: "executed" }
          : {}),
      },
      error: null,
    };
  });
  return { receipts, expenses, calls };
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe("LEGACY server (one receipt per key): why the client uses separate keys", () => {
  it("REPRODUCTION: one shared key makes the submit a replay of the draft receipt -- the expense stays a draft", async () => {
    const { expenses } = installFakeServer("legacy");
    const snap = baseSnapshot();

    const draft = await saveMicroLinkExpenseDraft(snap);
    if (draft.kind !== "committed") throw new Error("draft should commit");
    const submit = await submitMicroLinkExpense({ ...snap, expense_id: draft.receipt.expense_id });

    expect(submit.kind).toBe("committed"); // "success" at the RPC level...
    if (submit.kind !== "committed") return;
    expect(submit.receipt.replayed).toBe(true);
    expect(submit.receipt.status).toBe("draft"); // ...but nothing was submitted
    expect(expenses.get(draft.receipt.expense_id)?.status).toBe("draft");
    expect(unsubmittedReceiptMessage(submit.receipt)).toMatch(/NOT submitted/);
  });

  it("FIX (client): a distinct draft key lets the submit run -- one expense, status submitted", async () => {
    const { expenses } = installFakeServer("legacy");
    const snap = baseSnapshot();
    const draft = await saveMicroLinkExpenseDraft(snapshotWithIdempotencyKey(snap, DRAFT_KEY));
    if (draft.kind !== "committed") throw new Error("draft should commit");
    const submit = await submitMicroLinkExpense({
      ...snap,
      expense_id: draft.receipt.expense_id,
      expected_revision: draft.receipt.revision,
    });
    if (submit.kind !== "committed") throw new Error("submit should commit");
    expect(submit.receipt.replayed).toBe(false);
    expect(submit.receipt.status).toBe("submitted");
    expect(expenses.size).toBe(1);
    expect(expenses.get(draft.receipt.expense_id)?.status).toBe("submitted");
    expect(unsubmittedReceiptMessage(submit.receipt)).toBeNull();
  });
});

describe("ACTION-SCOPED server (migration 20261007120000): receipt identity = (key, action)", () => {
  it("OLD CACHED CLIENT: draft and submit reuse ONE key -> the submit EXECUTES, exactly once, and the expense is submitted", async () => {
    const { expenses, receipts } = installFakeServer("action-scoped");
    const snap = baseSnapshot(); // old client: same key for both calls

    const draft = await saveMicroLinkExpenseDraft(snap);
    if (draft.kind !== "committed") throw new Error("draft should commit");
    const submit = await submitMicroLinkExpense({ ...snap, expense_id: draft.receipt.expense_id });
    if (submit.kind !== "committed") throw new Error("submit should commit");

    expect(submit.receipt.idempotency_result).toBe("executed");
    expect(submit.receipt.replayed).toBe(false);
    expect(submit.receipt.receipt_action).toBe("submit");
    expect(submit.receipt.actual_status).toBe("submitted");
    expect(expenses.get(draft.receipt.expense_id)?.status).toBe("submitted"); // business state
    expect(expenses.size).toBe(1);
    expect(receipts.size).toBe(2); // one save_draft + one submit receipt under the same raw key
    expect(unsubmittedReceiptMessage(submit.receipt)).toBeNull();
  });

  it("a draft retry and a submit retry each replay their OWN receipt (no duplicate, no cross-answer)", async () => {
    const { expenses } = installFakeServer("action-scoped");
    const snap = baseSnapshot();
    const draft = await saveMicroLinkExpenseDraft(snap);
    if (draft.kind !== "committed") throw new Error("x");
    const submitArgs = { ...snap, expense_id: draft.receipt.expense_id };
    const s1 = await submitMicroLinkExpense(submitArgs);
    const s2 = await submitMicroLinkExpense(submitArgs);
    const d2 = await saveMicroLinkExpenseDraft(snap);
    if (s1.kind !== "committed" || s2.kind !== "committed" || d2.kind !== "committed") throw new Error("x");
    expect(s2.receipt.idempotency_result).toBe("replayed");
    expect(s2.receipt.receipt_action).toBe("submit");
    expect(s2.receipt.status).toBe("submitted");
    expect(d2.receipt.receipt_action).toBe("save_draft");
    expect(expenses.size).toBe(1);
    expect(expenses.get(draft.receipt.expense_id)?.status).toBe("submitted"); // late draft retry cannot revert it
  });

  it("DOUBLE CLICK on a brand-new submit: one expense, one submission", async () => {
    const { expenses } = installFakeServer("action-scoped");
    const snap = baseSnapshot();
    const a = await submitMicroLinkExpense(snap);
    const b = await submitMicroLinkExpense(snap);
    if (a.kind !== "committed" || b.kind !== "committed") throw new Error("x");
    expect(b.receipt.expense_id).toBe(a.receipt.expense_id);
    expect(expenses.size).toBe(1);
    expect([...expenses.values()][0].status).toBe("submitted");
  });

  it("RESPONSE LOST after the submit committed: reconciliation asks for the SUBMIT receipt and finds a submitted expense", async () => {
    const { calls } = installFakeServer("action-scoped");
    const snap = baseSnapshot();
    const draft = await saveMicroLinkExpenseDraft(snap); // old client, same key
    if (draft.kind !== "committed") throw new Error("x");
    // submit commits server-side, but the client sees a network failure
    const real = rpcMock.getMockImplementation()!;
    let first = true;
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const res = await real(fn, args);
      if (first && fn === "submit_microlink_expense_v1") {
        first = false;
        return { data: null, error: { message: "Failed to fetch" } };
      }
      return res;
    });
    const out = await submitMicroLinkExpense({ ...snap, expense_id: draft.receipt.expense_id });
    if (out.kind !== "committed") throw new Error(`expected committed, got ${out.kind}`);
    expect(out.receipt.receipt_action).toBe("submit");
    expect(out.receipt.status).toBe("submitted");
    expect(calls.some((c) => c.fn === "get_expense_submission_result_v1" && c.action === "submit")).toBe(true);
  });

  it("lookup on an older server (no p_action) falls back, and a draft receipt is still not accepted as a submission", async () => {
    installFakeServer("legacy", { lookupLacksAction: true }); // old lookup: key only, returns the draft receipt
    await saveMicroLinkExpenseDraft(baseSnapshot());
    const out = await lookupSubmissionResult(SUBMIT_KEY, "submit");
    // The fallback returns the draft receipt; callers must treat it as NOT submitted.
    expect(out.kind).toBe("committed");
    if (out.kind === "committed") {
      expect(out.receipt.status).toBe("draft");
      expect(unsubmittedReceiptMessage(out.receipt)).not.toBeNull();
    }
  });

  it("lookup rejects a receipt whose stored action differs from the one requested", async () => {
    rpcMock.mockResolvedValue({
      data: { committed: true, known: true, status: "draft", receipt_action: "save_draft", expense_id: "e", idempotency_key: SUBMIT_KEY },
      error: null,
    });
    const out = await lookupSubmissionResult(SUBMIT_KEY, "submit");
    expect(out.kind).toBe("unknown");
  });
});

describe("semantic success: 'committed' is not 'submitted'", () => {
  it("any receipt that is not a submitted submission produces the NOT-submitted message", () => {
    expect(unsubmittedReceiptMessage({ status: "submitted" })).toBeNull();
    expect(unsubmittedReceiptMessage({ status: "submitted", actual_status: "submitted", receipt_action: "submit" })).toBeNull();
    expect(unsubmittedReceiptMessage({ status: "draft" })).toMatch(/saved as a draft but was NOT submitted/);
    expect(unsubmittedReceiptMessage({ status: "submitted", actual_status: "draft" })).not.toBeNull();
    expect(unsubmittedReceiptMessage({ status: "submitted", receipt_action: "save_draft" })).not.toBeNull();
  });

  it("monitoring tags carry only enumerated facts", () => {
    expect(semanticMismatchTags({ status: "draft", actual_status: "draft", receipt_action: "save_draft" })).toEqual({
      requestedAction: "submit",
      receiptAction: "save_draft",
      actualStatus: "draft",
    });
    expect(semanticMismatchTags({ status: "draft" })).toEqual({
      requestedAction: "submit",
      receiptAction: "unknown",
      actualStatus: "draft",
    });
  });

  it("snapshotWithIdempotencyKey changes only the key", () => {
    const snap = baseSnapshot();
    const out = snapshotWithIdempotencyKey(snap, DRAFT_KEY);
    expect(out.idempotency_key).toBe(DRAFT_KEY);
    expect({ ...out, idempotency_key: snap.idempotency_key }).toEqual(snap);
    expect(snap.idempotency_key).toBe(SUBMIT_KEY);
  });
});

describe("attach-first orchestration: PDF / attachment failure matrix (both server models)", () => {
  type AttachOutcome = "ok" | "fail_before_row" | "finalize_timeout" | "abort_after_upload";
  const modes: Mode[] = ["legacy", "action-scoped"];

  /** One logical user attempt (same keys across retries); returns the final business state. */
  async function attempt(
    files: Set<string>,
    attachOutcome: AttachOutcome = "ok",
    pdfs: string[] = ["bill.pdf"],
  ) {
    const reports: string[] = [];
    const working = await prepareAttachFirstSubmit(baseSnapshot(), DRAFT_KEY, {
      onFailure: (stage) => reports.push(stage),
      attachFiles: async (expenseId) => {
        // deterministic destination `${expenseId}/${filename}` == the finalize function's idempotent probe
        if (attachOutcome === "fail_before_row") throw new Error("upload failed");
        for (const f of pdfs) files.add(`${expenseId}/${f}`);
        if (attachOutcome === "finalize_timeout") throw new Error("finalize timed out");
        if (attachOutcome === "abort_after_upload") throw new Error("aborted");
      },
    });
    const submit = await submitMicroLinkExpense(working);
    return { working, submit, reports };
  }

  for (const mode of modes) {
    describe(mode, () => {
      it("PDF success: draft -> attach -> submit -> expense is SUBMITTED with the file attached once", async () => {
        const { expenses } = installFakeServer(mode);
        const files = new Set<string>();
        const r = await attempt(files);
        if (r.submit.kind !== "committed") throw new Error("x");
        expect(unsubmittedReceiptMessage(r.submit.receipt)).toBeNull();
        expect(expenses.get(r.submit.receipt.expense_id)?.status).toBe("submitted");
        expect(files.size).toBe(1);
      });

      it("PDF failure before the attachment row exists: the submit is NEVER sent; a retry resumes the SAME draft and then submits", async () => {
        const { expenses, calls } = installFakeServer(mode);
        const files = new Set<string>();
        await expect(attempt(files, "fail_before_row")).rejects.toThrow("upload failed");
        expect(calls.some((c) => c.fn === "submit_microlink_expense_v1")).toBe(false);
        expect([...expenses.values()].map((e) => e.status)).toEqual(["draft"]);

        const retry = await attempt(files); // same keys
        if (retry.submit.kind !== "committed") throw new Error("x");
        expect(expenses.size).toBe(1); // no duplicate expense
        expect(expenses.get(retry.submit.receipt.expense_id)?.status).toBe("submitted");
      });

      for (const outcome of ["finalize_timeout", "abort_after_upload"] as const) {
        it(`${outcome}: file may already be stored; the retry re-attaches idempotently (one file) and submits once`, async () => {
          const { expenses, calls } = installFakeServer(mode);
          const files = new Set<string>();
          await expect(attempt(files, outcome)).rejects.toThrow();
          expect(calls.some((c) => c.fn === "submit_microlink_expense_v1")).toBe(false);
          expect(files.size).toBe(1); // the upload had landed

          const retry = await attempt(files);
          if (retry.submit.kind !== "committed") throw new Error("x");
          expect(files.size).toBe(1); // same destination path -> no duplicate
          expect(expenses.size).toBe(1);
          expect(expenses.get(retry.submit.receipt.expense_id)?.status).toBe("submitted");
          expect(calls.filter((c) => c.fn === "submit_microlink_expense_v1").length).toBe(1);
        });
      }

      it("the same attempt repeated after a SUCCESSFUL submit does not duplicate the expense or the file", async () => {
        const { expenses } = installFakeServer(mode);
        const files = new Set<string>();
        const first = await attempt(files);
        const second = await attempt(files);
        if (first.submit.kind !== "committed" || second.submit.kind !== "committed") throw new Error("x");
        expect(second.submit.receipt.expense_id).toBe(first.submit.receipt.expense_id);
        expect(second.submit.receipt.status).toBe("submitted");
        expect(expenses.size).toBe(1);
        expect(files.size).toBe(1);
      });

      it("multiple PDFs: all attached, the expense is submitted exactly once", async () => {
        const { expenses, calls } = installFakeServer(mode);
        const files = new Set<string>();
        const r = await attempt(files, "ok", ["a.pdf", "b.pdf", "c.pdf"]);
        if (r.submit.kind !== "committed") throw new Error("x");
        expect(files.size).toBe(3);
        expect(calls.filter((c) => c.fn === "submit_microlink_expense_v1").length).toBe(1);
        expect(expenses.get(r.submit.receipt.expense_id)?.status).toBe("submitted");
      });
    });
  }

  it("draft save rejected: nothing is attached and nothing is submitted", async () => {
    const reports: string[] = [];
    await expect(
      prepareAttachFirstSubmit(baseSnapshot(), DRAFT_KEY, {
        saveDraft: async () => ({ kind: "rejected", code: "PW003", message: "bad project", conflict: false }),
        attachFiles: async () => {
          throw new Error("must not attach");
        },
        onFailure: (stage) => reports.push(stage),
      }),
    ).rejects.toThrow("bad project");
    expect(reports).toEqual(["draft_save"]);
  });

  it("draft outcome unknown: the form is told nothing was submitted and no files are attached", async () => {
    await expect(
      prepareAttachFirstSubmit(baseSnapshot(), DRAFT_KEY, {
        saveDraft: async () => ({ kind: "unknown", message: "?" }),
        attachFiles: async () => {
          throw new Error("must not attach");
        },
        onFailure: () => undefined,
      }),
    ).rejects.toThrow(/Nothing was submitted/);
  });
});

describe("guards on the real sources", () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("ExpenseForm routes the draft step through its own key and refuses to announce an unsubmitted receipt", () => {
    const src = read("src/pages/ExpenseForm.tsx");
    expect(src).toMatch(/prepareAttachFirstSubmit\(snapshot,\s*draftAttemptKeyRef\.current/);
    expect(src).toMatch(/unsubmittedReceiptMessage\(outcome\.receipt\)/);
    expect(src).toMatch(/submitMicroLinkExpense\(workingSnapshot\)/);
    expect(src).toMatch(/semanticMismatchTags\(/);
  });

  it("the attach-first module never reuses the submit key for the draft", () => {
    const src = read("src/services/microlinkAttachFirstFlow.ts");
    expect(src).toMatch(/snapshotWithIdempotencyKey\(snapshot,\s*draftKey\)/);
  });

  it("migration 20261007120000 makes receipt identity (key, action) and scopes replay by the requested action", () => {
    const sql = read("supabase/migrations/20261007120000_microlink_receipts_action_scoped_idempotency.sql");
    expect(sql).toMatch(/PRIMARY KEY \(idempotency_key, action\)/);
    expect(sql).toMatch(/WHERE idempotency_key = v_key AND action = p_action/);
    for (const k of ["requested_action", "receipt_action", "actual_status", "idempotency_result"]) {
      expect(sql).toContain(`'${k}'`);
    }
    // cross-user guard preserved
    expect(sql).toMatch(/r\.idempotency_key = v_key AND r\.user_id <> v_uid/);
    // action-aware lookup, not callable by anon
    expect(sql).toMatch(/get_expense_submission_result_v1\(uuid, text\) FROM PUBLIC/);
    expect(sql).not.toMatch(/TO anon/);
  });

  it("the ORIGINAL replay block (kept as history) answered by key alone", () => {
    const sql = read("supabase/migrations/20260909100000_microlink_atomic_submission_v1.sql");
    const replay = sql.slice(sql.indexOf("IDEMPOTENCY, answered before anything is written"));
    const block = replay.slice(0, replay.indexOf("AUTHORIZATION"));
    expect(block).toMatch(/WHERE idempotency_key = v_key/);
    expect(block).not.toMatch(/v_receipt\.action/);
  });
});
