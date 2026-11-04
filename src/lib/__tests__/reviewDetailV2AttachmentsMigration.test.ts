/**
 * The prepared v2 detail migration may change only the attachments subquery:
 * active rows, deterministic order. It is not applied by these tests.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8").replace(/\r\n/g, "\n");
}

function functionBody(sql: string): string {
  const start = sql.indexOf("DECLARE v_out jsonb");
  const end = sql.lastIndexOf("END;");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function normalize(body: string): string {
  return body
    .replace(/--.*$/gm, "")
    .replace(/\$function\$/g, "$$")
    .replace(/SET search_path TO 'public'/g, "SET search_path = public")
    .replace(/\s+/g, " ")
    .trim();
}

const previous = read("supabase/migrations/20260801130000_review_queue_v2_contracts.sql");
const prepared = read("supabase/migrations/20261101100000_review_detail_v2_active_attachments_ordered.sql");

const previousAttachments =
  "SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename, 'content_type',a.content_type,'file_url',a.file_url)) FROM public.attachments a WHERE a.expense_id = e.id";
const preparedAttachments =
  "SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename, 'content_type',a.content_type,'file_url',a.file_url) ORDER BY a.created_at, a.id) FROM public.attachments a WHERE a.expense_id = e.id AND a.deleted_at IS NULL";

describe("get_review_expense_detail_v2 attachment hardening", () => {
  it("changes only the attachments subquery against the previous function body", () => {
    const oldBody = normalize(functionBody(previous.slice(previous.indexOf("get_review_expense_detail_v2"))));
    const newBody = normalize(functionBody(prepared));
    expect(oldBody).toContain(normalize(previousAttachments));
    expect(newBody).toContain(normalize(preparedAttachments));
    expect(newBody.replace(normalize(preparedAttachments), normalize(previousAttachments))).toBe(oldBody);
  });

  it("does not write data or grant execute to anon", () => {
    const withoutComments = prepared
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(withoutComments).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP TABLE)\b/i);
    expect(withoutComments).not.toMatch(/GRANT\s+EXECUTE[\s\S]*TO\s+anon/i);
    expect(withoutComments.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(withoutComments).toContain("get_review_expense_detail_v2");
    expect(withoutComments).toContain("deleted_at IS NULL");
    expect(withoutComments).toContain("ORDER BY a.created_at, a.id");
  });
});
