import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Connector pairing HTTP contract", () => {
  it("uses PostgREST RPC exchange (not tally-connector Edge) with anon apikey + Bearer", () => {
    const src = readFileSync(
      resolve(process.cwd(), "connector/tally/src/pesoApi.ts"),
      "utf-8",
    );
    expect(src).toMatch(/exchangePairingCode[\s\S]*\/rest\/v1\/rpc\/exchange_tally_connector_pairing_v1/);
    expect(src).toContain("apikey: anonKey");
    expect(src).toContain("Authorization: `Bearer ${anonKey}`");
  });

  it("pgcrypto search_path migration targets exchange + resolve pairing functions", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261007160000_tally_connector_pgcrypto_search_path.sql"),
      "utf-8",
    );
    expect(sql).toContain("exchange_tally_connector_pairing_v1");
    expect(sql).toContain("search_path = public, extensions");
  });

  it("401 from gateway is distinguished from RPC errors in pairing client", () => {
    const src = readFileSync(
      resolve(process.cwd(), "connector/tally/src/pesoApi.ts"),
      "utf-8",
    );
    expect(src).toContain("res.status === 401");
    expect(src).toContain("gateway rejected the anon JWT");
  });
});
