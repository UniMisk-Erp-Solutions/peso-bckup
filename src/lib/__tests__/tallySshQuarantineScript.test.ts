// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildRemotePsqlBash } from "../../../scripts/tally-integration/_sshPsqlRemote.mjs";
import { buildQuarantineSql, validatePrecheck } from "../../../scripts/tally-integration/_quarantineShared.mjs";


const SMOKE = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";

describe("ssh-quarantine-smoke-batches-transaction.mjs", () => {
  it("does not pass multiline SQL via JSON.stringify to psql -c (\\nSELECT regression)", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/tally-integration/ssh-quarantine-smoke-batches-transaction.mjs"),
      "utf-8",
    );
    expect(src).not.toMatch(/-tAc\s+\$\{JSON\.stringify\(sql\)\}/);
    expect(src).toContain("_sshPsqlRemote.mjs");
    const remote = readFileSync(
      resolve(process.cwd(), "scripts/tally-integration/_sshPsqlRemote.mjs"),
      "utf-8",
    );
    expect(remote).toContain("base64 -d | docker exec -i");
  });

  it("buildRemotePsqlBash decodes to SQL starting with SELECT not backslash-n", () => {
    const sql = `\nSELECT jsonb_build_object('x', 1);`;
    const bash = buildRemotePsqlBash(sql, "supabase-db-test");
    const m = bash.match(/^echo "([^"]+)" \| base64 -d/);
    expect(m).toBeTruthy();
    const decoded = Buffer.from(m![1], "base64").toString("utf8");
    expect(decoded.startsWith("SELECT")).toBe(true);
    expect(decoded).not.toMatch(/^\\nSELECT/);
    expect(decoded).not.toContain("invalid command");
  });

  it("validatePrecheck requires seven smoke pending batches all pending in smoke org", () => {
    const batches = Array.from({ length: 7 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      job_id: "11111111-1111-4111-8111-111111111111",
      organization_id: SMOKE,
      status: "pending",
    }));
    const ok = validatePrecheck({
      smoke_pending_count: 7,
      global_pending_count: 7,
      microlink_pending_count: 0,
      other_org_pending_counts: {},
      smoke_pending_batches: batches,
    });
    expect(ok.ok).toBe(true);
    expect(ok.batchIds).toHaveLength(7);
    expect(ok.jobIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("buildQuarantineSql uses explicit UUID array and skipped status semantics", () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const sql = buildQuarantineSql(ids);
    expect(sql).toContain("status = 'skipped'");
    expect(sql).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(sql).toContain("BEGIN;");
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
