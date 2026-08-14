/**
 * Locale parity for fieldDisplay + batchReview loading keys
 *
 * T-LOC-31  EN/HI/GU contain all required fieldDisplay keys
 * T-LOC-32  EN/HI/GU contain all required batchReview loading keys
 * T-LOC-33  No English fallback appears in Hindi/Gujarati for the new keys
 */

import { describe, it, expect } from "vitest";
import enExpenses from "@/locales/en/expenses.json";
import hiExpenses from "@/locales/hi/expenses.json";
import guExpenses from "@/locales/gu/expenses.json";

const REQUIRED_FIELD_DISPLAY_KEYS = [
  "sectionTitle",
  "loading",
  "loadingDescription",
  "loadFailed",
  "loadFailedDescription",
  "retry",
  "checkboxYes",
  "checkboxNo",
] as const;

const REQUIRED_BATCH_LOADING_KEYS = [
  "loadingDetails",
  "loadingDetailsDescription",
  "loadDetailsFailed",
  "loadDetailsFailedDescription",
] as const;

describe("locale fieldDisplay + batchReview loading keys", () => {
  it("T-LOC-31: EN fieldDisplay contains all required keys", () => {
    for (const key of REQUIRED_FIELD_DISPLAY_KEYS) {
      expect(
        enExpenses.fieldDisplay,
        `EN fieldDisplay.${key} missing`,
      ).toHaveProperty(key);
    }
  });

  it("T-LOC-31: HI fieldDisplay contains all required keys", () => {
    for (const key of REQUIRED_FIELD_DISPLAY_KEYS) {
      expect(
        hiExpenses.fieldDisplay,
        `HI fieldDisplay.${key} missing`,
      ).toHaveProperty(key);
    }
  });

  it("T-LOC-31: GU fieldDisplay contains all required keys", () => {
    for (const key of REQUIRED_FIELD_DISPLAY_KEYS) {
      expect(
        guExpenses.fieldDisplay,
        `GU fieldDisplay.${key} missing`,
      ).toHaveProperty(key);
    }
  });

  it("T-LOC-32: EN batchReview contains all required loading keys", () => {
    for (const key of REQUIRED_BATCH_LOADING_KEYS) {
      expect(
        enExpenses.batchReview,
        `EN batchReview.${key} missing`,
      ).toHaveProperty(key);
    }
  });

  it("T-LOC-32: HI batchReview contains all required loading keys", () => {
    for (const key of REQUIRED_BATCH_LOADING_KEYS) {
      expect(
        hiExpenses.batchReview,
        `HI batchReview.${key} missing`,
      ).toHaveProperty(key);
    }
  });

  it("T-LOC-32: GU batchReview contains all required loading keys", () => {
    for (const key of REQUIRED_BATCH_LOADING_KEYS) {
      expect(
        guExpenses.batchReview,
        `GU batchReview.${key} missing`,
      ).toHaveProperty(key);
    }
  });

  it("T-LOC-33: Hindi loading key is not a copy of the English string", () => {
    expect(hiExpenses.fieldDisplay.loading).not.toBe(enExpenses.fieldDisplay.loading);
    expect(hiExpenses.batchReview.loadingDetails).not.toBe(enExpenses.batchReview.loadingDetails);
  });

  it("T-LOC-33: Gujarati loading key is not a copy of the English string", () => {
    expect(guExpenses.fieldDisplay.loading).not.toBe(enExpenses.fieldDisplay.loading);
    expect(guExpenses.batchReview.loadingDetails).not.toBe(enExpenses.batchReview.loadingDetails);
  });
});
