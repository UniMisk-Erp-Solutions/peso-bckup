import { describe, it, expect } from "vitest";
import {
  attachmentRowObjectName,
  buildFinalizeManifest,
  finalizeAndLinkReceipts,
  planAttachmentReconciliation,
  reconcileExpenseAttachments,
  registerUploadedAttachment,
  removeAttachmentFromSessionRegistries,
  type SessionReceiptRegistries,
  type SessionTempMeta,
} from "@/lib/expenseAttachmentManifest";
import { FakeReceiptBackend } from "@/test/fakeReceiptBackend";

const USER = "user-1";
const ORG = "org-1";
const urlFor = (name: string) => `https://files.test/storage/v1/object/public/receipts/temp/${USER}/${name}`;

function newRegistries(): SessionReceiptRegistries & { meta: Map<string, SessionTempMeta> } {
  return { tempNames: new Set(), meta: new Map(), pathByUrl: new Map(), blobs: new Map() };
}

describe("buildFinalizeManifest — derived only from the visible attachment set", () => {
  it("returns exactly the temp names of the visible URLs, in order, without duplicates", () => {
    const urls = [urlFor("a.jpg"), urlFor("b.jpg"), urlFor("a.jpg")];
    expect(buildFinalizeManifest({ userId: USER, visibleUrls: urls })).toEqual(["a.jpg", "b.jpg"]);
  });

  it("does not include a file whose URL is no longer visible, even if a registry still knows it", () => {
    const regs = newRegistries();
    for (const name of ["a.jpg", "b.jpg", "c.jpg"]) {
      registerUploadedAttachment(regs, { url: urlFor(name), storagePath: name, filename: name }, USER);
    }
    // The employee removed b.jpg from the form; the old, append-only registry still lists it.
    expect(Array.from(regs.tempNames)).toContain("b.jpg");
    const manifest = buildFinalizeManifest({
      userId: USER,
      visibleUrls: [urlFor("a.jpg"), urlFor("c.jpg")],
      pathByUrl: regs.pathByUrl,
    });
    expect(manifest).toEqual(["a.jpg", "c.jpg"]);
  });

  it("skips URLs that already have an attachment row", () => {
    const manifest = buildFinalizeManifest({
      userId: USER,
      visibleUrls: [urlFor("a.jpg"), urlFor("b.jpg")],
      persistedUrls: new Set([urlFor("a.jpg")]),
    });
    expect(manifest).toEqual(["b.jpg"]);
  });

  it("uses the recorded path for a URL that does not carry the temp path", () => {
    const pathByUrl = new Map([["https://cdn.test/opaque/xyz", "real-name.pdf"]]);
    expect(
      buildFinalizeManifest({ userId: USER, visibleUrls: ["https://cdn.test/opaque/xyz"], pathByUrl }),
    ).toEqual(["real-name.pdf"]);
  });

  it("is empty when nothing is visible", () => {
    expect(buildFinalizeManifest({ userId: USER, visibleUrls: [] })).toEqual([]);
  });
});

describe("removeAttachmentFromSessionRegistries", () => {
  it("forgets the file in every registry and leaves the others alone", () => {
    const regs = newRegistries();
    const blob = new Blob(["x"]);
    for (const name of ["a.jpg", "b.jpg"]) {
      registerUploadedAttachment(
        regs,
        { url: urlFor(name), storagePath: name, filename: name, fileSize: 10, contentType: "image/jpeg", blob },
        USER,
      );
    }
    const removed = removeAttachmentFromSessionRegistries(regs, {
      url: urlFor("a.jpg"),
      storagePath: "a.jpg",
      userId: USER,
    });
    expect(removed).toContain("a.jpg");
    expect(Array.from(regs.tempNames)).toEqual(["b.jpg"]);
    expect(Array.from(regs.meta.keys())).toEqual(["b.jpg"]);
    expect(Array.from(regs.blobs.keys())).toEqual(["b.jpg"]);
    expect(Array.from(regs.pathByUrl.keys())).toEqual([urlFor("b.jpg")]);
  });

  it("removes by URL alone when the storage path is unknown (restored draft)", () => {
    const regs = newRegistries();
    regs.tempNames.add("a.jpg");
    regs.meta.set("a.jpg", { filename: "a.jpg", file_size: 1, content_type: "image/jpeg" });
    removeAttachmentFromSessionRegistries(regs, { url: urlFor("a.jpg"), userId: USER });
    expect(regs.tempNames.size).toBe(0);
    expect(regs.meta.size).toBe(0);
  });
});

describe("planAttachmentReconciliation", () => {
  const row = (id: string, name: string, at: string, extra: object = {}) => ({
    id,
    storage_path: `exp-1/${name}`,
    created_at: at,
    ...extra,
  });

  it("removes rows for files that are no longer wanted and keeps the rest", () => {
    const plan = planAttachmentReconciliation(
      [row("1", "a.jpg", "2026-01-01"), row("2", "b.jpg", "2026-01-02"), row("3", "c.jpg", "2026-01-03")],
      ["a.jpg", "c.jpg"],
    );
    expect(plan.keepIds).toEqual(["1", "3"]);
    expect(plan.removeIds).toEqual(["2"]);
  });

  it("keeps the oldest row of a duplicated file and removes the later ones", () => {
    const plan = planAttachmentReconciliation(
      [row("2", "a.jpg", "2026-01-02"), row("1", "a.jpg", "2026-01-01"), row("3", "a.jpg", "2026-01-03")],
      ["a.jpg"],
    );
    expect(plan.keepIds).toEqual(["1"]);
    expect(plan.removeIds).toEqual(["2", "3"]);
  });

  it("ignores rows that are already soft-deleted", () => {
    const plan = planAttachmentReconciliation(
      [row("1", "a.jpg", "2026-01-01", { deleted_at: "2026-02-01" }), row("2", "a.jpg", "2026-01-02")],
      ["a.jpg"],
    );
    expect(plan.keepIds).toEqual(["2"]);
    expect(plan.removeIds).toEqual([]);
  });

  it("never touches a row whose object cannot be identified", () => {
    const plan = planAttachmentReconciliation([{ id: "1", storage_path: null, file_url: "" }], []);
    expect(plan.keepIds).toEqual(["1"]);
    expect(plan.removeIds).toEqual([]);
  });

  it("identifies the object from the storage path, else from the URL", () => {
    expect(attachmentRowObjectName({ id: "1", storage_path: "exp/x%20y.jpg" })).toBe("x y.jpg");
    expect(attachmentRowObjectName({ id: "1", file_url: "https://h/receipts/exp/a.jpg?t=1" })).toBe("a.jpg");
    expect(attachmentRowObjectName({ id: "1" })).toBe("");
  });
});

describe("finalizeAndLinkReceipts + reconcileExpenseAttachments (fake backend)", () => {
  const meta = (names: string[]) =>
    new Map<string, SessionTempMeta>(
      names.map((n) => [n, { filename: `orig-${n}`, file_size: 100, content_type: "image/jpeg" }]),
    );

  it("sends exactly the manifest to finalize and inserts exactly one row per file", async () => {
    const be = new FakeReceiptBackend(USER);
    const manifest = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];
    const results = await finalizeAndLinkReceipts(be.client() as never, {
      expenseId: "exp-1",
      organizationId: ORG,
      userId: USER,
      manifest,
      meta: meta(manifest),
    });
    expect(be.finalizeCalls).toHaveLength(1);
    expect(be.finalizeCalls[0].receipts.map((r) => r.filename)).toEqual(manifest);
    expect(results.every((r) => r.status === "finalized")).toBe(true);
    expect(be.activeRows("exp-1")).toHaveLength(4);
    expect(be.activeRows("exp-1").map((r) => r.storage_path)).toEqual(manifest.map((n) => `exp-1/${n}`));
  });

  it("an empty manifest finalizes nothing and inserts nothing", async () => {
    const be = new FakeReceiptBackend(USER);
    await finalizeAndLinkReceipts(be.client() as never, {
      expenseId: "exp-1",
      organizationId: ORG,
      userId: USER,
      manifest: [],
      meta: new Map(),
    });
    expect(be.activeRows("exp-1")).toHaveLength(0);
  });

  it("reconcile unlinks stale and duplicate rows (metadata only) and keeps the intended set", async () => {
    const be = new FakeReceiptBackend(USER);
    const first = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg", "f.jpg"];
    await finalizeAndLinkReceipts(be.client() as never, {
      expenseId: "exp-1", organizationId: ORG, userId: USER, manifest: first, meta: meta(first),
    });
    expect(be.activeRows("exp-1")).toHaveLength(6);

    // Retry of the same draft after the employee removed e.jpg and f.jpg.
    const second = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];
    await finalizeAndLinkReceipts(be.client() as never, {
      expenseId: "exp-1", organizationId: ORG, userId: USER, manifest: second, meta: meta(second),
    });
    expect(be.activeRows("exp-1")).toHaveLength(10); // 6 + 4 duplicates, before reconcile

    const out = await reconcileExpenseAttachments(be.client() as never, {
      expenseId: "exp-1", organizationId: ORG, wantedNames: second,
    });
    expect(out.removed).toBe(6); // 4 duplicates + 2 stale
    const active = be.activeRows("exp-1");
    expect(active).toHaveLength(4);
    expect(active.map((r) => r.storage_path).sort()).toEqual(second.map((n) => `exp-1/${n}`));
    // soft delete only: rows retained, no object removed
    expect(be.attachments).toHaveLength(10);
    expect(be.objects.has("exp-1/e.jpg")).toBe(true);
  });
});
