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
// expenses:form.receiptsTempFallback
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
