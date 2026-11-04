/**
 * In-memory stand-in for the parts of Supabase the receipt flow touches:
 * Storage (receipts bucket), the `finalize-expense-receipts` edge function,
 * the `attachments` table, and the soft-delete RPC.
 *
 * It records exactly what the app sends (finalize payloads, inserted rows) so
 * tests can assert the persisted attachment set, not just that calls succeeded.
 */

export interface FakeAttachmentRow {
  id: string;
  expense_id: string;
  organization_id: string;
  file_url: string;
  filename: string;
  content_type: string;
  uploaded_by: string;
  file_size: number | null;
  storage_path: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface FinalizeCall {
  expenseId: string;
  receipts: Array<{ filename: string; contentType?: string; fileSize?: number }>;
}

type Deferred = { release: () => void; path: string };

export class FakeReceiptBackend {
  readonly host = "https://files.test";
  readonly userId: string;
  /** bucket-relative path -> exists */
  objects = new Set<string>();
  attachments: FakeAttachmentRow[] = [];
  finalizeCalls: FinalizeCall[] = [];
  softDeleteCalls: string[] = [];
  /** When true, `upload` does not resolve until `releaseUpload` is called. */
  holdUploads = false;
  heldUploads: Deferred[] = [];
  /** `finalize-expense-receipts` outcome for the next call(s). */
  finalizeMode: "ok" | "lost_response" | "down" = "ok";
  private seq = 0;

  constructor(userId = "test-user-id") {
    this.userId = userId;
  }

  publicUrl(path: string): string {
    return `${this.host}/storage/v1/object/public/receipts/${path}`;
  }

  /** Rows the expense UI would show (soft-deleted rows excluded). */
  activeRows(expenseId: string): FakeAttachmentRow[] {
    return this.attachments.filter((r) => r.expense_id === expenseId && !r.deleted_at);
  }

  releaseUpload(index = 0): void {
    const held = this.heldUploads.splice(index, 1)[0];
    held?.release();
  }

  releaseAllUploads(): void {
    for (const h of this.heldUploads.splice(0)) h.release();
  }

  private tableBuilder(table: string) {
    const self = this;
    const filters: Record<string, unknown> = {};
    let selecting = false;
    const run = () => {
      if (table !== "attachments") return { data: [], error: null };
      const rows = self.attachments.filter((r) =>
        Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
      );
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const builder: Record<string, unknown> = {
      select() {
        selecting = true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      insert(row: Partial<FakeAttachmentRow>) {
        const created: FakeAttachmentRow = {
          id: `att-${++self.seq}`,
          expense_id: String(row.expense_id),
          organization_id: String(row.organization_id),
          file_url: row.file_url ?? "",
          filename: row.filename ?? "",
          content_type: row.content_type ?? "",
          uploaded_by: row.uploaded_by ?? "",
          file_size: row.file_size ?? null,
          storage_path: row.storage_path ?? null,
          created_at: new Date(Date.UTC(2026, 9, 8, 0, 0, self.seq)).toISOString(),
          deleted_at: null,
        };
        if (table === "attachments") self.attachments.push(created);
        const result = { data: created, error: null };
        const insertBuilder: Record<string, unknown> = {
          select: () => insertBuilder,
          single: () => Promise.resolve(result),
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(ok, bad),
        };
        return insertBuilder;
      },
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
        void selecting;
        return Promise.resolve(run()).then(ok, bad);
      },
    };
    return builder;
  }

  client() {
    const self = this;
    return {
      from: (table: string) => self.tableBuilder(table),
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "soft_delete_attachment") {
          const id = String(args.p_attachment_id);
          self.softDeleteCalls.push(id);
          const row = self.attachments.find((r) => r.id === id);
          if (row && !row.deleted_at) row.deleted_at = new Date().toISOString();
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      storage: {
        from: (_bucket: string) => ({
          upload: (path: string, _file: Blob) => {
            const done = () => {
              self.objects.add(path);
              return { data: { path }, error: null };
            };
            if (!self.holdUploads) return Promise.resolve(done());
            return new Promise((resolve) => {
              self.heldUploads.push({ path, release: () => resolve(done()) });
            });
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: self.publicUrl(path) } }),
        }),
      },
      functions: {
        invoke: (name: string, opts: { body: FinalizeCall }) => {
          if (name !== "finalize-expense-receipts") {
            return Promise.resolve({ data: null, error: new Error("unknown function") });
          }
          if (self.finalizeMode === "down") {
            return Promise.resolve({ data: null, error: new Error("edge function unavailable") });
          }
          const { expenseId, receipts } = opts.body;
          self.finalizeCalls.push({ expenseId, receipts: receipts.map((r) => ({ ...r })) });
          const results = receipts.map((r) => {
            const finalPath = `${expenseId}/${r.filename}`;
            self.objects.add(finalPath);
            return {
              sourcePath: `temp/${self.userId}/${r.filename}`,
              desiredFinalPath: finalPath,
              resolvedPath: finalPath,
              status: "finalized",
              filename: r.filename,
              fileUrl: self.publicUrl(finalPath),
            };
          });
          if (self.finalizeMode === "lost_response") {
            // The server did the work but the browser never got the answer.
            self.finalizeMode = "ok";
            return Promise.resolve({ data: null, error: new Error("response lost") });
          }
          return Promise.resolve({ data: { ok: true, results }, error: null });
        },
      },
    };
  }
}
