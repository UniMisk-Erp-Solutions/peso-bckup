import { describe, expect, it } from "vitest";
import { finalizeOneReceipt, type StorageBucketLike } from "../../../supabase/functions/finalize-expense-receipts/finalizeReceipt";

/** In-memory storage that counts every operation, so "how many times is the file read/written" is asserted, not assumed. */
function memoryBucket(opts: { temp?: string[]; failCopy?: boolean; failUpload?: boolean; failDownload?: boolean } = {}) {
  const objects = new Map<string, number>(); // path -> size
  for (const t of opts.temp ?? []) objects.set(t, 1_000_000);
  const ops = { list: 0, copy: 0, download: 0, upload: 0, bytesThroughFunction: 0 };
  const bucket: StorageBucketLike = {
    async list(path, o) {
      ops.list++;
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const data = [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k.slice(prefix.length) }))
        .filter((f) => !o?.search || f.name.includes(o.search));
      return { data, error: null };
    },
    async copy(from, to) {
      ops.copy++;
      if (opts.failCopy || !objects.has(from)) return { error: { message: "copy rejected" } };
      objects.set(to, objects.get(from)!);
      return { data: {}, error: null };
    },
    async download(path) {
      ops.download++;
      if (opts.failDownload || !objects.has(path)) return { data: null, error: { message: "not found" } };
      ops.bytesThroughFunction += objects.get(path)!;
      return { data: new Blob([new Uint8Array(4)]), error: null };
    },
    async upload(path) {
      ops.upload++;
      if (opts.failUpload) return { error: { message: "upload failed" } };
      objects.set(path, 1_000_000);
      ops.bytesThroughFunction += 1_000_000;
      return { error: null };
    },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://files.example/${path}` } }),
  };
  return { bucket, objects, ops };
}

const P = { expenseId: "exp1", userId: "u1", filename: "1-a.jpg", contentType: "image/jpeg" };

describe("finalize receipt: one canonical final object, no redundant byte copies", () => {
  it("normal path: server-side copy, ZERO bytes through the function, no download or upload", async () => {
    const m = memoryBucket({ temp: ["temp/u1/1-a.jpg"] });
    const r = await finalizeOneReceipt(m.bucket, P);
    expect(r).toMatchObject({ status: "finalized", resolvedPath: "exp1/1-a.jpg", method: "copy" });
    expect(r.fileUrl).toBe("https://files.example/exp1/1-a.jpg");
    expect(m.ops).toMatchObject({ copy: 1, download: 0, upload: 0, bytesThroughFunction: 0 });
    expect(m.ops.list).toBe(2); // probe + confirm
    expect(m.objects.has("exp1/1-a.jpg")).toBe(true);
  });

  it("BEFORE (documented): download + upload + verify moved the file through the function 3 times", async () => {
    const m = memoryBucket({ temp: ["temp/u1/1-a.jpg"], failCopy: true });
    const r = await finalizeOneReceipt(m.bucket, P);
    expect(r.method).toBe("download_upload");
    expect(m.ops.download).toBe(2);
    expect(m.ops.upload).toBe(1);
    expect(m.ops.bytesThroughFunction).toBeGreaterThanOrEqual(2_000_000);
  });

  it("a retry after a lost response finds the object already in place and does nothing", async () => {
    const m = memoryBucket({ temp: ["temp/u1/1-a.jpg"] });
    await finalizeOneReceipt(m.bucket, P);
    const copiesBefore = m.ops.copy;
    const again = await finalizeOneReceipt(m.bucket, P);
    expect(again).toMatchObject({ status: "finalized", method: "already_present" });
    expect(m.ops.copy).toBe(copiesBefore);
  });

  it("if copy is rejected the proven download/upload path still finalizes (no lost receipt)", async () => {
    const m = memoryBucket({ temp: ["temp/u1/1-a.jpg"], failCopy: true });
    const r = await finalizeOneReceipt(m.bucket, P);
    expect(r.status).toBe("finalized");
    expect(m.objects.has("exp1/1-a.jpg")).toBe(true);
  });

  it("source missing everywhere: a clear failure, never a fake success", async () => {
    const m = memoryBucket({ temp: [] });
    const r = await finalizeOneReceipt(m.bucket, P);
    expect(r.status).toBe("failed");
    expect(r.resolvedPath).toBeNull();
  });

  it("copy and write both impossible but the temp object exists: temporary_fallback keeps the receipt usable", async () => {
    const m = memoryBucket({ temp: ["temp/u1/1-a.jpg"], failCopy: true, failUpload: true });
    const r = await finalizeOneReceipt(m.bucket, P);
    expect(r.status).toBe("temporary_fallback");
    expect(r.resolvedPath).toBe("temp/u1/1-a.jpg");
  });

  it("never touches another user's temp folder", async () => {
    const m = memoryBucket({ temp: ["temp/u2/1-a.jpg"] });
    const r = await finalizeOneReceipt(m.bucket, P);
    expect(r.status).toBe("failed");
    expect(m.objects.has("exp1/1-a.jpg")).toBe(false);
  });
});
