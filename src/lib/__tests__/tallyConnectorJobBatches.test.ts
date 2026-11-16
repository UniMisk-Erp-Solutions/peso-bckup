import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PesoConnectorApi } from "../../../connector/tally/src/pesoApi.js";

describe("tally-connector job_batches action", () => {
  it("edge function lists batches scoped to connector org", () => {
    const edge = readFileSync(
      resolve(process.cwd(), "supabase/functions/tally-connector/index.ts"),
      "utf-8",
    );
    expect(edge).toContain('action === "job_batches"');
    expect(edge).toContain("job organization mismatch");
    expect(edge).toContain('.range(offset, offset + limit - 1)');
  });

  it("paginates beyond the PostgREST 1000-row default without losing batches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { offset: number; job_id: string };
      const start = body.offset;
      const end = Math.min(start + 1000, 1001);
      const batches = Array.from({ length: end - start }, (_, i) => ({
        id: `batch-${start + i}`,
        status: "pending",
        batch_index: start + i,
        message_count: 5,
      }));
      return new Response(JSON.stringify({ job_id: body.job_id, batches, total_count: 1001 }), { status: 200 });
    });
    try {
      const result = await new PesoConnectorApi("https://peso.example", "test-token").jobBatches("job-1");
      expect(result.batches).toHaveLength(1001);
      expect(result.batches[1000].batch_index).toBe(1000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({ offset: 1000, limit: 1000 });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
