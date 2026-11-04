import { describe, expect, it } from "vitest";
import { canonicalReceiptFileUrl } from "@/lib/receiptFileUrl";

const PUBLIC = "https://pesowise-supabase.unimisk.com";

describe("canonicalReceiptFileUrl", () => {
  it("rewrites the container-internal host to the public base", () => {
    expect(canonicalReceiptFileUrl("http://supabase-kong:8000/storage/v1/object/public/receipts/abc/1.jpg", PUBLIC)).toBe(
      `${PUBLIC}/storage/v1/object/public/receipts/abc/1.jpg`,
    );
  });
  it("tolerates a trailing slash on the public base", () => {
    expect(canonicalReceiptFileUrl("http://supabase-kong:8000/storage/v1/object/public/receipts/x.jpg", `${PUBLIC}/`)).toBe(
      `${PUBLIC}/storage/v1/object/public/receipts/x.jpg`,
    );
  });
  it("leaves an already-public URL unchanged", () => {
    const u = `${PUBLIC}/storage/v1/object/public/receipts/x.jpg`;
    expect(canonicalReceiptFileUrl(u, PUBLIC)).toBe(u);
  });
  it("never invents a URL: empty stays empty, and no public base means no rewrite", () => {
    expect(canonicalReceiptFileUrl("", PUBLIC)).toBe("");
    expect(canonicalReceiptFileUrl(undefined, PUBLIC)).toBe("");
    const internal = "http://supabase-kong:8000/storage/v1/object/public/receipts/x.jpg";
    expect(canonicalReceiptFileUrl(internal, "")).toBe(internal);
  });
  it("does not touch a third-party or legacy cloud host", () => {
    const legacy = "https://kqlqirdneocivumdjtvx.supabase.co/storage/v1/object/public/receipts/x.jpg";
    expect(canonicalReceiptFileUrl(legacy, PUBLIC)).toBe(legacy);
  });
});
