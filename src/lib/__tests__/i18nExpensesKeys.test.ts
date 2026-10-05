/**
 * Verify that required i18n keys exist in all active locales.
 * Tests read locale JSON files directly from disk so they catch missing keys
 * before i18next silently falls back to the key string at runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

function readLocale(locale: string, ns: string): Record<string, unknown> {
  const raw = readFileSync(
    resolve(cwd, `src/locales/${locale}/${ns}.json`),
    "utf-8",
  );
  return JSON.parse(raw);
}

const locales = ["en", "hi", "gu"] as const;

// ---------------------------------------------------------------------------
// expenses:form.submitSuccess
// ---------------------------------------------------------------------------
describe("expenses:form.submitSuccess", () => {
  for (const locale of locales) {
    it(`is present and non-empty in ${locale}`, () => {
      const ns = readLocale(locale, "expenses");
      const form = ns.form as Record<string, unknown>;
      expect(form, `expenses.json for '${locale}' must have a 'form' key`).toBeDefined();
      expect(
        form.submitSuccess,
        `expenses:form.submitSuccess missing in '${locale}'`,
      ).toBeDefined();
      expect(typeof form.submitSuccess).toBe("string");
      expect((form.submitSuccess as string).length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// expenses:form.receiptsTempFallback / receiptsTempFallbackTitle
// ---------------------------------------------------------------------------
describe("expenses:form.receiptsTempFallback", () => {
  for (const locale of locales) {
    it(`is present and non-empty in ${locale}`, () => {
      const ns = readLocale(locale, "expenses");
      const form = ns.form as Record<string, unknown>;
      expect(form, `expenses.json for '${locale}' must have a 'form' key`).toBeDefined();
      expect(
        form.receiptsTempFallback,
        `expenses:form.receiptsTempFallback missing in '${locale}'`,
      ).toBeDefined();
      expect(typeof form.receiptsTempFallback).toBe("string");
      expect((form.receiptsTempFallback as string).length).toBeGreaterThan(0);
    });
  }
});

describe("expenses:form.receiptsTempFallbackTitle (2026-10-01 review fix)", () => {
  for (const locale of locales) {
    it(`is present, non-empty, and distinct from submitSuccess in ${locale}`, () => {
      const ns = readLocale(locale, "expenses");
      const form = ns.form as Record<string, unknown>;
      expect(
        form.receiptsTempFallbackTitle,
        `expenses:form.receiptsTempFallbackTitle missing in '${locale}'`,
      ).toBeDefined();
      expect(typeof form.receiptsTempFallbackTitle).toBe("string");
      expect((form.receiptsTempFallbackTitle as string).length).toBeGreaterThan(0);
      // The whole point of this key: a temporary-receipt-fallback notice must
      // never read as "Expense submitted" -- that is reused as a DIFFERENT
      // key (form.submitSuccess) because the fallback can fire BEFORE the
      // expense is actually submitted (see ExpenseForm.tsx's
      // moveTempFilesToExpense, called from the needsAttachmentFirst path of
      // submitMicroLinkAtomically).
      expect(form.receiptsTempFallbackTitle).not.toBe(form.submitSuccess);
    });
  }

  it("the source no longer wires the receipt-fallback toast to the submitSuccess key", () => {
    const source = readFileSync(resolve(cwd, "src/pages/ExpenseForm.tsx"), "utf-8");
    const fallbackBlockMatch = source.match(/if \(tempFallbackCount > 0\) \{[\s\S]{0,900}?\n    \}/);
    expect(fallbackBlockMatch, "could not find the tempFallbackCount toast block in ExpenseForm.tsx").toBeTruthy();
    const block = fallbackBlockMatch![0];
    expect(block).not.toMatch(/form\.submitSuccess/);
    expect(block).toMatch(/form\.receiptsTempFallbackTitle/);
  });
});

// ---------------------------------------------------------------------------
// expenses:dateLock.checking (2026-10-01 fail-closed review fix)
// ---------------------------------------------------------------------------
describe("expenses:dateLock.checking", () => {
  for (const locale of locales) {
    it(`is present and non-empty in ${locale}`, () => {
      const ns = readLocale(locale, "expenses");
      const dateLock = ns.dateLock as Record<string, unknown>;
      expect(dateLock, `expenses.json for '${locale}' must have a 'dateLock' key`).toBeDefined();
      expect(dateLock.checking, `expenses:dateLock.checking missing in '${locale}'`).toBeDefined();
      expect(typeof dateLock.checking).toBe("string");
      expect((dateLock.checking as string).length).toBeGreaterThan(0);
    });
  }
});
