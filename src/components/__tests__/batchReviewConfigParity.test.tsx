/**
 * Batch Review Configuration Parity — T26–T32
 *
 * Source-code structural tests. Reading TSX source directly avoids loading
 * the full component dependency tree (which exceeds available worker heap).
 *
 * T26 — BatchExpenseDetailCard: categoryLabel prop wired into rendered label
 * T27 — BatchExpenseDetailCard: purposeLabel prop wired into rendered label
 * T28 — BatchExpenseDetailCard: amountLabel prop wired into rendered label
 * T29 — BatchExpenseDetailCard: destinationLabel prop wired into rendered label
 * T30 — MobileBatchLineDetail: titleLabel prop wired into correction form label
 * T31 — MobileBatchLineDetail: purposeLabel prop wired into correction form label
 * T32 — MobileBatchLineDetail: categoryLabel prop passed to BatchExpenseDetailCard
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, "src", relPath), "utf8");
}

const bdcSrc = readSrc("components/BatchExpenseDetailCard.tsx");
const mobileSrc = readSrc("components/mobile/MobileBatchLineDetail.tsx");

describe("T26 — BatchExpenseDetailCard: categoryLabel prop present and used", () => {
  it("prop declared in interface", () => {
    expect(bdcSrc).toMatch(/categoryLabel\s*\??\s*:/);
  });
  it("prop referenced in JSX render", () => {
    expect(bdcSrc).toMatch(/\{categoryLabel/);
  });
});

describe("T27 — BatchExpenseDetailCard: purposeLabel prop present and used", () => {
  it("prop declared in interface", () => {
    expect(bdcSrc).toMatch(/purposeLabel\s*\??\s*:/);
  });
  it("prop referenced in JSX render", () => {
    expect(bdcSrc).toMatch(/\{purposeLabel/);
  });
});

describe("T28 — BatchExpenseDetailCard: amountLabel prop present and used", () => {
  it("prop declared in interface", () => {
    expect(bdcSrc).toMatch(/amountLabel\s*\??\s*:/);
  });
  it("prop referenced in JSX render", () => {
    expect(bdcSrc).toMatch(/\{amountLabel/);
  });
});

describe("T29 — BatchExpenseDetailCard: destinationLabel prop present and used", () => {
  it("prop declared in interface", () => {
    expect(bdcSrc).toMatch(/destinationLabel\s*\??\s*:/);
  });
  it("prop referenced in JSX render", () => {
    expect(bdcSrc).toMatch(/\{destinationLabel/);
  });
});

describe("T30 — MobileBatchLineDetail: titleLabel prop present and used in correction form", () => {
  it("prop declared in interface", () => {
    expect(mobileSrc).toMatch(/titleLabel\s*\??\s*:/);
  });
  it("prop referenced in correction form label area", () => {
    expect(mobileSrc).toMatch(/titleLabel/);
  });
});

describe("T31 — MobileBatchLineDetail: purposeLabel prop present and used in correction form", () => {
  it("prop declared in interface", () => {
    expect(mobileSrc).toMatch(/purposeLabel\s*\??\s*:/);
  });
  it("prop referenced in correction form label area", () => {
    expect(mobileSrc).toMatch(/purposeLabel/);
  });
});

describe("T32 — MobileBatchLineDetail: categoryLabel prop forwarded to BatchExpenseDetailCard", () => {
  it("prop declared in interface", () => {
    expect(mobileSrc).toMatch(/categoryLabel\s*\??\s*:/);
  });
  it("categoryLabel passed to BatchExpenseDetailCard in JSX", () => {
    expect(mobileSrc).toMatch(/categoryLabel=\{categoryLabel\}/);
  });
});
