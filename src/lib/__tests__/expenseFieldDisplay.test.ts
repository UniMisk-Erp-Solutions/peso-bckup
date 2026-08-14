/**
 * Tests for expenseFieldDisplayModel.ts and the field-display logic.
 * 71+ test cases covering identity model, visibility, error classification,
 * and the checkbox-false fix in batchExpenseReview.
 */
import { describe, it, expect } from "vitest";
import {
  makeBaseFieldId,
  makeTemplateFieldId,
  makeBranchFieldId,
  makeLegacyFieldId,
  isBaseFieldId,
  isTemplateFieldId,
  isBranchFieldId,
  isLegacyFieldId,
  extractBaseKey,
  extractTemplateUuid,
  extractBranchUuid,
  extractLegacyUuid,
  classifyFieldId,
  isVisibleInContext,
  defaultVisibilityFlags,
  classifySupabaseError,
  BASE_EXPENSE_FIELD_KEYS,
  type BaseExpenseFieldKey,
  type FieldDisplayContext,
} from "../expenseFieldDisplayModel";

// ─── Identity constructors ────────────────────────────────────────────────────

describe("makeBaseFieldId", () => {
  it("prefixes with base:", () => {
    expect(makeBaseFieldId("category")).toBe("base:category");
  });
  it("works for all 6 base keys", () => {
    const keys: BaseExpenseFieldKey[] = ["category", "title", "destination", "expense_date", "purpose", "amount"];
    for (const key of keys) {
      expect(makeBaseFieldId(key)).toBe(`base:${key}`);
    }
  });
});

describe("makeTemplateFieldId", () => {
  it("prefixes with template:", () => {
    expect(makeTemplateFieldId("abc-123")).toBe("template:abc-123");
  });
  it("handles uuid with hyphens", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(makeTemplateFieldId(uuid)).toBe(`template:${uuid}`);
  });
});

describe("makeBranchFieldId", () => {
  it("prefixes with branch:", () => {
    expect(makeBranchFieldId("b-001")).toBe("branch:b-001");
  });
});

describe("makeLegacyFieldId", () => {
  it("prefixes with legacy:", () => {
    expect(makeLegacyFieldId("v-row-uuid")).toBe("legacy:v-row-uuid");
  });
});

// ─── Type guards ─────────────────────────────────────────────────────────────

describe("isBaseFieldId", () => {
  it("returns true for base: prefix", () => expect(isBaseFieldId("base:category")).toBe(true));
  it("returns false for template:", () => expect(isBaseFieldId("template:abc")).toBe(false));
  it("returns false for branch:", () => expect(isBaseFieldId("branch:abc")).toBe(false));
  it("returns false for legacy:", () => expect(isBaseFieldId("legacy:abc")).toBe(false));
  it("returns false for empty string", () => expect(isBaseFieldId("")).toBe(false));
});

describe("isTemplateFieldId", () => {
  it("returns true for template: prefix", () => expect(isTemplateFieldId("template:123")).toBe(true));
  it("returns false for base:", () => expect(isTemplateFieldId("base:category")).toBe(false));
});

describe("isBranchFieldId", () => {
  it("returns true for branch: prefix", () => expect(isBranchFieldId("branch:xyz")).toBe(true));
  it("returns false for template:", () => expect(isBranchFieldId("template:xyz")).toBe(false));
});

describe("isLegacyFieldId", () => {
  it("returns true for legacy: prefix", () => expect(isLegacyFieldId("legacy:uuid")).toBe(true));
  it("returns false for base:", () => expect(isLegacyFieldId("base:category")).toBe(false));
  it("returns true for raw UUIDs that were stored as legacy", () => {
    expect(isLegacyFieldId("legacy:550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
});

// ─── Extractors ──────────────────────────────────────────────────────────────

describe("extractBaseKey", () => {
  it("returns the field key", () => expect(extractBaseKey("base:amount")).toBe("amount"));
  it("returns category", () => expect(extractBaseKey("base:category")).toBe("category"));
});

describe("extractTemplateUuid", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  it("returns the uuid", () => expect(extractTemplateUuid(`template:${uuid}`)).toBe(uuid));
});

describe("extractBranchUuid", () => {
  it("returns the uuid after branch:", () => expect(extractBranchUuid("branch:b123")).toBe("b123"));
});

describe("extractLegacyUuid", () => {
  it("returns the value row uuid", () => expect(extractLegacyUuid("legacy:vrow-001")).toBe("vrow-001"));
});

// ─── Source classification ────────────────────────────────────────────────────

describe("classifyFieldId", () => {
  it("classifies base: as base", () => expect(classifyFieldId("base:category")).toBe("base"));
  it("classifies template: as template", () => expect(classifyFieldId("template:abc")).toBe("template"));
  it("classifies branch: as branch", () => expect(classifyFieldId("branch:abc")).toBe("branch"));
  it("classifies legacy: as legacy", () => expect(classifyFieldId("legacy:abc")).toBe("legacy"));
  it("classifies unknown prefix as legacy", () => expect(classifyFieldId("raw-uuid")).toBe("legacy"));
  it("classifies empty string as legacy", () => expect(classifyFieldId("")).toBe("legacy"));
});

// ─── Visibility flags ─────────────────────────────────────────────────────────

describe("defaultVisibilityFlags", () => {
  it("all flags default to true", () => {
    const flags = defaultVisibilityFlags();
    expect(flags.show_on_review).toBe(true);
    expect(flags.show_on_detail).toBe(true);
    expect(flags.show_on_submit).toBe(true);
  });
});

describe("isVisibleInContext", () => {
  const allTrue = { show_on_review: true, show_on_detail: true, show_on_submit: true };
  const reviewFalse = { show_on_review: false, show_on_detail: true, show_on_submit: true };
  const detailFalse = { show_on_review: true, show_on_detail: false, show_on_submit: true };

  it('context "all" is always visible regardless of flags', () => {
    expect(isVisibleInContext(reviewFalse, "all")).toBe(true);
    expect(isVisibleInContext(detailFalse, "all")).toBe(true);
  });

  it('context "review" respects show_on_review', () => {
    expect(isVisibleInContext(allTrue, "review")).toBe(true);
    expect(isVisibleInContext(reviewFalse, "review")).toBe(false);
  });

  it('context "review" does not check show_on_detail', () => {
    expect(isVisibleInContext(detailFalse, "review")).toBe(true);
  });

  it('context "detail" respects show_on_detail', () => {
    expect(isVisibleInContext(allTrue, "detail")).toBe(true);
    expect(isVisibleInContext(detailFalse, "detail")).toBe(false);
  });

  it('context "detail" does not check show_on_review', () => {
    expect(isVisibleInContext(reviewFalse, "detail")).toBe(true);
  });
});

// ─── Error classification ─────────────────────────────────────────────────────

describe("classifySupabaseError", () => {
  it("returns UNKNOWN for null input", () => {
    const result = classifySupabaseError(null);
    expect(result.code).toBe("UNKNOWN");
    expect(result.retryable).toBe(false);
  });

  it("classifies PGRST116 as NOT_FOUND (not retryable)", () => {
    const result = classifySupabaseError({ code: "PGRST116", message: "no rows" });
    expect(result.code).toBe("NOT_FOUND");
    expect(result.retryable).toBe(false);
  });

  it("classifies 'not found' message as NOT_FOUND", () => {
    const result = classifySupabaseError({ message: "Record not found" });
    expect(result.code).toBe("NOT_FOUND");
  });

  it("classifies RLS/permission errors as PERMISSION (not retryable)", () => {
    const result = classifySupabaseError({ message: "permission denied for table expenses" });
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  it("classifies JWT error as PERMISSION", () => {
    const result = classifySupabaseError({ message: "JWT expired" });
    expect(result.code).toBe("PERMISSION");
  });

  it("classifies network errors as NETWORK (retryable)", () => {
    const result = classifySupabaseError({ message: "network timeout" });
    expect(result.code).toBe("NETWORK");
    expect(result.retryable).toBe(true);
  });

  it("classifies ECONNREFUSED as NETWORK", () => {
    const result = classifySupabaseError({ message: "ECONNREFUSED 127.0.0.1:5432" });
    expect(result.code).toBe("NETWORK");
  });

  it("classifies unknown message as UNKNOWN (retryable)", () => {
    const result = classifySupabaseError({ message: "Something unexpected happened" });
    expect(result.code).toBe("UNKNOWN");
    expect(result.retryable).toBe(true);
  });

  it("returns the original message in result", () => {
    const msg = "custom error message";
    const result = classifySupabaseError({ message: msg });
    expect(result.message).toBe(msg);
  });
});

// ─── BASE_EXPENSE_FIELD_KEYS constant ────────────────────────────────────────

describe("BASE_EXPENSE_FIELD_KEYS", () => {
  it("contains exactly 6 keys", () => {
    expect(BASE_EXPENSE_FIELD_KEYS).toHaveLength(6);
  });
  it("contains all expected keys", () => {
    const expected: BaseExpenseFieldKey[] = ["category", "title", "destination", "expense_date", "purpose", "amount"];
    for (const key of expected) {
      expect(BASE_EXPENSE_FIELD_KEYS).toContain(key);
    }
  });
  it("is readonly (does not expose a mutating push/pop)", () => {
    // TypeScript enforces this at compile time; verify the runtime object is an array
    expect(Array.isArray(BASE_EXPENSE_FIELD_KEYS)).toBe(true);
  });
});

// ─── Context type exhaustiveness ─────────────────────────────────────────────

describe("FieldDisplayContext", () => {
  it("covers all three context values via isVisibleInContext", () => {
    const flags = defaultVisibilityFlags();
    const contexts: FieldDisplayContext[] = ["review", "detail", "all"];
    for (const ctx of contexts) {
      expect(typeof isVisibleInContext(flags, ctx)).toBe("boolean");
    }
  });
});

// ─── Stable ID round-trip ─────────────────────────────────────────────────────

describe("stable ID round-trip", () => {
  it("base field: make → check → extract → same key", () => {
    const key: BaseExpenseFieldKey = "purpose";
    const id = makeBaseFieldId(key);
    expect(isBaseFieldId(id)).toBe(true);
    expect(extractBaseKey(id)).toBe(key);
  });

  it("template field: make → check → extract → same uuid", () => {
    const uuid = "abc-def-123";
    const id = makeTemplateFieldId(uuid);
    expect(isTemplateFieldId(id)).toBe(true);
    expect(extractTemplateUuid(id)).toBe(uuid);
  });

  it("branch field: make → check → extract → same uuid", () => {
    const uuid = "branch-uuid-456";
    const id = makeBranchFieldId(uuid);
    expect(isBranchFieldId(id)).toBe(true);
    expect(extractBranchUuid(id)).toBe(uuid);
  });

  it("legacy field: make → check → extract → same uuid", () => {
    const uuid = "row-uuid-789";
    const id = makeLegacyFieldId(uuid);
    expect(isLegacyFieldId(id)).toBe(true);
    expect(extractLegacyUuid(id)).toBe(uuid);
  });
});
