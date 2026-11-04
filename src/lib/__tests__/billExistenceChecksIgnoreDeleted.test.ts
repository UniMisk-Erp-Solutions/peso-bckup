import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DOC-150 regression: every client "does a bill exist" check must ignore soft-deleted attachments.
// A removed bill (deleted_at set) once let an Rs 800 expense through a Rs 499 threshold.
const read = (p: string) => readFileSync(p, "utf-8");

function existenceBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\.from\("attachments"\)\s*\.select\("id"\)([\s\S]*?)\.limit\(1\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[0]);
  return out;
}

describe("bill existence checks ignore soft-deleted attachments", () => {
  for (const file of [
    "src/pages/ExpenseForm.tsx",
    "src/services/ExpenseService.ts",
    "src/pages/AdminSubmitExpense.tsx",
  ]) {
    it(`${file}: every attachments existence query filters deleted_at`, () => {
      const blocks = existenceBlocks(read(file));
      for (const b of blocks) expect(b).toMatch(/\.is\("deleted_at", null\)/);
    });
  }

  it("ExpenseService requirement check is covered", () => {
    // One shared definition (used with and without the pre-loaded submitter context) - both paths exclude soft-deleted rows.
    expect(read("src/services/ExpenseService.ts")).toMatch(/const liveBillQuery = \(org: string\) =>[\s\S]{0,260}\.is\("deleted_at", null\)/);
  });

  it("admin attach-first count query filters deleted_at", () => {
    expect(read("src/pages/AdminSubmitExpense.tsx")).toMatch(/\.eq\("expense_id", prepared\.expenseId\)\s*\.is\("deleted_at", null\)/);
  });
});
