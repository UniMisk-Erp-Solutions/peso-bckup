/**
 * Phase 4: FileUpload upload-state safety tests.
 *
 * These tests read the source file as text to verify structural guarantees:
 * - onUploadComplete is ONLY called in the success path (never in catch/finally)
 * - Failed uploads are tracked in failedUploads state (not silently discarded)
 * - Retry button is rendered for failed uploads
 * - No attachment is added to React state on upload failure
 * - ReceiptUploadState type is defined
 *
 * Root cause of the 504 issue: browser uploads go directly to self-hosted
 * Supabase Storage through a reverse proxy (Coolify/NGINX/Kong) that has an
 * insufficient timeout. The 504 response lacks CORS headers, causing a secondary
 * CORS error in the browser. The infrastructure fix requires a proxy config
 * change that cannot be applied from source code. These tests verify the
 * frontend handles the failure gracefully and offers retry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const src = readFileSync(resolve(cwd, "src/components/FileUpload.tsx"), "utf-8");

describe("FileUpload — upload state type and retry infrastructure", () => {
  it("defines ReceiptUploadState type with queued/uploading/uploaded/failed values", () => {
    expect(src).toContain("ReceiptUploadState");
    expect(src).toContain('"queued"');
    expect(src).toContain('"uploading"');
    expect(src).toContain('"uploaded"');
    expect(src).toContain('"failed"');
  });

  it("defines FailedUpload interface with id, file, filename, errorMessage, state", () => {
    expect(src).toContain("FailedUpload");
    expect(src).toMatch(/interface FailedUpload/);
    expect(src).toContain("errorMessage");
  });

  it("tracks failed uploads in failedUploads state", () => {
    expect(src).toContain("failedUploads");
    expect(src).toContain("setFailedUploads");
    expect(src).toMatch(/useState<FailedUpload\[\]>/);
  });

  it("retryUpload function exists", () => {
    expect(src).toContain("retryUpload");
    expect(src).toMatch(/const retryUpload/);
  });
});

describe("FileUpload — onUploadComplete not called on failure", () => {
  it("onUploadComplete is called only after successful upload (not in catch block)", () => {
    // The catch block must NOT contain onUploadComplete
    const catchMatch = src.match(/} catch \(error: any\) \{[\s\S]*?} finally \{/);
    expect(catchMatch).not.toBeNull();
    if (catchMatch) {
      expect(catchMatch[0]).not.toContain("onUploadComplete");
    }
  });

  it("onUploadComplete is called only in the success path (before catch)", () => {
    // Verify onUploadComplete appears in the main body (before catch), not in catch/finally
    const invokeIndex = src.indexOf("onUploadComplete(");
    const catchIndex = src.indexOf("} catch (error: any) {");
    expect(invokeIndex).toBeGreaterThan(0);
    expect(catchIndex).toBeGreaterThan(0);
    expect(invokeIndex).toBeLessThan(catchIndex);
  });
});

describe("FileUpload — failed upload state safety", () => {
  it("failed uploads are added to failedUploads state (not silently discarded)", () => {
    const catchBlock = src.match(/} catch \(error: any\) \{[\s\S]*?} finally \{/);
    expect(catchBlock).not.toBeNull();
    if (catchBlock) {
      expect(catchBlock[0]).toContain("setFailedUploads");
    }
  });

  it("setAttachments is NOT called in the catch block (no attachment added on failure)", () => {
    const catchBlock = src.match(/} catch \(error: any\) \{[\s\S]*?} finally \{/);
    expect(catchBlock).not.toBeNull();
    if (catchBlock) {
      expect(catchBlock[0]).not.toContain("setAttachments");
    }
  });
});

describe("FileUpload — retry UI is rendered for failed files", () => {
  it("renders failed upload items with data-testid", () => {
    expect(src).toContain('data-testid="failed-upload-item"');
  });

  it("renders retry button with data-testid", () => {
    expect(src).toContain('data-testid="retry-upload-button"');
  });

  it("retry button calls retryUpload", () => {
    expect(src).toMatch(/onClick=\{.*retryUpload/);
  });

  it("retry button is disabled while another upload is in progress", () => {
    const retrySection = src.match(/data-testid="retry-upload-button"[\s\S]*?\/>/);
    expect(retrySection).not.toBeNull();
    if (retrySection) {
      expect(retrySection[0]).toContain("uploading");
    }
  });
});
