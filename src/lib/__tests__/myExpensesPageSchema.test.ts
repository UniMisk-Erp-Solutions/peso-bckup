import { describe, it, expect } from "vitest";
import {
  validateMyExpensesPageResponse,
  MyExpensesPageValidationError,
} from "../myExpensesPageSchema";

const VALID_ROW = {
  id: "e1",
  user_id: "u1",
  title: "Fuel",
  destination: "Sanand",
  trip_start: "2026-08-10",
  trip_end: "2026-08-10",
  status: "approved",
  total_amount: 500,
  created_at: "2026-08-10T00:00:00Z",
  transaction_number: "TX1",
  purpose: "Client visit",
  category: "Travel",
  isResubmitted: false,
  wasReviewerCorrected: false,
  custom_fields: { Project: "Alpha" },
};

const VALID_PAYLOAD = {
  items: [VALID_ROW],
  filtered_total: 1,
  total_pages: 1,
  page: 1,
  page_size: 25,
};

function badRowMissing(field: string) {
  const row = { ...VALID_ROW } as Record<string, unknown>;
  delete row[field];
  return row;
}

describe("validateMyExpensesPageResponse -- happy path", () => {
  it("accepts a well-formed payload and returns it typed", () => {
    const result = validateMyExpensesPageResponse(VALID_PAYLOAD);
    expect(result.items).toHaveLength(1);
    expect(result.filtered_total).toBe(1);
  });

  it("accepts a valid JS number for every numeric field", () => {
    const result = validateMyExpensesPageResponse(VALID_PAYLOAD);
    expect(result.items[0].total_amount).toBe(500);
    expect(result.filtered_total).toBe(1);
    expect(result.total_pages).toBe(1);
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(25);
  });

  it("accepts a valid numeric string for every numeric field (large numerics can arrive as strings from Postgres)", () => {
    const result = validateMyExpensesPageResponse({
      items: [{ ...VALID_ROW, total_amount: "500.25" }],
      filtered_total: "42",
      total_pages: "2",
      page: "1",
      page_size: "25",
    });
    expect(result.items[0].total_amount).toBe(500.25);
    expect(result.filtered_total).toBe(42);
    expect(result.total_pages).toBe(2);
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(25);
  });

  it("accepts null for the genuinely nullable fields (transaction_number/purpose/category)", () => {
    const result = validateMyExpensesPageResponse({
      ...VALID_PAYLOAD,
      items: [{ ...VALID_ROW, transaction_number: null, purpose: null, category: null }],
    });
    expect(result.items[0].transaction_number).toBeNull();
    expect(result.items[0].purpose).toBeNull();
    expect(result.items[0].category).toBeNull();
  });
});

describe("validateMyExpensesPageResponse -- strict numeric validation (never silently normalized to 0)", () => {
  it.each(["abc", "", " ", NaN, Infinity, -Infinity, {}, [], null, undefined])(
    "REJECTS total_amount = %p instead of coercing it to 0",
    (bad) => {
      expect(() =>
        validateMyExpensesPageResponse({
          ...VALID_PAYLOAD,
          items: [{ ...VALID_ROW, total_amount: bad }],
        }),
      ).toThrow(MyExpensesPageValidationError);
    },
  );

  it.each(["abc", "", " ", NaN, Infinity, {}, [], null, undefined])(
    "REJECTS filtered_total = %p instead of coercing it to 0",
    (bad) => {
      expect(() =>
        validateMyExpensesPageResponse({ ...VALID_PAYLOAD, filtered_total: bad }),
      ).toThrow(MyExpensesPageValidationError);
    },
  );

  it("REJECTS total_pages/page/page_size the same way", () => {
    for (const field of ["total_pages", "page", "page_size"]) {
      expect(() =>
        validateMyExpensesPageResponse({ ...VALID_PAYLOAD, [field]: "abc" }),
      ).toThrow(MyExpensesPageValidationError);
    }
  });
});

describe("validateMyExpensesPageResponse -- malformed payloads produce a controlled error, never a silent default", () => {
  it("throws for a missing 'items' field", () => {
    expect(() =>
      validateMyExpensesPageResponse({ filtered_total: 1, total_pages: 1, page: 1, page_size: 25 }),
    ).toThrow(MyExpensesPageValidationError);
  });

  it("throws when 'items' is not an array", () => {
    expect(() =>
      validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: { 0: VALID_ROW } }),
    ).toThrow(MyExpensesPageValidationError);
    expect(() => validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: "not-an-array" })).toThrow(
      MyExpensesPageValidationError,
    );
  });

  it("throws for a null response (e.g. an unexpected RPC shape)", () => {
    expect(() => validateMyExpensesPageResponse(null)).toThrow(MyExpensesPageValidationError);
  });

  it("throws for a completely different shape (e.g. a plain array)", () => {
    expect(() => validateMyExpensesPageResponse([1, 2, 3])).toThrow(MyExpensesPageValidationError);
  });

  it("throws when an item is missing its required 'id'", () => {
    expect(() =>
      validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: [badRowMissing("id")] }),
    ).toThrow(MyExpensesPageValidationError);
  });

  it("throws when an item is missing 'trip_start' (the authoritative date field)", () => {
    expect(() =>
      validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: [badRowMissing("trip_start")] }),
    ).toThrow(MyExpensesPageValidationError);
  });

  it("throws when an item is missing any other field the RPC always includes (title/destination/trip_end/status/created_at/user_id/isResubmitted/wasReviewerCorrected/custom_fields)", () => {
    for (const field of [
      "title",
      "destination",
      "trip_end",
      "status",
      "created_at",
      "user_id",
      "isResubmitted",
      "wasReviewerCorrected",
      "custom_fields",
    ]) {
      expect(
        () => validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: [badRowMissing(field)] }),
        `expected missing '${field}' to be rejected`,
      ).toThrow(MyExpensesPageValidationError);
    }
  });

  it("throws when 'status' has the wrong type (a number instead of a string)", () => {
    expect(() =>
      validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: [{ ...VALID_ROW, status: 200 }] }),
    ).toThrow(MyExpensesPageValidationError);
  });

  it("throws when 'isResubmitted'/'wasReviewerCorrected' have the wrong type", () => {
    expect(() =>
      validateMyExpensesPageResponse({
        ...VALID_PAYLOAD,
        items: [{ ...VALID_ROW, isResubmitted: "false" }],
      }),
    ).toThrow(MyExpensesPageValidationError);
  });

  it("throws when 'custom_fields' is the wrong type -- the real contract never returns anything but a string->string map", () => {
    for (const bad of [null, "not-an-object", 42, ["Project", "Alpha"]]) {
      expect(() =>
        validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: [{ ...VALID_ROW, custom_fields: bad }] }),
      ).toThrow(MyExpensesPageValidationError);
    }
  });

  it("throws when a custom_fields VALUE is not a string (field_value is a NOT NULL text column server-side)", () => {
    expect(() =>
      validateMyExpensesPageResponse({
        ...VALID_PAYLOAD,
        items: [{ ...VALID_ROW, custom_fields: { Project: 123 } }],
      }),
    ).toThrow(MyExpensesPageValidationError);
  });

  it("throws when the genuinely-nullable fields have the wrong (non-null, non-string) type", () => {
    for (const field of ["transaction_number", "purpose", "category"]) {
      expect(() =>
        validateMyExpensesPageResponse({ ...VALID_PAYLOAD, items: [{ ...VALID_ROW, [field]: 42 }] }),
      ).toThrow(MyExpensesPageValidationError);
    }
  });
});
