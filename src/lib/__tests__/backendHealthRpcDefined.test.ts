/**
 * DOC-088 — `get_backend_health` must exist in the repository's migrations.
 *
 * The Dashboard has called this RPC on mount and every 60s since DOC-071, which
 * shipped a pure frontend change on the assumption that the function "was
 * already present" server-side. It was not: production answered 404 on every
 * call, so the health chip read Unavailable forever while the backend was fine.
 *
 * This guard fails if the definition is ever dropped from the repo again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const MIGRATION_FILE = "20260808130000_get_backend_health_rpc.sql";

const raw = readFileSync(resolve(MIGRATIONS, MIGRATION_FILE), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("get_backend_health is defined in migrations", () => {
  it("has a migration that creates it", () => {
    const defining = readdirSync(MIGRATIONS).filter((f) => {
      if (!f.endsWith(".sql")) return false;
      const body = readFileSync(resolve(MIGRATIONS, f), "utf-8");
      return /CREATE (OR REPLACE )?FUNCTION public\.get_backend_health/.test(body);
    });
    expect(defining).toContain(MIGRATION_FILE);
  });

  it("matches the name the hook actually calls", () => {
    const hook = readFileSync(
      resolve(process.cwd(), "src/hooks/useDashboardBackendHealth.ts"),
      "utf-8",
    );
    expect(hook).toContain('supabase.rpc("get_backend_health")');
    expect(sql).toContain("CREATE FUNCTION public.get_backend_health()");
  });

  it("uses a valid 14-digit timestamp filename", () => {
    expect(MIGRATION_FILE).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});

describe("function hardening", () => {
  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
  });

  it("is STABLE and takes no arguments", () => {
    expect(sql).toMatch(/\bSTABLE\b/);
    expect(sql).toMatch(/get_backend_health\(\)/);
  });

  it("grants execute to authenticated only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_backend_health\(\) FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_backend_health\(\) FROM anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_backend_health\(\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO[^;]*\banon\b/);
  });
});

describe("diagnostic only — reads no data", () => {
  it("probes reachability without returning row data", () => {
    // PERFORM discards the result set; a bare SELECT could leak a user record.
    expect(sql).toMatch(/PERFORM 1 FROM auth\.users LIMIT 1;/);
    expect(sql).toMatch(/PERFORM 1 FROM storage\.objects LIMIT 1;/);
    expect(sql).not.toMatch(/SELECT\s+\*\s+FROM\s+auth\.users/i);
    expect(sql).not.toMatch(/\bemail\b/i);
  });

  it("mutates nothing", () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+\w/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });

  it("only drops the function it then recreates", () => {
    const drops = sql.match(/DROP\s+\w+/gi) ?? [];
    expect(drops).toEqual(["DROP FUNCTION"]);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.get_backend_health\(\);/);
  });
});

describe("response shape matches the client normalizer", () => {
  const normalizer = readFileSync(
    resolve(process.cwd(), "src/lib/backendHealth.ts"),
    "utf-8",
  );

  it.each([
    "status",
    "message",
    "database_reachable",
    "auth_reachable",
    "storage_reachable",
  ])("returns %s, which the normalizer reads", (field) => {
    expect(sql).toContain(`'${field}'`);
    expect(normalizer).toContain(field);
  });

  it("uses status values the normalizer understands", () => {
    // 'healthy' is the normalizer's default branch; 'degraded' is explicit.
    expect(sql).toContain("'healthy'");
    expect(sql).toContain("'degraded'");
    expect(normalizer).toContain('rawStatus === "degraded"');
  });
});
