import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const panel = readFileSync(
  resolve(process.cwd(), "src/components/ServerReportExportPanel.tsx"),
  "utf-8",
);
const jobs = readFileSync(resolve(process.cwd(), "src/lib/tallySyncJobs.ts"), "utf-8");
const startFn = readFileSync(
  resolve(process.cwd(), "supabase/functions/start-tally-sync/index.ts"),
  "utf-8",
);
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261005180000_tally_sync_background_phase36.sql"),
  "utf-8",
);

describe("Phase 3.6 client API", () => {
  it("startTallySync invokes start-tally-sync edge function once", () => {
    expect(jobs).toContain('invoke("start-tally-sync"');
    expect(jobs).not.toContain("run-tally-sync-job");
  });
});

describe("Phase 3.6 server dispatch", () => {
  it("start-tally-sync creates job then dispatches worker in background", () => {
    expect(startFn).toContain("create_tally_sync_job_v1");
    expect(startFn).toContain("run-tally-sync-job");
    expect(startFn).toContain("EdgeRuntime.waitUntil");
    expect(startFn).toContain("accepted: true");
  });
});

describe("Phase 3.6 migration", () => {
  it("adds stale recovery for ops", () => {
    expect(sql).toContain("recover_stale_tally_sync_jobs_v1");
    expect(sql).toContain("dispatch_requested_at");
  });
});

describe("Reports panel Tally UX", () => {
  it("restores latest in-flight tally job after page reload", () => {
    expect(panel).toContain("fetchLatestTallySyncJob");
    expect(panel).toContain("isActiveTallySyncStatus");
    expect(panel).toContain("startTallyJobPoll");
  });
});
