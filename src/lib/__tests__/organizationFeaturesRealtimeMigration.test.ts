import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260927000000_organization_features_realtime.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("organization_features realtime publication", () => {
  it("adds organization_features to supabase_realtime, guarded to be idempotent", () => {
    expect(migration).toContain("ALTER PUBLICATION supabase_realtime ADD TABLE public.organization_features;");
    expect(migration).toContain("pg_publication_tables");
    expect(migration).toContain("pubname = 'supabase_realtime'");
  });

  it("touches only replication config -- no table/column/RLS/grant changes", () => {
    expect(migration).not.toMatch(/CREATE TABLE|ALTER TABLE public\.organization_features (ADD|DROP)|CREATE POLICY|GRANT |REVOKE /);
  });

  it("has a verification block confirming the table actually landed in the publication", () => {
    expect(migration).toContain("was not added to the supabase_realtime publication");
  });
});
