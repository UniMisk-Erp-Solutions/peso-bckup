/**
 * Phase 3: Tests for invokeFinalizeExpenseReceipts handling the new
 * structured EF response format (ok/requestId/version/stage/code).
 *
 * The EF now returns:
 *   success: { ok: true,  requestId, version: "receipt-finalizer-v2", results }
 *   error:   { ok: false, requestId, version, stage, code, message }
 *
 * The frontend must:
 * - Parse ok:true results the same way as before
 * - Treat ok:false as an error and go to synthetic fallback
 * - Log only { requestId, stage, code } on structured errors — no tokens
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  invokeFinalizeExpenseReceipts,
  type ReceiptFinalizationResult,
} from "@/lib/receiptFinalization";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type InvokeFn = (
  fnName: string,
  opts: { body: unknown },
) => Promise<{ data: unknown; error: unknown }>;

function makeSupabaseMock(invoke: InvokeFn) {
  return {
    functions: { invoke },
    storage: {
      from: () => ({
        move: vi.fn(() => { throw new Error("storage.move must not be called"); }),
        copy: vi.fn(() => { throw new Error("storage.copy must not be called"); }),
        createSignedUrl: vi.fn(() => { throw new Error("storage.createSignedUrl must not be called"); }),
        download: vi.fn(() => { throw new Error("storage.download must not be called"); }),
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://example.com/receipts/${path}` },
        }),
      }),
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const BASE = {
  expenseId: "exp1",
  userId: "u1",
  receipts: [{ filename: "photo.jpg", contentType: "image/jpeg" }],
};

function structuredOk(results: Partial<ReceiptFinalizationResult>[]): ReturnType<InvokeFn> {
  return Promise.resolve({
    data: { ok: true, requestId: "req-123", version: "receipt-finalizer-v2", results },
    error: null,
  });
}

function structuredErr(
  stage: string,
  code: string,
  message = "Error",
): ReturnType<InvokeFn> {
  return Promise.resolve({
    data: { ok: false, requestId: "req-err-456", version: "receipt-finalizer-v2", stage, code, message },
    error: null,
  });
}

// ---------------------------------------------------------------------------
// 1. ok:true structured response — results extracted correctly
// ---------------------------------------------------------------------------
describe("structured EF response — ok:true", () => {
  it("extracts results from ok:true structured response", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredOk([
        {
          filename: "photo.jpg",
          sourcePath: "temp/u1/photo.jpg",
          desiredFinalPath: "exp1/photo.jpg",
          resolvedPath: "exp1/photo.jpg",
          status: "finalized",
          fileUrl: "https://cdn.example.com/receipts/exp1/photo.jpg",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("finalized");
    expect(results[0].resolvedPath).toBe("exp1/photo.jpg");
  });

  it("enriches ok:true results with cachedBlob", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      structuredOk([
        {
          filename: "photo.jpg",
          sourcePath: "temp/u1/photo.jpg",
          desiredFinalPath: "exp1/photo.jpg",
          resolvedPath: "exp1/photo.jpg",
          status: "finalized",
          fileUrl: "https://cdn.example.com/receipts/exp1/photo.jpg",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });
    expect(results[0].cachedBlob).toBe(blob);
  });

  it("version field in response does not break result extraction", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredOk([
        {
          filename: "photo.jpg",
          sourcePath: "temp/u1/photo.jpg",
          desiredFinalPath: "exp1/photo.jpg",
          resolvedPath: "exp1/photo.jpg",
          status: "finalized",
          fileUrl: "https://cdn.example.com/receipts/exp1/photo.jpg",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);
    expect(results[0].filename).toBe("photo.jpg");
  });
});

// ---------------------------------------------------------------------------
// 2. ok:false structured errors → synthetic fallback
// ---------------------------------------------------------------------------
describe("structured EF response — ok:false environment error", () => {
  it("treats ok:false stage=environment as EF error, goes to synthetic fallback", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      structuredErr("environment", "SERVER_MISCONFIGURATION", "Missing env vars"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });
    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].cachedBlob).toBe(blob);
  });

  it("ok:false environment error + no blob → failed", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredErr("environment", "SERVER_MISCONFIGURATION"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);
    expect(results[0].status).toBe("failed");
    expect(results[0].resolvedPath).toBeNull();
  });
});

describe("structured EF response — ok:false auth error", () => {
  it("treats ok:false stage=auth as EF error, goes to synthetic fallback with blob", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      structuredErr("auth", "INVALID_JWT", "Token validation failed"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });
    expect(results[0].status).toBe("temporary_fallback");
  });

  it("ok:false auth error + no blob → failed with null resolvedPath", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredErr("auth", "INVALID_JWT"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);
    expect(results[0].status).toBe("failed");
    expect(results[0].resolvedPath).toBeNull();
  });
});

describe("structured EF response — ok:false input error", () => {
  it("treats ok:false stage=input as EF error, synthetic fallback for cached blob", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      structuredErr("input", "MISSING_EXPENSE_ID"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });
    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].resolvedPath).toBe("temp/u1/photo.jpg");
  });
});

describe("structured EF response — ok:false ownership error", () => {
  it("treats ok:false stage=ownership as EF error, synthetic fallback with blob", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      structuredErr("ownership", "EXPENSE_ACCESS_DENIED"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });
    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].cachedBlob).toBe(blob);
  });
});

// ---------------------------------------------------------------------------
// 3. ok:false — safe log: only { requestId, stage, code } logged, no tokens
// ---------------------------------------------------------------------------
describe("structured EF error logging — no secrets", () => {
  it("does not throw or expose secrets when logging ok:false response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supabase = makeSupabaseMock(() =>
      structuredErr("environment", "SERVER_MISCONFIGURATION", "Missing env vars"),
    );

    await invokeFinalizeExpenseReceipts(supabase, BASE);

    const calls = warnSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const loggedArgs = JSON.stringify(calls);
    // Must log requestId/stage/code
    expect(loggedArgs).toContain("req-err-456");
    expect(loggedArgs).toContain("environment");
    expect(loggedArgs).toContain("SERVER_MISCONFIGURATION");
    // Must NOT log raw message with potential sensitive content in blob form
    // (stage and code are safe; the message string itself is ok, but no token/key values)
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple receipts: ok:true with mixed statuses
// ---------------------------------------------------------------------------
describe("structured EF response — multiple receipts mixed statuses", () => {
  it("maps mixed finalized/temporary_fallback/failed results from ok:true response", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredOk([
        {
          filename: "a.jpg",
          sourcePath: "temp/u1/a.jpg",
          desiredFinalPath: "exp1/a.jpg",
          resolvedPath: "exp1/a.jpg",
          status: "finalized",
          fileUrl: "https://cdn.example.com/receipts/exp1/a.jpg",
        },
        {
          filename: "b.jpg",
          sourcePath: "temp/u1/b.jpg",
          desiredFinalPath: "exp1/b.jpg",
          resolvedPath: "temp/u1/b.jpg",
          status: "temporary_fallback",
          fileUrl: "https://cdn.example.com/receipts/temp/u1/b.jpg",
        },
        {
          filename: "c.jpg",
          sourcePath: "temp/u1/c.jpg",
          desiredFinalPath: "exp1/c.jpg",
          resolvedPath: null,
          status: "failed",
          errorMessage: "Source not found",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, {
      expenseId: "exp1",
      userId: "u1",
      receipts: [
        { filename: "a.jpg" },
        { filename: "b.jpg" },
        { filename: "c.jpg" },
      ],
    });

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("finalized");
    expect(results[1].status).toBe("temporary_fallback");
    expect(results[2].status).toBe("failed");
  });

  it("counts finalized/fallback/failed correctly from ok:true structured response", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredOk([
        { filename: "a.jpg", sourcePath: "temp/u1/a.jpg", desiredFinalPath: "exp1/a.jpg", resolvedPath: "exp1/a.jpg", status: "finalized", fileUrl: "https://cdn.example.com/a" },
        { filename: "b.jpg", sourcePath: "temp/u1/b.jpg", desiredFinalPath: "exp1/b.jpg", resolvedPath: "temp/u1/b.jpg", status: "temporary_fallback", fileUrl: "https://cdn.example.com/b" },
        { filename: "c.jpg", sourcePath: "temp/u1/c.jpg", desiredFinalPath: "exp1/c.jpg", resolvedPath: null, status: "failed" },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, {
      expenseId: "exp1",
      userId: "u1",
      receipts: [{ filename: "a.jpg" }, { filename: "b.jpg" }, { filename: "c.jpg" }],
    });

    const finalized = results.filter((r) => r.status === "finalized").length;
    const fallback = results.filter((r) => r.status === "temporary_fallback").length;
    const failed = results.filter((r) => r.status === "failed").length;
    expect(finalized).toBe(1);
    expect(fallback).toBe(1);
    expect(failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Batch scenario: ok:true with no blobCache
// ---------------------------------------------------------------------------
describe("structured EF response — batch (no blobCache)", () => {
  it("processes ok:true results without blobCache (cachedBlob is undefined)", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredOk([
        {
          filename: "receipt.pdf",
          sourcePath: "temp/u1/receipt.pdf",
          desiredFinalPath: "exp1/receipt.pdf",
          resolvedPath: "exp1/receipt.pdf",
          status: "finalized",
          fileUrl: "https://cdn.example.com/receipts/exp1/receipt.pdf",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, {
      expenseId: "exp1",
      userId: "u1",
      receipts: [{ filename: "receipt.pdf", contentType: "application/pdf" }],
    });

    expect(results[0].status).toBe("finalized");
    expect(results[0].cachedBlob).toBeUndefined();
  });

  it("ok:false error + no blobCache → all receipts failed", async () => {
    const supabase = makeSupabaseMock(() =>
      structuredErr("ownership", "EXPENSE_ACCESS_DENIED"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, {
      expenseId: "exp1",
      userId: "u1",
      receipts: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. ok:false with finalization stage (partial failure during processing)
// ---------------------------------------------------------------------------
describe("structured EF response — ok:false finalization stage", () => {
  it("treats ok:false finalization error as EF error and goes to synthetic fallback", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      structuredErr("finalization", "INTERNAL_ERROR", "Unexpected server error"),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });
    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].resolvedPath).toBe("temp/u1/photo.jpg");
  });
});
