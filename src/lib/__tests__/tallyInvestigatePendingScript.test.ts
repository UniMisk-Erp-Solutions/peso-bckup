import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("investigate-pending-tally-work.mjs", () => {
  it("invokes main and forbids mutations", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/tally-integration/investigate-pending-tally-work.mjs"),
      "utf-8",
    );
    expect(src).toContain("main()");
    expect(src).not.toMatch(/\b(UPDATE|DELETE|INSERT|PATCH|QUARANTINE_CONFIRM)\b/);
    expect(src).toContain("fetchViaRest");
    expect(src).toContain('method: "POST"');
    expect(src).toMatch(/grant_type=password/);
    expect(src).not.toContain(".patch(");
  });

  it("does not select nonexistent tally_sync_jobs.updated_at", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/tally-integration/investigate-pending-tally-work.mjs"),
      "utf-8",
    );
    expect(src).not.toMatch(/tally_sync_jobs\?[^"]*updated_at/);
    expect(src).toContain("JOBS_SELECT");
    expect(src).toContain("BATCHES_SELECT");
  });
});
