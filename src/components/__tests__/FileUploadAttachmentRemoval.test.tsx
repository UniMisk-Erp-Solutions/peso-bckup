/**
 * Removed attachments must never reappear after submission.
 *
 * The real FileUpload component runs against an in-memory Supabase fake. The
 * harness wires it exactly as ExpenseForm does - through the same library
 * functions (`registerUploadedAttachment`, `removeAttachmentFromSessionRegistries`,
 * `buildFinalizeManifest`, `finalizeAndLinkReceipts`, `reconcileExpenseAttachments`)
 * - and every assertion is on what was SENT to finalize and what was PERSISTED,
 * not on whether a call succeeded.
 *
 * The "legacy wiring" tests reproduce the incident: with no removal callback and
 * an append-only registry, every file ever uploaded is finalized and linked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { FileUpload } from "@/components/FileUpload";
import { useAuth } from "@/contexts/AuthContext";
import {
  buildFinalizeManifest,
  finalizeAndLinkReceipts,
  reconcileExpenseAttachments,
  registerUploadedAttachment,
  removeAttachmentFromSessionRegistries,
  type SessionReceiptRegistries,
  type SessionTempMeta,
} from "@/lib/expenseAttachmentManifest";
import { prepareAttachFirstSubmit } from "@/services/microlinkAttachFirstFlow";
import { FakeReceiptBackend } from "@/test/fakeReceiptBackend";

const H = vi.hoisted(() => ({ client: null as unknown as Record<string, unknown> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy({}, { get: (_t, key: string) => H.client[key] }),
}));

const USER = "test-user-id";
const ORG = "org-1";

type Session = {
  regs: SessionReceiptRegistries & { meta: Map<string, SessionTempMeta> };
  /** The form's canonical attachment list (what the employee sees). */
  visible: string[];
  removedCallbacks: number;
};

function newSession(): Session {
  return {
    regs: { tempNames: new Set(), meta: new Map(), pathByUrl: new Map(), blobs: new Map() },
    visible: [],
    removedCallbacks: 0,
  };
}

function Harness({
  session,
  wireRemoval = true,
  expenseId = "new",
  seed,
}: {
  session: Session;
  wireRemoval?: boolean;
  expenseId?: string;
  seed?: Parameters<typeof FileUpload>[0]["seedAttachments"];
}) {
  return (
    <FileUpload
      expenseId={expenseId}
      seedAttachments={seed}
      onUploadComplete={(att, blob) => {
        registerUploadedAttachment(
          session.regs,
          {
            url: att.file_url,
            storagePath: att.storage_path,
            filename: att.filename,
            fileSize: att.file_size,
            contentType: att.content_type,
            blob,
          },
          USER,
        );
        session.visible = [...session.visible, att.file_url];
      }}
      onAttachmentRemoved={
        wireRemoval
          ? (att) => {
              session.removedCallbacks += 1;
              removeAttachmentFromSessionRegistries(session.regs, {
                url: att.file_url,
                storagePath: att.storage_path,
                userId: USER,
              });
              session.visible = session.visible.filter((u) => u !== att.file_url);
            }
          : undefined
      }
    />
  );
}

const makeFiles = (n: number, opts: { type?: string; ext?: string; sameName?: boolean } = {}) =>
  Array.from(
    { length: n },
    (_, i) =>
      new File([`bytes-${i}`], `${opts.sameName ? "receipt" : `receipt-${i}`}.${opts.ext ?? "jpg"}`, {
        type: opts.type ?? "image/jpeg",
      }),
  );

function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

const listed = () => screen.queryAllByTestId("remove-attachment");
const waitForListed = (n: number) => waitFor(() => expect(listed()).toHaveLength(n));
/** Click remove on the i-th listed attachment and wait until it is gone. */
const removeAt = async (i: number) => {
  const before = listed().length;
  fireEvent.click(listed()[i]);
  await waitForListed(before - 1);
};

/** What ExpenseForm does at submit: manifest from the VISIBLE set -> finalize -> link. */
async function submitLikeForm(be: FakeReceiptBackend, s: Session, expenseId = "exp-1", reconcile = false) {
  const manifest = buildFinalizeManifest({
    userId: USER,
    visibleUrls: s.visible,
    pathByUrl: s.regs.pathByUrl,
  });
  s.regs.tempNames = new Set(manifest);
  await finalizeAndLinkReceipts(be.client() as never, {
    expenseId,
    organizationId: ORG,
    userId: USER,
    manifest,
    meta: s.regs.meta,
    blobCache: s.regs.blobs,
  });
  if (reconcile) {
    await reconcileExpenseAttachments(be.client() as never, {
      expenseId,
      organizationId: ORG,
      wantedNames: manifest,
    });
  }
  return manifest;
}

/** What the pre-fix form did: the append-only registry IS the manifest. */
async function submitLegacy(be: FakeReceiptBackend, s: Session, expenseId = "exp-1") {
  const manifest = Array.from(s.regs.tempNames);
  await finalizeAndLinkReceipts(be.client() as never, {
    expenseId,
    organizationId: ORG,
    userId: USER,
    manifest,
    meta: s.regs.meta,
    blobCache: s.regs.blobs,
  });
  return manifest;
}

const nameOf = (url: string) => url.split("/").pop() as string;

let be: FakeReceiptBackend;
beforeEach(() => {
  be = new FakeReceiptBackend(USER);
  H.client = be.client() as unknown as Record<string, unknown>;
});

describe("reproduction of the incident (legacy wiring)", () => {
  it("8 uploaded, 4 removed in the list -> the old form finalizes and links all 8", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} wireRemoval={false} />);
    pick(container, makeFiles(8));
    await waitForListed(8);

    for (let i = 0; i < 4; i += 1) await removeAt(0);
    await waitForListed(4); // the employee SEES 4

    const manifest = await submitLegacy(be, s);
    expect(manifest).toHaveLength(8);
    expect(be.finalizeCalls[0].receipts).toHaveLength(8);
    expect(be.activeRows("exp-1")).toHaveLength(8); // 8 persisted although 4 are shown
  });
});

describe("8 selected, 4 removed, submit", () => {
  it("finalizes and persists exactly the 4 that remain", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(8));
    await waitForListed(8);

    const keptUrls = s.visible.slice(4);
    for (let i = 0; i < 4; i += 1) await removeAt(0);
    await waitForListed(4);
    expect(s.visible).toEqual(keptUrls);

    await submitLikeForm(be, s);
    expect(be.finalizeCalls).toHaveLength(1);
    expect(be.finalizeCalls[0].receipts.map((r) => r.filename)).toEqual(keptUrls.map(nameOf));
    const rows = be.activeRows("exp-1");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.storage_path)).toEqual(keptUrls.map((u) => `exp-1/${nameOf(u)}`));
    // removed files stay in temp storage as orphans, but are never linked
    expect(be.objects.size).toBeGreaterThanOrEqual(8);
    expect(rows.some((r) => !keptUrls.map(nameOf).includes(nameOf(r.storage_path as string)))).toBe(false);
  });

  it("removes the correct file when removing the first, a middle and the last", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(8));
    await waitForListed(8);
    const all = [...s.visible];

    await removeAt(7); // last
    await removeAt(4); // middle
    await removeAt(0); // first
    await waitForListed(5);

    expect(s.visible).toEqual([all[1], all[2], all[3], all[5], all[6]]);
    await submitLikeForm(be, s);
    expect(be.activeRows("exp-1").map((r) => nameOf(r.file_url))).toEqual(
      [all[1], all[2], all[3], all[5], all[6]].map(nameOf),
    );
  });

  it("handles several removals fired in the same tick, and a double click, without drift", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(6));
    await waitForListed(6);
    const all = [...s.visible];

    const buttons = listed();
    act(() => {
      fireEvent.click(buttons[1]);
      fireEvent.click(buttons[1]); // double click on the same button
      fireEvent.click(buttons[3]);
      fireEvent.click(buttons[5]);
    });
    await waitForListed(3);

    expect(s.removedCallbacks).toBe(3); // the double click reported once
    expect(s.visible).toEqual([all[0], all[2], all[4]]);
    await submitLikeForm(be, s);
    expect(be.activeRows("exp-1")).toHaveLength(3);
  });
});

describe("remove while the upload is still in flight", () => {
  it("a removed in-flight upload is never added, reported, finalized or linked", async () => {
    be.holdUploads = true;
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(3));

    await waitFor(() => expect(be.heldUploads).toHaveLength(1)); // #1 in flight, #2 and #3 queued
    expect(screen.getAllByTestId("pending-upload-item")).toHaveLength(3);

    const cancels = screen.getAllByTestId("cancel-pending-upload");
    fireEvent.click(cancels[0]); // the one in flight
    fireEvent.click(cancels[2]); // a queued one
    expect(screen.getAllByTestId("pending-upload-item")).toHaveLength(1);

    await act(async () => be.releaseUpload()); // the cancelled bytes finish uploading
    await waitFor(() => expect(be.heldUploads).toHaveLength(1)); // #2 starts (#3 is skipped)
    await act(async () => be.releaseUpload());
    await waitForListed(1);

    expect(s.visible).toHaveLength(1);
    expect(be.objects.size).toBe(2); // #1 is an orphan temp object, #3 was never uploaded
    await submitLikeForm(be, s);
    expect(be.finalizeCalls[0].receipts).toHaveLength(1);
    expect(be.activeRows("exp-1")).toHaveLength(1);
  });

  it("an upload that finishes after the form was torn down does not re-add the file", async () => {
    be.holdUploads = true;
    const s = newSession();
    const { container, unmount } = render(<Harness session={s} />);
    pick(container, makeFiles(1));
    await waitFor(() => expect(be.heldUploads).toHaveLength(1));

    unmount(); // e.g. "Clear form" remounts the upload component
    await act(async () => be.releaseUpload());

    expect(s.visible).toEqual([]);
    expect(Array.from(s.regs.tempNames)).toEqual([]);
  });

  it("in edit mode a cancelled in-flight upload never gets an attachment row", async () => {
    vi.mocked(useAuth).mockReturnValue({
      ...(vi.mocked(useAuth)() as object),
      user: { id: USER, email: "x@example.com" },
      organizationId: ORG,
    } as never);
    be.holdUploads = true;
    const s = newSession();
    const { container } = render(<Harness session={s} expenseId="exp-1" />);
    pick(container, makeFiles(1));
    await waitFor(() => expect(be.heldUploads).toHaveLength(1));
    fireEvent.click(screen.getByTestId("cancel-pending-upload"));
    await act(async () => be.releaseUpload());

    await waitFor(() => expect(screen.queryAllByTestId("pending-upload-item")).toHaveLength(0));
    expect(be.activeRows("exp-1")).toHaveLength(0);
    expect(s.visible).toEqual([]);
  });
});

describe("re-adding and duplicate filenames", () => {
  it("add A, remove A, add A again -> exactly one attachment (the second upload)", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    const a = makeFiles(1)[0];

    pick(container, [a]);
    await waitForListed(1);
    const firstUrl = s.visible[0];
    fireEvent.click(listed()[0]);
    await waitForListed(0);
    pick(container, [a]);
    await waitForListed(1);

    expect(s.visible).toHaveLength(1);
    expect(s.visible[0]).not.toBe(firstUrl);
    await submitLikeForm(be, s);
    expect(be.finalizeCalls[0].receipts).toHaveLength(1);
    expect(be.finalizeCalls[0].receipts[0].filename).toBe(nameOf(s.visible[0]));
    expect(be.activeRows("exp-1")).toHaveLength(1);
  });

  it("two files with the same original filename: removing one removes that one, by identity", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(2, { sameName: true }));
    await waitForListed(2);
    const [first, second] = s.visible;

    fireEvent.click(listed()[1]); // remove the second
    await waitForListed(1);

    expect(s.visible).toEqual([first]);
    await submitLikeForm(be, s);
    expect(be.activeRows("exp-1").map((r) => nameOf(r.file_url))).toEqual([nameOf(first)]);
    expect(nameOf(first)).not.toBe(nameOf(second));
  });
});

describe("PDF and image attachments", () => {
  it("MicroLink-style PDFs: 2 uploaded, 1 removed -> one PDF finalized with its content type", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(2, { type: "application/pdf", ext: "pdf" }));
    await waitForListed(2);
    const keep = s.visible[0];
    fireEvent.click(listed()[1]);
    await waitForListed(1);

    await submitLikeForm(be, s);
    expect(be.finalizeCalls[0].receipts).toHaveLength(1);
    expect(be.finalizeCalls[0].receipts[0]).toMatchObject({
      filename: nameOf(keep),
      contentType: "application/pdf",
    });
    expect(be.activeRows("exp-1")).toHaveLength(1);
    expect(be.activeRows("exp-1")[0].content_type).toBe("application/pdf");
  });

  it("normal organization images: 3 uploaded, 1 removed -> 2 persisted", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(3));
    await waitForListed(3);
    fireEvent.click(listed()[1]);
    await waitForListed(2);
    await submitLikeForm(be, s);
    expect(be.activeRows("exp-1")).toHaveLength(2);
  });
});

describe("restored draft", () => {
  it("restored attachments are listed, can be removed, and are then not finalized", async () => {
    const s = newSession();
    const names = ["r1.jpg", "r2.jpg", "r3.jpg"];
    for (const n of names) {
      registerUploadedAttachment(
        s.regs,
        { url: be.publicUrl(`temp/${USER}/${n}`), storagePath: n, filename: n, fileSize: 5, contentType: "image/jpeg" },
        USER,
      );
      s.visible.push(be.publicUrl(`temp/${USER}/${n}`));
    }
    const seed = names.map((n) => ({
      id: `temp-restored-${n}`,
      filename: n,
      content_type: "image/jpeg",
      file_url: be.publicUrl(`temp/${USER}/${n}`),
      created_at: "2026-10-08T00:00:00.000Z",
      file_size: 5,
      storage_path: n,
    }));

    render(<Harness session={s} seed={seed} />);
    expect(listed()).toHaveLength(3); // visible, not just counted

    fireEvent.click(listed()[1]);
    await waitForListed(2);
    await submitLikeForm(be, s);
    expect(be.finalizeCalls[0].receipts.map((r) => r.filename)).toEqual(["r1.jpg", "r3.jpg"]);
    expect(be.activeRows("exp-1")).toHaveLength(2);
  });
});

describe("attach-first draft flow (MicroLink) with retries", () => {
  const snapshot = { title: "t" } as never;
  const saveDraft = async () =>
    ({
      kind: "committed",
      receipt: { expense_id: "exp-ml", revision: 0, status: "draft" },
    }) as never;

  const attempt = (s: Session) =>
    prepareAttachFirstSubmit(snapshot, "draft-key", {
      saveDraft,
      onFailure: () => undefined,
      attachFiles: async (expenseId) => {
        await submitLikeForm(be, s, expenseId, true);
      },
    });

  it("draft saved, 6 uploaded, 2 removed, submit -> 4 attachments", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(6));
    await waitForListed(6);
    await removeAt(0);
    await removeAt(0);
    await waitForListed(4);

    const out = await attempt(s);
    expect(out.expense_id).toBe("exp-ml");
    expect(be.finalizeCalls[0].receipts).toHaveLength(4);
    expect(be.activeRows("exp-ml")).toHaveLength(4);
  });

  it("a retry on the same draft after removing 2 more leaves only the remaining files active", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(6));
    await waitForListed(6);

    await attempt(s); // attempt 1 attached all 6 (the later submit step failed)
    expect(be.activeRows("exp-ml")).toHaveLength(6);

    await removeAt(4);
    await removeAt(0);
    await waitForListed(4);

    await attempt(s); // attempt 2: same draft key -> same expense
    const rows = be.activeRows("exp-ml");
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.storage_path)).size).toBe(4); // no duplicates
    expect(rows.map((r) => nameOf(r.file_url)).sort()).toEqual(s.visible.map(nameOf).sort());
  });

  it("double submit (the attach step runs twice) does not double the attachments", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(4));
    await waitForListed(4);

    await attempt(s);
    await attempt(s);
    expect(be.activeRows("exp-ml")).toHaveLength(4);
  });

  it("retry after the finalize response was lost, with one file removed in between", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(5));
    await waitForListed(5);

    be.finalizeMode = "lost_response"; // the server finalizes all 5, the browser never hears back
    await attempt(s).catch(() => undefined);

    fireEvent.click(listed()[2]);
    await waitForListed(4);
    await attempt(s);

    const rows = be.activeRows("exp-ml");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => nameOf(r.file_url)).sort()).toEqual(s.visible.map(nameOf).sort());
  });

  it("finalize unavailable (temporary fallback links), then one file removed and retried", async () => {
    const s = newSession();
    const { container } = render(<Harness session={s} />);
    pick(container, makeFiles(3));
    await waitForListed(3);

    // The edge function is down: with the upload blobs cached the form falls back to
    // linking the temp copies, so all 3 are linked (at their temp paths) on attempt 1.
    be.finalizeMode = "down";
    await attempt(s);
    expect(be.activeRows("exp-ml")).toHaveLength(3);

    await removeAt(0);
    be.finalizeMode = "ok";
    await attempt(s);

    expect(be.finalizeCalls[be.finalizeCalls.length - 1].receipts).toHaveLength(2);
    const rows = be.activeRows("exp-ml");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => nameOf(r.file_url)).sort()).toEqual(s.visible.map(nameOf).sort());
  });
});

describe("edit mode (persisted attachments)", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      ...(vi.mocked(useAuth)() as object),
      user: { id: USER, email: "x@example.com" },
      organizationId: ORG,
    } as never);
  });

  it("removing a persisted attachment soft-deletes the row and tells the parent", async () => {
    for (const n of ["p1.jpg", "p2.jpg", "p3.jpg"]) {
      be.attachments.push({
        id: `row-${n}`, expense_id: "exp-1", organization_id: ORG, file_url: be.publicUrl(`exp-1/${n}`),
        filename: n, content_type: "image/jpeg", uploaded_by: USER, file_size: 5, storage_path: `exp-1/${n}`,
        created_at: "2026-10-01T00:00:00.000Z", deleted_at: null,
      });
    }
    const s = newSession();
    render(<Harness session={s} expenseId="exp-1" />);
    await waitForListed(3);

    fireEvent.click(listed()[0]);
    await waitForListed(2);

    expect(be.softDeleteCalls).toHaveLength(1);
    expect(be.activeRows("exp-1")).toHaveLength(2);
    expect(s.removedCallbacks).toBe(1);
  });

  it("already soft-deleted rows are not listed again", async () => {
    be.attachments.push(
      {
        id: "row-a", expense_id: "exp-1", organization_id: ORG, file_url: be.publicUrl("exp-1/a.jpg"),
        filename: "a.jpg", content_type: "image/jpeg", uploaded_by: USER, file_size: 5, storage_path: "exp-1/a.jpg",
        created_at: "2026-10-01T00:00:00.000Z", deleted_at: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "row-b", expense_id: "exp-1", organization_id: ORG, file_url: be.publicUrl("exp-1/b.jpg"),
        filename: "b.jpg", content_type: "image/jpeg", uploaded_by: USER, file_size: 5, storage_path: "exp-1/b.jpg",
        created_at: "2026-10-01T00:00:01.000Z", deleted_at: null,
      },
    );
    render(<Harness session={newSession()} expenseId="exp-1" />);
    await waitForListed(1);
  });
});

describe("clients that do not pass the new props keep working", () => {
  it("upload and remove still work with only onUploadComplete (old call sites)", async () => {
    const onUploadComplete = vi.fn();
    const { container } = render(<FileUpload expenseId="new" onUploadComplete={onUploadComplete} />);
    pick(container, makeFiles(2));
    await waitForListed(2);
    expect(onUploadComplete).toHaveBeenCalledTimes(2);
    expect(onUploadComplete.mock.calls[0][0]).toMatchObject({ content_type: "image/jpeg" });

    fireEvent.click(listed()[0]);
    await waitForListed(1);
  });
});
