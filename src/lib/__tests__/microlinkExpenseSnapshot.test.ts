import { describe, expect, it } from "vitest";

import {
  buildMicroLinkExpenseSnapshotV1,
  snapshotBusinessValues,
  visibleBusinessValues,
  SnapshotNotReadyError,
  type MicroLinkFieldVisibility,
  type MicroLinkFormState,
} from "@/lib/microlinkExpenseSnapshot";

const KEY = "11111111-1111-1111-1111-111111111111";

const TRAVELLING: MicroLinkFieldVisibility = {
  projectUniqueId: true,
  fromLocation: true,
  toLocation: true,
};
const HOTEL: MicroLinkFieldVisibility = {
  projectUniqueId: true,
  fromLocation: false,
  toLocation: false,
};

function form(overrides: Partial<MicroLinkFormState> = {}): MicroLinkFormState {
  return {
    title: "Site visit",
    destination: "Halol",
    tripStart: "2026-09-09",
    category: "Travelling (Public and Private Transport)",
    totalAmount: 123.45,
    purpose: "client meeting",
    projectUniqueId: "202605M117",
    fromLocation: "Ahmedabad",
    toLocation: "Gandhinagar",
    ...overrides,
  };
}

const build = (f: MicroLinkFormState, v = TRAVELLING, resolved = true) =>
  buildMicroLinkExpenseSnapshotV1(f, {
    idempotencyKey: KEY,
    visibility: v,
    configResolved: resolved,
  });

describe("buildMicroLinkExpenseSnapshotV1 — a visible value can never be dropped", () => {
  /**
   * THE regression test for the 2026-09-08 incident family. If a future edit
   * removes a field from the snapshot builder, this fails.
   */
  it("carries every visible field the employee filled, in one object", () => {
    const s = build(form());

    expect(s.core.title).toBe("Site visit");
    expect(s.core.destination).toBe("Halol");
    expect(s.core.trip_start).toBe("2026-09-09");
    expect(s.core.category).toBe("Travelling (Public and Private Transport)");
    expect(s.core.total_amount).toBe(123.45);
    expect(s.core.purpose).toBe("client meeting");

    expect(s.microlink.project_unique_id).toBe("202605M117");
    expect(s.microlink.from_location).toBe("Ahmedabad");
    expect(s.microlink.to_location).toBe("Gandhinagar");

    // and nothing the employee entered is missing from the flattened view
    expect(snapshotBusinessValues(s)).toEqual(visibleBusinessValues(form(), TRAVELLING));
  });

  it("property: for 100+ generated forms, every visible value survives", () => {
    const projects = ["202605M117", "202512M595", "199601M1", "197001M3"];
    const cities = ["Ahmedabad", "Halol", "Vadodara", "Surat", "Rajkot"];
    let checked = 0;

    for (let i = 0; i < 120; i++) {
      const visibility = i % 3 === 0 ? HOTEL : TRAVELLING;
      const f = form({
        title: `Trip ${i}`,
        destination: cities[i % cities.length],
        tripStart: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
        totalAmount: Number(((i + 1) * 7.31).toFixed(2)),
        purpose: i % 4 === 0 ? undefined : `purpose ${i}`,
        projectUniqueId: projects[i % projects.length],
        fromLocation: visibility.fromLocation ? cities[(i + 1) % cities.length] : undefined,
        toLocation: visibility.toLocation ? cities[(i + 2) % cities.length] : undefined,
        additionalFields:
          i % 5 === 0
            ? [{ templateId: "aaaaaaaa-0000-0000-0000-00000000000" + (i % 10), value: `extra ${i}` }]
            : [],
      });

      const s = build(f, visibility);
      expect(snapshotBusinessValues(s)).toEqual(visibleBusinessValues(f, visibility));
      checked++;
    }
    expect(checked).toBe(120);
  });

  it("omits a MicroLink field only when the category genuinely does not show it", () => {
    const s = build(form({ fromLocation: undefined, toLocation: undefined }), HOTEL);
    expect(s.microlink.project_unique_id).toBe("202605M117");
    expect(s.microlink.from_location).toBeUndefined();
    expect(s.microlink.to_location).toBeUndefined();
  });

  it("REFUSES to build while branch configuration is still loading", () => {
    // The old client treated "not loaded yet" as "no conditional fields" and
    // silently dropped everything. It must now be impossible to build at all.
    expect(() => build(form(), TRAVELLING, false)).toThrow(SnapshotNotReadyError);
    try {
      build(form(), TRAVELLING, false);
    } catch (e) {
      expect((e as SnapshotNotReadyError).reason).toBe("unresolved_config");
    }
  });

  it.each([
    ["projectUniqueId", "project_unique_id"],
    ["fromLocation", "from_location"],
    ["toLocation", "to_location"],
  ])("throws rather than silently omitting a visible but empty %s", (formKey, field) => {
    const f = form({ [formKey]: "" } as Partial<MicroLinkFormState>);
    expect(() => build(f)).toThrow(SnapshotNotReadyError);
    try {
      build(f);
    } catch (e) {
      expect((e as SnapshotNotReadyError).field).toBe(field);
      expect((e as SnapshotNotReadyError).reason).toBe("missing_visible_value");
    }
  });

  it.each(["title", "destination", "tripStart", "category"])(
    "throws on a missing core field: %s",
    (key) => {
      expect(() => build(form({ [key]: "  " } as Partial<MicroLinkFormState>))).toThrow(
        SnapshotNotReadyError,
      );
    },
  );

  it("parses a currency-formatted amount rather than shipping NaN", () => {
    expect(build(form({ totalAmount: "₹1,234.50" })).core.total_amount).toBe(1234.5);
    expect(() => build(form({ totalAmount: "abc" }))).toThrow(SnapshotNotReadyError);
  });

  it("forwards project_id/project_name only when the employee actually chose them", () => {
    expect(build(form()).microlink.project_id).toBeUndefined();
    const chosen = build(form({ projectId: "326", projectName: "Training" }));
    expect(chosen.microlink.project_id).toBe("326");
    expect(chosen.microlink.project_name).toBe("Training");
  });

  it("is frozen — no later effect can mutate a snapshot mid-flight", () => {
    const s = build(form());
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.core)).toBe(true);
    expect(Object.isFrozen(s.microlink)).toBe(true);
    expect(() => {
      (s.microlink as { project_unique_id?: string }).project_unique_id = "TAMPERED";
    }).toThrow();
    expect(s.microlink.project_unique_id).toBe("202605M117");
  });

  it("rapid project switching A -> B -> A ends with exactly A", () => {
    // The snapshot is built once from final state, so a late response for B
    // cannot reach the server: there is no second read.
    let state = form({ projectUniqueId: "A-PROJECT" });
    state = { ...state, projectUniqueId: "B-PROJECT" };
    state = { ...state, projectUniqueId: "A-PROJECT" };
    const s = build(state);
    expect(s.microlink.project_unique_id).toBe("A-PROJECT");
  });

  it("carries expense_id and expected_revision when editing an existing draft", () => {
    const s = build(form({ expenseId: "abc-123", expectedRevision: 7 }));
    expect(s.expense_id).toBe("abc-123");
    expect(s.expected_revision).toBe(7);
  });

  it("drops blank additional fields but keeps meaningful falsy text", () => {
    const s = build(
      form({
        additionalFields: [
          { templateId: "t1", value: "  " },
          { templateId: "t2", value: "0" },
          { templateId: "t3", value: null },
        ],
      }),
    );
    expect(s.additional_fields).toEqual([{ template_id: "t2", value: "0" }]);
  });
});
