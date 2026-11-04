import { describe, it, expect } from "vitest";
import { friendlyJobFailureMessage } from "@/lib/reportViewMessages";

describe("friendlyJobFailureMessage (historical failed jobs keep their raw text in the DB)", () => {
  it("maps the exact production timeout strings", () => {
    for (const raw of [
      "page 1: canceling statement due to statement timeout",
      "page 2: canceling statement due to statement timeout",
      "timeline page 1: canceling statement due to statement timeout",
    ]) {
      const msg = friendlyJobFailureMessage(raw);
      expect(msg).toMatch(/took too long while processing a large data set/);
      expect(msg).not.toMatch(/statement timeout|canceling/i);
    }
  });

  it("hides other database errors behind a generic message", () => {
    expect(friendlyJobFailureMessage("page 3: relation \"x\" does not exist")).toMatch(/could not be generated/);
  });

  it("keeps our own sentences, including the 'too large' guidance", () => {
    const own = "This report is too large to build in one pass. Narrow the date range or filters and try again.";
    expect(friendlyJobFailureMessage(own)).toBe(own);
  });

  it("falls back for empty values", () => {
    expect(friendlyJobFailureMessage(null)).toMatch(/could not be generated/);
    expect(friendlyJobFailureMessage("  ")).toMatch(/could not be generated/);
  });
});

import { reportStartErrorMessage } from "@/lib/reportViewMessages";

describe("reportStartErrorMessage (foreground start failures)", () => {
  it("never shows raw database text", () => {
    expect(reportStartErrorMessage(new Error("canceling statement due to statement timeout"))).toMatch(/took too long/i);
    expect(reportStartErrorMessage(new Error('function public.create_x(uuid) does not exist'))).toMatch(/could not be generated/i);
    expect(reportStartErrorMessage(new Error("PGRST202 something"))).toMatch(/could not be generated/i);
  });
  it("maps a permission failure to a plain sentence", () => {
    expect(reportStartErrorMessage(new Error("not permitted to generate this report"))).toBe(
      "You don't have access to generate this report.",
    );
  });
});
