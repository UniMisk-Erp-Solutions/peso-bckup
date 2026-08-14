/**
 * The preview dialog must not tell a user their receipt was lost when it wasn't.
 *
 * Before this, `AttachmentPreviewDialog` had a single `previewError` flag. Both "storage
 * returned nothing" and "the <img> refused to decode these bytes" set it, and both
 * rendered "This file is no longer available in storage." For HEIC — the iPhone camera
 * default, which no Chromium or Firefox build can paint — that message was simply wrong:
 * the file was sitting in storage, intact, and the user was told it had been lost during
 * migration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const resolveImageSource = vi.fn();
const resolvePdf = vi.fn();

vi.mock("@/lib/attachmentPreview", () => ({
  resolveImagePreviewSource: (...a: unknown[]) => resolveImageSource(...a),
  resolveImagePreviewObjectUrl: vi.fn(),
  resolvePdfPreviewObjectUrl: (...a: unknown[]) => resolvePdf(...a),
  isPdfAttachment: (url?: string | null, contentType?: string | null) =>
    (contentType ?? "").toLowerCase().includes("pdf") ||
    (url ?? "").toLowerCase().endsWith(".pdf"),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Keys carrying a defaultValue render that copy; the rest render as the raw key.
    // Assertions below therefore match on KEYS, which is also what makes them stable
    // against copy edits. `localeKeys` covers the copy itself.
    t: (k: string, p?: Record<string, unknown>) => (p?.defaultValue as string) ?? k,
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const KEY_FILE_UNAVAILABLE = "attachmentPreview.fileUnavailable";
const KEY_FILE_UNAVAILABLE_HINT = "attachmentPreview.fileUnavailableHint";
const KEY_DOWNLOAD = "attachmentPreview.download";

import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";

const HEIC_URL = "https://example.invalid/storage/v1/object/public/receipts/e1/IMG_0001.heic";

const openSpy = vi.fn();

beforeEach(() => {
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:stub");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  resolveImageSource.mockReset();
  resolvePdf.mockReset();
  openSpy.mockReset();
  vi.stubGlobal("open", openSpy);
});

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <AttachmentPreviewDialog
      open
      onOpenChange={vi.fn()}
      url={HEIC_URL}
      contentType="image/heic"
      {...props}
    />,
  );
}

describe("undecodable attachment (HEIC)", () => {
  beforeEach(() => {
    resolveImageSource.mockResolvedValue({
      status: "unsupported",
      objectUrl: null,
      originalObjectUrl: "blob:original",
    });
  });

  it("does NOT claim the file is missing from storage", async () => {
    renderDialog();
    // Wait for the resolved state to paint, otherwise this asserts against the spinner
    // and passes for the wrong reason.
    await waitFor(() =>
      expect(screen.getByText(/can't be displayed in this browser/i)).toBeTruthy(),
    );

    expect(screen.queryByText(KEY_FILE_UNAVAILABLE)).toBeNull();
    expect(screen.queryByText(KEY_FILE_UNAVAILABLE_HINT)).toBeNull();
  });

  it("explains that the browser cannot display this format", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText(/can't be displayed in this browser/i)).toBeTruthy(),
    );
    expect(screen.getByText(/HEIC\/HEIF photos from iPhone/i)).toBeTruthy();
  });

  it("offers a way to open the file in a new page", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getAllByText(/open in new tab/i).length).toBeGreaterThan(0));
  });

  it("opens the ORIGINAL file, not a converted stand-in", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getAllByText(/open in new tab/i).length).toBeGreaterThan(0));

    screen.getAllByText(/open in new tab/i)[0].closest("button")?.click();

    expect(openSpy).toHaveBeenCalledWith("blob:original", "_blank", "noopener,noreferrer");
  });

  it("still offers a download of the intact file", async () => {
    renderDialog({ filename: "IMG_0001.heic" });

    await waitFor(() => expect(screen.getByText(KEY_DOWNLOAD)).toBeTruthy());
    const anchor = screen.getByText(KEY_DOWNLOAD).closest("a");
    expect(anchor?.getAttribute("href")).toBe("blob:original");
    expect(anchor?.getAttribute("download")).toBe("IMG_0001.heic");
  });
});

describe("genuinely missing attachment", () => {
  it("keeps the storage-loss message for files that really are gone", async () => {
    resolveImageSource.mockResolvedValue({
      status: "missing",
      objectUrl: null,
      originalObjectUrl: null,
    });

    renderDialog();

    await waitFor(() => expect(screen.getByText(KEY_FILE_UNAVAILABLE)).toBeTruthy());
    expect(screen.queryByText(/can't be displayed in this browser/i)).toBeNull();
  });
});

describe("HEIC that converted successfully", () => {
  it("renders the converted image while download keeps the original", async () => {
    resolveImageSource.mockResolvedValue({
      status: "ok",
      objectUrl: "blob:converted-jpeg",
      originalObjectUrl: "blob:original",
    });

    renderDialog({ filename: "IMG_0001.heic" });

    await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:converted-jpeg");
    expect(screen.getByText(KEY_DOWNLOAD).closest("a")?.getAttribute("href")).toBe(
      "blob:original",
    );
  });
});

describe("localeKeys", () => {
  it("ships the unsupported-format copy in every language", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");

    for (const lang of ["en", "hi", "gu"]) {
      const dict = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/locales/${lang}/common.json`), "utf-8"),
      );
      const block = dict.attachmentPreview ?? {};
      for (const key of ["formatUnsupported", "formatUnsupportedHint", "openInNewTab"]) {
        expect(typeof block[key], `${lang}/common.json is missing attachmentPreview.${key}`).toBe(
          "string",
        );
      }
    }
  });
});
