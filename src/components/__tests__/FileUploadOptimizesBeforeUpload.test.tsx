/**
 * Bill-photo flow (PWA performance hotfix): the REAL FileUpload component against an in-memory Supabase fake.
 *
 * Contract under test: a large phone photo is ACCEPTED, optimized exactly ONCE before upload, the OPTIMIZED File is the
 * only thing sent to storage / registered / cached for Submit, PDFs and small images are untouched, and a retry after a
 * failed upload re-uses the optimized file instead of compressing it again. Every assertion is on what storage received.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { FileUpload } from "@/components/FileUpload";
import { FakeReceiptBackend } from "@/test/fakeReceiptBackend";

const H = vi.hoisted(() => ({
  client: null as unknown as Record<string, unknown>,
  optimize: null as unknown as (file: File) => Promise<unknown>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy({}, { get: (_t, key: string) => H.client[key] }),
}));

// Keep the real helpers (classification, passthrough, blocking messages); replace only the browser pixel work.
vi.mock("@/lib/receiptImageOptimizer", async (orig) => {
  const actual = await orig<typeof import("@/lib/receiptImageOptimizer")>();
  return { ...actual, optimizeReceiptImage: (file: File) => H.optimize(file) };
});

const MB = 1024 * 1024;
const USER = "test-user-id";

function optimizedResult(file: File, outBytes: number) {
  const out = new File([new Uint8Array(outBytes)], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  return {
    file: out,
    optimized: true,
    reason: "optimized",
    originalBytes: file.size,
    outputBytes: out.size,
    originalWidth: 4032,
    originalHeight: 3024,
    width: 2560,
    height: 1920,
    quality: 0.85,
    ms: 120,
    attempts: 1,
  };
}

let be: FakeReceiptBackend;
let uploaded: Array<{ path: string; file: File }>;
let failNextUploads = 0;
let optimizeCalls: File[];

beforeEach(() => {
  be = new FakeReceiptBackend(USER);
  uploaded = [];
  optimizeCalls = [];
  failNextUploads = 0;
  H.optimize = async (file: File) => {
    optimizeCalls.push(file);
    return optimizedResult(file, 1.2 * MB);
  };
  const base = be.client() as unknown as { storage: { from: (b: string) => Record<string, unknown> } };
  H.client = {
    ...(base as object),
    storage: {
      from: (bucket: string) => {
        const real = base.storage.from(bucket) as { upload: (p: string, f: Blob) => Promise<unknown> };
        return {
          ...real,
          upload: async (path: string, file: File) => {
            if (failNextUploads > 0) {
              failNextUploads -= 1;
              return { data: null, error: { message: "network error" } };
            }
            uploaded.push({ path, file });
            return real.upload(path, file);
          },
        };
      },
    },
  } as unknown as Record<string, unknown>;
});

const pick = (container: HTMLElement, files: File[]) => {
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
};
const bytes = (mb: number, name: string, type: string) => new File([new Uint8Array(Math.round(mb * MB))], name, { type });

describe("FileUpload: large phone photos are optimized before upload, never rejected", () => {
  it.each([12, 25, 35])("a %i MB camera photo is accepted; storage receives ONLY the optimized file", async (mb) => {
    const seen: File[] = [];
    const { container } = render(<FileUpload expenseId="new" onUploadComplete={(_a, f) => void seen.push(f as File)} />);
    pick(container, [bytes(mb, "IMG_4021.HEIC".replace("HEIC", "jpg"), "image/jpeg")]);
    await waitFor(() => expect(uploaded).toHaveLength(1));

    expect(optimizeCalls).toHaveLength(1);
    expect(uploaded[0].file.size).toBeLessThan(2 * MB); // the 12-35 MB original never reached storage
    expect(uploaded[0].file.type).toBe("image/jpeg");
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe(uploaded[0].file); // Submit's cache holds the SAME optimized File
    expect(screen.queryByText(/too large|10 MB or smaller/i)).toBeNull();
  });

  it("an iPhone HEIC original is handed to the optimizer and uploaded as a JPEG", async () => {
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [bytes(3.2, "IMG_0099.HEIC", "image/heic")]);
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(optimizeCalls).toHaveLength(1);
    expect(uploaded[0].file.type).toBe("image/jpeg");
    expect(uploaded[0].path.endsWith(".jpg")).toBe(true);
  });

  it("PDFs are never optimized and are uploaded unchanged", async () => {
    const pdf = bytes(6, "invoice.pdf", "application/pdf");
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [pdf]);
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(optimizeCalls).toHaveLength(0);
    expect(uploaded[0].file).toBe(pdf);
  });

  it("a small image is uploaded untouched with no optimization pass", async () => {
    const small = bytes(0.2, "tiny.jpg", "image/jpeg");
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [small]);
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(optimizeCalls).toHaveLength(0);
    expect(uploaded[0].file).toBe(small);
  });

  it("a PDF over the 10 MB storage limit gets a precise message and nothing is uploaded", async () => {
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [bytes(14, "scan.pdf", "application/pdf")]);
    await waitFor(() => expect(screen.getByText(/PDF bills can be up to 10 MB/i)).toBeTruthy());
    expect(uploaded).toHaveLength(0);
  });

  it("an image the device cannot decode and that exceeds storage says so, without a generic 'photo too large'", async () => {
    H.optimize = async (file: File) => ({ ...optimizedResult(file, 1), file, optimized: false, reason: "decode_failed", outputBytes: file.size });
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [bytes(18, "IMG_9000.jpg", "image/jpeg")]);
    await waitFor(() => expect(screen.getByText(/could not be prepared on this device/i)).toBeTruthy());
    expect(uploaded).toHaveLength(0);
  });
});

describe("FileUpload: failed upload retry never re-compresses", () => {
  it("the retry uploads the SAME optimized file and the optimizer ran exactly once", async () => {
    failNextUploads = 1;
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [bytes(15, "IMG_5000.jpg", "image/jpeg")]);
    await waitFor(() => expect(screen.queryAllByText(/retry/i).length).toBeGreaterThan(0));
    expect(uploaded).toHaveLength(0);
    expect(optimizeCalls).toHaveLength(1);

    fireEvent.click(screen.queryAllByText(/retry/i)[0]);
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(optimizeCalls).toHaveLength(1); // not compressed a second time
    expect(uploaded[0].file.size).toBeLessThan(2 * MB);
  });
});

describe("FileUpload: several photos", () => {
  it("each photo is optimized once and uploaded once, in order", async () => {
    const { container } = render(<FileUpload expenseId="new" />);
    pick(container, [bytes(9, "a.jpg", "image/jpeg"), bytes(11, "b.jpg", "image/jpeg"), bytes(14, "c.jpg", "image/jpeg")]);
    await waitFor(() => expect(uploaded).toHaveLength(3), { timeout: 5000 });
    expect(optimizeCalls.map((f) => f.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(uploaded.map((u) => u.file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });
});
