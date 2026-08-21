/**
 * DOC-103 — server-side persistence for generated reports.
 *
 * A generated report used to exist only in the React Query cache: closing the
 * tab destroyed it, and there was no record that it had ever been produced.
 * This module writes every generation to the database and reads snapshots back.
 *
 * Dedupe is content-addressed. The same filters over unchanged data produce the
 * same hash, so the server reuses the existing snapshot instead of writing a
 * second multi-megabyte copy — while still logging the run. Production reports
 * are ~4,141 rows (~2 MB as jsonb) against a 151 MB database, so this is the
 * difference between bounded and unbounded growth.
 */
import { supabase } from "@/integrations/supabase/client";

export type GeneratedReportType =
  | "daily_project_expense"
  | "detailed_expense"
  | "claim_verification"
  | "claim_approval";

export interface GeneratedReportListItem {
  id: string;
  report_type: GeneratedReportType;
  filters: Record<string, unknown>;
  row_count: number;
  snapshot_at: string | null;
  first_generated_at: string;
  last_generated_at: string;
  generation_count: number;
  expires_at: string;
  generated_by_name: string;
  payload_bytes: number;
}

export interface SaveGeneratedReportResult {
  report_id: string;
  deduped: boolean;
  row_count: number;
}

/**
 * Canonical JSON: object keys sorted at every depth so two structurally equal
 * payloads always serialise identically. Without this, a key-order difference
 * between two runs would defeat dedupe and silently double storage.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/** Deterministic 32-bit FNV-1a, used only where WebCrypto is unavailable. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * SHA-256 of the canonical payload. Falls back to a composite non-crypto digest
 * when `crypto.subtle` is missing (non-secure context). The fallback is only a
 * dedupe key — never a security boundary — but it is deliberately widened so it
 * still satisfies the server's minimum-length check and keeps collisions
 * vanishingly unlikely for this use.
 */
export async function computeReportContentHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(payload));

  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const bytes = new TextEncoder().encode(json);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      /* fall through to the non-crypto path */
    }
  }

  const head = json.slice(0, Math.floor(json.length / 2));
  const tail = json.slice(Math.floor(json.length / 2));
  return `fnv-${fnv1a(json)}${fnv1a(head)}${fnv1a(tail)}-${json.length.toString(16)}`;
}

/**
 * Persist one generation. Always records the run; writes the payload only when
 * this exact content has not been stored for this organisation before.
 *
 * Never throws into the caller's render path — a failed save must not discard a
 * report the user is already looking at. Returns null and logs instead.
 */
export async function saveGeneratedReport(input: {
  organizationId: string;
  reportType: GeneratedReportType;
  filters: Record<string, unknown>;
  payload: unknown;
  rowCount: number;
  snapshotAt?: string | null;
  retentionDays?: number;
}): Promise<SaveGeneratedReportResult | null> {
  try {
    const contentHash = await computeReportContentHash({
      t: input.reportType,
      f: canonicalize(input.filters),
      p: input.payload,
    });

    const { data, error } = await supabase.rpc("save_generated_report_v1", {
      p_organization_id: input.organizationId,
      p_report_type: input.reportType,
      p_content_hash: contentHash,
      p_filters: input.filters as never,
      p_payload: input.payload as never,
      p_row_count: input.rowCount,
      p_snapshot_at: input.snapshotAt ?? null,
      p_retention_days: input.retentionDays ?? 90,
    });

    if (error) {
      console.error("saveGeneratedReport:", error.message);
      return null;
    }
    return data as unknown as SaveGeneratedReportResult;
  } catch (err) {
    console.error("saveGeneratedReport:", err);
    return null;
  }
}

/** Metadata for the Saved reports list. Payloads are never fetched here. */
export async function listGeneratedReports(
  organizationId: string,
  reportType?: GeneratedReportType,
  limit = 50,
): Promise<GeneratedReportListItem[]> {
  const { data, error } = await supabase.rpc("list_generated_reports_v1", {
    p_organization_id: organizationId,
    p_report_type: reportType ?? null,
    p_limit: limit,
    p_offset: 0,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as GeneratedReportListItem[];
}

/** Fetch one stored snapshot, payload included. */
export async function loadGeneratedReport(reportId: string): Promise<{
  id: string;
  report_type: GeneratedReportType;
  filters: Record<string, unknown>;
  payload: unknown;
  row_count: number;
  snapshot_at: string | null;
  first_generated_at: string;
  last_generated_at: string;
  generation_count: number;
  expires_at: string;
}> {
  const { data, error } = await supabase.rpc("get_generated_report_v1", {
    p_report_id: reportId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Report not found");
  return data as never;
}

/** Human-readable size for the Saved reports list. */
export function formatPayloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
