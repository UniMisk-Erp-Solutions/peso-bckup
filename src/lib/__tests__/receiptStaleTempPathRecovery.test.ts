/**
 * Receipt preview — recovery when the stored path is a stale temp/ path.
 *
 * Production evidence (SELECT-only audit, 2026-08-01): attachment rows for expense
 * 361fbbcc-… record `temp/22ba24a5-…/1782737966702-yrc2mnmcdyi.png`, while the object
 * actually lives at `361fbbcc-…/1782737966702-yrc2mnmcdyi.png`. The temp→expense move
 * succeeded but `file_url` was never updated.
 *
 * The old candidate list could not reach it: the `temp/{userId}` fallback was skipped
 * for paths already starting with `temp/`, and `fallbackExpenseId` was declared and
 * documented but never read, so the ONLY path tried was the stale temp one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const downloads = vi.fn();
const signed = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://sb.example.com/storage/v1/object/public/receipts/${path}` },
        }),
        download: (path: string) => downloads(path),
        createSignedUrl: (path: string) => signed(path),
      }),
    },
  },
}));

import { loadAttachmentBlobForPreview } from "@/lib/attachmentPreview";

const EXPENSE_ID = "361fbbcc-6ada-4442-8848-ba0d59b74169";
const USER_ID = "22ba24a5-40dc-4618-a2de-098974237111";
const FILE = "1782737966702-yrc2mnmcdyi.png";
const BASE = "https://sb.example.com/storage/v1/object/public/receipts";

/** Only `existingPaths` resolve; everything else 400s the way storage does. */
function serveOnly(existingPaths: string[]) {
  const keyOf = (url: string) => url.split("/object/public/receipts/")[1] ?? "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      existingPaths.includes(keyOf(String(url)))
        ? { ok: true, blob: async () => new Blob(["png-bytes"], { type: "image/png" }) }
        : { ok: false, status: 400 },
    ),
  );
  downloads.mockResolvedValue({ data: null, error: new Error("Object not found") });
  signed.mockResolvedValue({ data: null, error: new Error("Object not found") });
}

beforeEach(() => {
  downloads.mockReset();
  signed.mockReset();
  vi.unstubAllGlobals();
});

describe("stale temp/ path recovery", () => {
  it("finds the object at {expenseId}/file when the record still says temp/", async () => {
    serveOnly([`${EXPENSE_ID}/${FILE}`]);

    const blob = await loadAttachmentBlobForPreview(
      `${BASE}/temp/${USER_ID}/${FILE}`,
      "image/png",
      { fallbackTempUserId: USER_ID, fallbackExpenseId: EXPENSE_ID },
    );

    expect(blob).not.toBeNull();
  });

  it("still resolves the normal case where the recorded path is correct", async () => {
    serveOnly([`${EXPENSE_ID}/${FILE}`]);

    const blob = await loadAttachmentBlobForPreview(
      `${BASE}/${EXPENSE_ID}/${FILE}`,
      "image/png",
      { fallbackTempUserId: USER_ID, fallbackExpenseId: EXPENSE_ID },
    );

    expect(blob).not.toBeNull();
  });

  it("still resolves the reverse case — recorded permanent, file still in temp", async () => {
    serveOnly([`temp/${USER_ID}/${FILE}`]);

    const blob = await loadAttachmentBlobForPreview(
      `${BASE}/${EXPENSE_ID}/${FILE}`,
      "image/png",
      { fallbackTempUserId: USER_ID, fallbackExpenseId: EXPENSE_ID },
    );

    expect(blob).not.toBeNull();
  });

  it("returns null when the bytes are genuinely absent everywhere", async () => {
    serveOnly([]);

    const blob = await loadAttachmentBlobForPreview(
      `${BASE}/bcb9dbc8-00c2-4690-9bb0-e0cc1d7cabcf/1785434184415-grfx7vumcj6.jpeg`,
      "image/jpeg",
      {
        fallbackTempUserId: "eead54de-f12c-427c-a205-ef190e8b314b",
        fallbackExpenseId: "bcb9dbc8-00c2-4690-9bb0-e0cc1d7cabcf",
      },
    );

    expect(blob).toBeNull();
  });

  it("does not add speculative paths — at most 3 candidates are attempted", async () => {
    serveOnly([]);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await loadAttachmentBlobForPreview(`${BASE}/temp/${USER_ID}/${FILE}`, "image/png", {
      fallbackTempUserId: USER_ID,
      fallbackExpenseId: EXPENSE_ID,
    });

    // one public GET per candidate; the stored temp path + {expenseId}/file = 2
    const publicGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/object/public/receipts/"),
    );
    expect(publicGets.length).toBeLessThanOrEqual(3);
  });
});
