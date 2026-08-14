import { describe, expect, it, vi } from "vitest";
import {
  BULK_USERS_IMPORT_CHUNK_SIZE,
  runBulkUsersImportInChunks,
} from "@/lib/bulkUsersImportClient";

describe("runBulkUsersImportInChunks", () => {
  it("splits rows into chunks and merges results with stable indices", async () => {
    const invoke = vi.fn(async (body: Record<string, unknown>) => {
      const offset = Number(body.row_offset) || 0;
      const batch = body.rows as { name: string }[];
      return {
        success: true,
        total: batch.length,
        ok: batch.length,
        failed: 0,
        results: batch.map((_, i) => ({
          index: offset + i,
          ok: true,
          employee_id: String(offset + i + 1),
        })),
      };
    });

    const rows = Array.from({ length: 65 }, (_, i) => ({
      name: `User ${i}`,
      role: "employee" as const,
      employee_id: String(i + 1),
    }));

    const result = await runBulkUsersImportInChunks({
      organizationId: "org-1",
      dryRun: false,
      rows,
      chunkSize: 30,
      invoke,
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(65);
    expect(result.ok).toBe(65);
    expect(result.results).toHaveLength(65);
    expect(result.results![0].index).toBe(0);
    expect(result.results![64].index).toBe(64);
    expect(invoke.mock.calls[0][0].skip_welcome_email).toBe(true);
  });

  it("uses default chunk size constant", () => {
    expect(BULK_USERS_IMPORT_CHUNK_SIZE).toBeGreaterThan(0);
  });
});
