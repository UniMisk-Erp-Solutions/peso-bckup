import { describe, expect, it } from "vitest";
import {
  FEATURES_TAB_EXCLUDED_KEYS,
  FEATURE_CATEGORIES,
  OTHER_CATEGORY_ID,
  categorizeFeatures,
  computeFeatureChanges,
  filterFeatureGroups,
} from "@/lib/masterAdminFeatures";
import {
  MASTER_ADMIN_FEATURE_DEFINITIONS,
  ORGANIZATION_FEATURE_KEYS,
  type FeatureDefinition,
} from "@/lib/organizationFeatureKeys";

describe("Master Admin feature categories (DOC-165)", () => {
  const groups = categorizeFeatures();
  const listed = groups.flatMap((g) => g.features.map((f) => f.key as string));

  it("lists every feature flag exactly once, except the Security-tab flag", () => {
    const expected = MASTER_ADMIN_FEATURE_DEFINITIONS.filter(
      (d) => !FEATURES_TAB_EXCLUDED_KEYS.includes(d.key),
    ).map((d) => d.key as string);
    expect([...listed].sort()).toEqual([...expected].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps org_blocked out of the Features tab (it lives in Security)", () => {
    expect(listed).not.toContain(ORGANIZATION_FEATURE_KEYS.org_blocked);
  });

  it("every flag is mapped to a category (nothing falls into Other today)", () => {
    expect(groups.some((g) => g.id === OTHER_CATEGORY_ID)).toBe(false);
    const mapped = FEATURE_CATEGORIES.flatMap((c) => c.keys as string[]);
    for (const d of MASTER_ADMIN_FEATURE_DEFINITIONS) {
      if (FEATURES_TAB_EXCLUDED_KEYS.includes(d.key)) continue;
      expect(mapped).toContain(d.key);
    }
  });

  it("puts a flag that has no category into Other features instead of dropping it", () => {
    const extra: FeatureDefinition = {
      key: "brand_new_flag" as FeatureDefinition["key"],
      labelKey: "features.brandNew",
      requiresSubdomain: false,
    };
    const g = categorizeFeatures([...MASTER_ADMIN_FEATURE_DEFINITIONS, extra]);
    const other = g.find((x) => x.id === OTHER_CATEGORY_ID);
    expect(other?.features.map((f) => f.key)).toEqual(["brand_new_flag"]);
  });
});

describe("filterFeatureGroups", () => {
  const groups = categorizeFeatures();
  const labelOf = (d: FeatureDefinition) => d.labelKey;

  it("returns everything for an empty query", () => {
    expect(filterFeatureGroups(groups, "  ", labelOf)).toEqual(groups);
  });

  it("matches the label case-insensitively and drops empty groups", () => {
    const r = filterFeatureGroups(groups, "TALLYINTEGRATION", labelOf);
    expect(r.flatMap((g) => g.features.map((f) => f.key))).toEqual([ORGANIZATION_FEATURE_KEYS.tally_integration]);
    expect(r).toHaveLength(1);
  });

  it("matches the raw key too", () => {
    const r = filterFeatureGroups(groups, "hierarchy_executive", () => "x");
    expect(r.flatMap((g) => g.features.map((f) => f.key))).toEqual([ORGANIZATION_FEATURE_KEYS.hierarchy_executive]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterFeatureGroups(groups, "zzzz-nope", labelOf)).toEqual([]);
  });
});

describe("computeFeatureChanges", () => {
  const keys = ["a", "b", "c"];

  it("reports no change when draft equals saved", () => {
    expect(computeFeatureChanges({ a: true }, { a: true }, keys)).toEqual([]);
  });

  it("treats a missing key as off", () => {
    expect(computeFeatureChanges({}, { a: false }, keys)).toEqual([]);
    expect(computeFeatureChanges({}, { a: true }, keys)).toEqual([{ key: "a", enabled: true }]);
  });

  it("reports both turn-on and turn-off", () => {
    expect(computeFeatureChanges({ a: true, b: false }, { a: false, b: true }, keys)).toEqual([
      { key: "a", enabled: false },
      { key: "b", enabled: true },
    ]);
  });

  it("ignores keys that are not listed", () => {
    expect(computeFeatureChanges({}, { zzz: true }, keys)).toEqual([]);
  });
});
