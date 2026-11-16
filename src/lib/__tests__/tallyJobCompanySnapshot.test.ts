import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261014130000_tally_sync_job_company_snapshot.sql"),
  "utf8",
);

describe("Tally job company snapshot migration", () => {
  it("freezes the configured company on newly created jobs and makes it part of job deduplication", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS tally_company_name text");
    expect(migration).toContain("WHERE c.organization_id = p_organization_id AND c.is_active = true");
    expect(migration).toMatch(/v_company\s*:=\s*NULLIF|SELECT NULLIF\(btrim\(c\.tally_company_name\)/);
    expect(migration).toContain("Tally company is not configured for this organization");
    expect(migration).toContain("|| '|' || v_company");
    expect(migration).toContain("tally_company_name, dedupe_key, status");
    expect(migration).toContain("v_company, v_dedupe, 'queued'");
    expect(migration).toContain("NULL means legacy/unknown and the connector must not claim it");
  });

  it("claims only batches whose frozen destination matches the locally verified active company", () => {
    expect(migration.match(/j\.tally_company_name = btrim\(p_expected_company_name\)/g)).toHaveLength(2);
    expect(migration).toContain("SELECT j.tally_company_name INTO v_company");
    expect(migration).toContain("'tally_company_name', v_company");
    expect(migration).not.toContain("FROM public.tally_org_connector_config WHERE organization_id = v_org");
    expect(migration).toContain("sync job has no frozen Tally company; manual reconciliation required");
    expect(migration).toContain("FOR UPDATE OF b SKIP LOCKED");
  });

  it("keeps job creation admin-only and batch claiming service-role-only", () => {
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.create_tally_sync_job_v1(uuid, text, jsonb) TO authenticated");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.connector_claim_delivery_batch_v1(uuid, integer, uuid, uuid, text) TO service_role");
    expect(migration).toContain("anon must not execute create_tally_sync_job_v1");
    expect(migration).toContain("authenticated must not execute connector_claim_delivery_batch_v1");
  });
});
