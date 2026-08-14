import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  invokeFinalizeExpenseReceipts,
  runWithConcurrency,
  type ReceiptFinalizationResult,
} from "@/lib/receiptFinalization";

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

type InvokeFn = (fnName: string, opts: { body: unknown }) => Promise<{ data: unknown; error: unknown }>;

function makeSupabaseMock(invoke: InvokeFn) {
  return {
    functions: { invoke },
    storage: {
      from: () => ({
        // These must never be called when the EF path is taken.
        move: vi.fn(() => { throw new Error("storage.move must not be called from browser"); }),
        copy: vi.fn(() => { throw new Error("storage.copy must not be called from browser"); }),
        createSignedUrl: vi.fn(() => { throw new Error("storage.createSignedUrl must not be called from browser"); }),
        download: vi.fn(() => { throw new Error("storage.download must not be called from browser"); }),
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
  receipts: [{ filename: "photo.jpg", contentType: "image/jpeg", fileSize: 12345 }],
};

function efSuccess(results: Partial<ReceiptFinalizationResult>[]): ReturnType<InvokeFn> {
  return Promise.resolve({ data: { results }, error: null });
}

function efError(message: string): ReturnType<InvokeFn> {
  return Promise.resolve({ data: null, error: { message } });
}

// ---------------------------------------------------------------------------
// 1. invokeFinalizeExpenseReceipts calls functions.invoke, NOT storage methods
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — EF invocation", () => {
  it("calls supabase.functions.invoke with expenseId and receipts", async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        results: [
          {
            filename: "photo.jpg",
            sourcePath: "temp/u1/photo.jpg",
            desiredFinalPath: "exp1/photo.jpg",
            resolvedPath: "exp1/photo.jpg",
            status: "finalized",
            fileUrl: "https://example.com/receipts/exp1/photo.jpg",
          },
        ],
      },
      error: null,
    });
    const supabase = makeSupabaseMock(invoke);

    await invokeFinalizeExpenseReceipts(supabase, BASE);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("finalize-expense-receipts", {
      body: { expenseId: "exp1", receipts: BASE.receipts },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Bare filename guard — reflected in the EF's returned status
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — path guard reflected in results", () => {
  it("maps EF 'failed' result (invalid filename) to failed status", async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        results: [
          {
            filename: "temp/u1/bad.jpg",
            sourcePath: "",
            desiredFinalPath: "",
            resolvedPath: null,
            status: "failed",
            errorMessage: "filename must be a bare filename without path separators or URL scheme",
          },
        ],
      },
      error: null,
    });
    const supabase = makeSupabaseMock(invoke);

    const results = await invokeFinalizeExpenseReceipts(supabase, {
      ...BASE,
      receipts: [{ filename: "temp/u1/bad.jpg" }],
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].errorMessage).toMatch(/bare filename/i);
  });
});

// ---------------------------------------------------------------------------
// 3. EF returns "finalized" → mapped to ReceiptFinalizationResult correctly
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — EF finalized result", () => {
  it("maps EF 'finalized' result with correct paths and fileUrl", async () => {
    const supabase = makeSupabaseMock(() =>
      efSuccess([
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
    expect(results[0].fileUrl).toContain("exp1/photo.jpg");
    expect(results[0].fileUrl).not.toContain("temp/");
  });
});

// ---------------------------------------------------------------------------
// 4. EF returns "temporary_fallback" → mapped correctly
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — EF temporary_fallback result", () => {
  it("maps EF 'temporary_fallback' with sourcePath as resolvedPath", async () => {
    const supabase = makeSupabaseMock(() =>
      efSuccess([
        {
          filename: "photo.jpg",
          sourcePath: "temp/u1/photo.jpg",
          desiredFinalPath: "exp1/photo.jpg",
          resolvedPath: "temp/u1/photo.jpg",
          status: "temporary_fallback",
          fileUrl: "https://cdn.example.com/receipts/temp/u1/photo.jpg",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);

    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].resolvedPath).toBe("temp/u1/photo.jpg");
  });
});

// ---------------------------------------------------------------------------
// 5. EF returns "failed" → resolvedPath is null, no fileUrl
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — EF failed result", () => {
  it("maps EF 'failed' to null resolvedPath and no fileUrl", async () => {
    const supabase = makeSupabaseMock(() =>
      efSuccess([
        {
          filename: "photo.jpg",
          sourcePath: "temp/u1/photo.jpg",
          desiredFinalPath: "exp1/photo.jpg",
          resolvedPath: null,
          status: "failed",
          errorMessage: "Source file not found",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);

    expect(results[0].status).toBe("failed");
    expect(results[0].resolvedPath).toBeNull();
    expect(results[0].fileUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. cachedBlob enriched from blobCache for "finalized" results
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — blob cache enrichment (finalized)", () => {
  it("populates cachedBlob from blobCache for finalized results", async () => {
    const blob = new Blob(["bytes"], { type: "image/jpeg" });
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      efSuccess([
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
});

// ---------------------------------------------------------------------------
// 7. cachedBlob enriched from blobCache for "temporary_fallback" results
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — blob cache enrichment (fallback)", () => {
  it("populates cachedBlob from blobCache for temporary_fallback results", async () => {
    const blob = new Blob(["bytes"], { type: "image/jpeg" });
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() =>
      efSuccess([
        {
          filename: "photo.jpg",
          sourcePath: "temp/u1/photo.jpg",
          desiredFinalPath: "exp1/photo.jpg",
          resolvedPath: "temp/u1/photo.jpg",
          status: "temporary_fallback",
          fileUrl: "https://cdn.example.com/receipts/temp/u1/photo.jpg",
        },
      ]),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });

    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].cachedBlob).toBe(blob);
  });
});

// ---------------------------------------------------------------------------
// 8. EF unavailable (error) → synthetic "temporary_fallback" when blob cached
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — EF error with blob cache", () => {
  it("returns 'temporary_fallback' at temp path when EF errors and blob is cached", async () => {
    const blob = new Blob(["bytes"]);
    const blobCache = new Map([["photo.jpg", blob]]);
    const supabase = makeSupabaseMock(() => efError("Gateway timeout"));

    const results = await invokeFinalizeExpenseReceipts(supabase, { ...BASE, blobCache });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("temporary_fallback");
    expect(results[0].resolvedPath).toBe("temp/u1/photo.jpg");
    expect(results[0].cachedBlob).toBe(blob);
  });
});

// ---------------------------------------------------------------------------
// 9. EF unavailable → "failed" when no blob in cache
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — EF error without blob cache", () => {
  it("returns 'failed' when EF errors and no blob is cached", async () => {
    const supabase = makeSupabaseMock(() => efError("Connection refused"));

    const results = await invokeFinalizeExpenseReceipts(supabase, BASE);

    expect(results[0].status).toBe("failed");
    expect(results[0].resolvedPath).toBeNull();
    expect(results[0].cachedBlob).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. No storage.move / copy / createSignedUrl / download called on EF success
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — no browser storage calls", () => {
  it("does not call storage.move/copy/createSignedUrl/download when EF succeeds", async () => {
    const moveSpy = vi.fn();
    const copySpy = vi.fn();
    const signedUrlSpy = vi.fn();
    const downloadSpy = vi.fn();

    const supabase = {
      functions: {
        invoke: () =>
          efSuccess([
            {
              filename: "photo.jpg",
              sourcePath: "temp/u1/photo.jpg",
              desiredFinalPath: "exp1/photo.jpg",
              resolvedPath: "exp1/photo.jpg",
              status: "finalized",
              fileUrl: "https://cdn.example.com/receipts/exp1/photo.jpg",
            },
          ]),
      },
      storage: {
        from: () => ({
          move: moveSpy,
          copy: copySpy,
          createSignedUrl: signedUrlSpy,
          download: downloadSpy,
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example.com/${path}` } }),
        }),
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    await invokeFinalizeExpenseReceipts(supabase, BASE);

    expect(moveSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    expect(signedUrlSpy).not.toHaveBeenCalled();
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11. No storage calls on EF failure either — fallback is pure in-memory
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — no browser storage calls on EF failure", () => {
  it("does not call any storage method when EF fails (fallback is in-memory)", async () => {
    const moveSpy = vi.fn();
    const copySpy = vi.fn();
    const signedUrlSpy = vi.fn();
    const downloadSpy = vi.fn();
    const blob = new Blob(["bytes"]);

    const supabase = {
      functions: { invoke: () => efError("Network error") },
      storage: {
        from: () => ({
          move: moveSpy,
          copy: copySpy,
          createSignedUrl: signedUrlSpy,
          download: downloadSpy,
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example.com/${path}` } }),
        }),
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    await invokeFinalizeExpenseReceipts(supabase, {
      ...BASE,
      blobCache: new Map([["photo.jpg", blob]]),
    });

    expect(moveSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    expect(signedUrlSpy).not.toHaveBeenCalled();
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 12. runWithConcurrency — 7 tasks with concurrency 2, results in order
// ---------------------------------------------------------------------------
describe("runWithConcurrency", () => {
  it("runs 7 tasks with concurrency limit 2 and returns all results in order", async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      order.push(i);
      return i * 2;
    });

    const results = await runWithConcurrency(tasks, 2);
    expect(results).toHaveLength(7);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(order.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// 13. Multiple receipts: EF results in correct order
// ---------------------------------------------------------------------------
describe("invokeFinalizeExpenseReceipts — multiple receipts in order", () => {
  it("returns results in the same order as the input receipts array", async () => {
    const filenames = ["a.jpg", "b.jpg", "c.jpg"];
    const receipts = filenames.map((filename) => ({ filename }));
    const supabase = makeSupabaseMock(() =>
      efSuccess(
        filenames.map((filename) => ({
          filename,
          sourcePath: `temp/u1/${filename}`,
          desiredFinalPath: `exp1/${filename}`,
          resolvedPath: `exp1/${filename}`,
          status: "finalized",
          fileUrl: `https://cdn.example.com/receipts/exp1/${filename}`,
        })),
      ),
    );

    const results = await invokeFinalizeExpenseReceipts(supabase, {
      expenseId: "exp1",
      userId: "u1",
      receipts,
    });

    expect(results.map((r) => r.filename)).toEqual(filenames);
    expect(results.every((r) => r.status === "finalized")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. movedCount / tempFallbackCount / failedCount accounting
// ---------------------------------------------------------------------------
describe("finalizationResult accounting", () => {
  it("movedCount ignores temporary_fallback and failed — only finalized counts", () => {
    const results: ReceiptFinalizationResult[] = [
      { sourcePath: "s", desiredFinalPath: "d", resolvedPath: "d", status: "finalized", filename: "a.jpg" },
      { sourcePath: "s", desiredFinalPath: "d", resolvedPath: "s", status: "temporary_fallback", filename: "b.jpg", cachedBlob: new Blob() },
      { sourcePath: "s", desiredFinalPath: "d", resolvedPath: null, status: "failed", filename: "c.jpg" },
    ];
    const movedCount = results.filter((r) => r.status === "finalized").length;
    const tempFallbackCount = results.filter((r) => r.status === "temporary_fallback").length;
    const failedCount = results.filter((r) => r.status === "failed").length;
    expect(movedCount).toBe(1);
    expect(tempFallbackCount).toBe(1);
    expect(failedCount).toBe(1);
  });
});
