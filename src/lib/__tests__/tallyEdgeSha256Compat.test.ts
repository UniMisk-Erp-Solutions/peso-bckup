import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { sha256Utf8HexSync } from "../../../supabase/functions/_shared/tallySync/contentHash.ts";
import {
  metadataLedgerName,
  metadataVersionLedgerName,
} from "../../../supabase/functions/_shared/tallyMapping/identities.ts";

describe("edge SHA-256 identity compatibility", () => {
  const samples = [
    "80ab039f-f9e2-4c76-8b5b-e65b15d66af9:meta:claim_verification:row-1",
    "org:meta:daily_project_report:2026-01-01",
  ];

  it("sha256Utf8HexSync matches Node createHash", () => {
    for (const s of samples) {
      const node = createHash("sha256").update(s, "utf8").digest("hex");
      expect(sha256Utf8HexSync(s)).toBe(node);
    }
  });

  it("metadata ledger names match Node-based src implementation", () => {
    const metaKey = samples[0];
    const h = "a".repeat(64);
    const nodeDigest = createHash("sha256").update(metaKey, "utf8").digest("hex").slice(0, 12);
    expect(metadataLedgerName(metaKey)).toBe(`PW-META-${nodeDigest}`.slice(0, 200));
    expect(metadataVersionLedgerName(metaKey, h)).toBe(
      `PW-META-${nodeDigest}-${h.slice(0, 12)}`.slice(0, 200),
    );
  });
});
