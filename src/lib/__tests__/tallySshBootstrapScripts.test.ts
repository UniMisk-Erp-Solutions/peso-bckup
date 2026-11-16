// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import {
  buildRemotePsqlBash,
  parsePsqlJsonStdout,
  splitPsqlOutput,
} from "../../../scripts/tally-integration/_sshPsqlRemote.mjs";
import {
  generatePairingCodePlaintext,
  SMOKE_ORG,
  TALLY_COMPANY,
} from "../../../scripts/tally-integration/_pairingCodeShared.mjs";
import { evaluateQueueSafe } from "../../../scripts/tally-integration/_queueSafeShared.mjs";


const ISSUE_SCRIPT = resolve(process.cwd(), "scripts/tally-integration/ssh-issue-test-pairing-code.mjs");
const VERIFY_SCRIPT = resolve(process.cwd(), "scripts/tally-integration/ssh-verify-queue-safe.mjs");
const TRIGGER_SYNC_SCRIPT = resolve(process.cwd(), "scripts/tally-integration/trigger-smoke-daily-sync.mjs");

describe("SSH bootstrap scripts", () => {
  it("pairing and verify scripts pass node --check and dynamic import", async () => {
    for (const script of [ISSUE_SCRIPT, VERIFY_SCRIPT, TRIGGER_SYNC_SCRIPT]) {
      const check = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
      expect(check.status, `${script} --check: ${check.stderr}`).toBe(0);
    }
    const importCheck = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "import('./scripts/tally-integration/ssh-issue-test-pairing-code.mjs').then(m => console.log(JSON.stringify([m.TALLY_COMPANY, m.SMOKE_ORG])))"],
      { encoding: "utf8", cwd: process.cwd() },
    );
    expect(importCheck.status, importCheck.stderr).toBe(0);
    expect(JSON.parse(importCheck.stdout.trim())).toEqual(["PesoWise Integration Test", SMOKE_ORG]);
    expect(TALLY_COMPANY).toBe("PesoWise Integration Test");
  });

  it("pairing issuer is test-only and mirrors pairing code hash insert", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/tally-integration/ssh-issue-test-pairing-code.mjs"),
      "utf-8",
    );
    expect(src).toContain("QUEUE_SNAPSHOT_SQL");
    expect(src).toContain("_queueSafeShared.mjs");
    expect(src).toContain("encode(digest(");
    expect(src).toContain("sshPsqlMutate");
    expect(src).toContain("sshPsqlJson");
    expect(src).toContain("ISSUE_PAIRING_CONFIRM");
    expect(src).not.toMatch(/service.role|SERVICE_ROLE/i);
  });

  it("issue script must not pass empty microlink_prepared_jobs to evaluateQueueSafe (regression)", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/tally-integration/ssh-issue-test-pairing-code.mjs"),
      "utf-8",
    );
    expect(src).toContain("QUEUE_SNAPSHOT_SQL");
    expect(src).not.toMatch(/microlink_prepared_jobs:\s*\[\]/);
    const bad = evaluateQueueSafe({
      global_pending_batches: 0,
      smoke_pending_batches: 0,
      microlink_pending_batches: 0,
      microlink_prepared_jobs: [],
    });
    expect(bad.queue_safe).toBe(false);
    expect(bad.errors.some((e) => e.includes("missing Microlink prepared job"))).toBe(true);
  });

  it("evaluateQueueSafe requires zero pending batches and three Microlink jobs", () => {
    const bad = evaluateQueueSafe({
      global_pending_batches: 1,
      smoke_pending_batches: 0,
      microlink_pending_batches: 0,
      microlink_prepared_jobs: [],
    });
    expect(bad.queue_safe).toBe(false);
    const ok = evaluateQueueSafe({
      global_pending_batches: 0,
      smoke_pending_batches: 0,
      microlink_pending_batches: 0,
      microlink_prepared_jobs: [
        {
          id: "255fd764-53a5-4db3-b24f-0ce9712f7ef5",
          status: "prepared",
          report_type: "claim_verification",
          prepared_item_count: 2514,
        },
        {
          id: "89d0f0c8-9cdd-4790-8b86-698ba65f8aab",
          status: "prepared",
          report_type: "claim_verification",
          prepared_item_count: 2514,
        },
        {
          id: "68fd0e2d-867c-4434-9132-2f2eb56b5bb4",
          status: "prepared",
          report_type: "claim_verification",
          prepared_item_count: 2514,
        },
      ],
    });
    expect(ok.queue_safe).toBe(true);
  });

  it("parsePsqlJsonStdout ignores INSERT command tags before JSON", () => {
    const mixed = "INSERT 0 1\nINSERT 0 1\n{\"organization_id\":\"80ab039f-f9e2-4c76-8b5b-e65b15d66af9\",\"inserted\":1}";
    expect(parsePsqlJsonStdout(mixed).inserted).toBe(1);
    const split = splitPsqlOutput(mixed);
    expect(split.commandTags).toEqual(["INSERT 0 1", "INSERT 0 1"]);
    expect(split.jsonLines).toHaveLength(1);
  });

  it("generatePairingCodePlaintext matches 8-char uppercase shape", () => {
    const c = generatePairingCodePlaintext();
    expect(c).toMatch(/^[0-9A-F]{8}$/);
  });

  it("buildRemotePsqlBash uses base64 stdin not JSON.stringify sql", () => {
    const bash = buildRemotePsqlBash("\nSELECT 1;");
    expect(bash).toContain("base64 -d");
    expect(bash).not.toContain("JSON.stringify");
  });

  it("documents expected Tally company for smoke org", () => {
    expect(TALLY_COMPANY).toBe("PesoWise Integration Test");
  });
});
