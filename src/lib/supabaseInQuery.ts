import type { SupabaseClient } from "@supabase/supabase-js";

/** Keep PostgREST GET URLs short enough for proxies/CDNs (avoids CORS preflight / 414 failures).
 *  100 UUIDs ≈ 3.7 KB in the URL — safe under 8 KB proxy limits and dramatically cuts request count. */
export const SUPABASE_IN_QUERY_CHUNK_SIZE = 100;

export function chunkArray<T>(arr: T[], size = SUPABASE_IN_QUERY_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Profiles for many users without one giant `user_id=in.(...)` URL. */
export async function fetchProfilesByUserIds<T extends string>(
  supabase: SupabaseClient,
  organizationId: string,
  userIds: string[],
  select: T,
): Promise<Record<string, unknown>[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const results = await Promise.all(
    chunkArray(unique).map(async (batch) => {
      const { data, error } = await supabase
        .from("profiles")
        .select(select)
        .eq("organization_id", organizationId)
        .in("user_id", batch);
      if (error) throw error;
      return (data || []) as Record<string, unknown>[];
    }),
  );
  return results.flat();
}

export type ExpenseSubmitterProfile = {
  user_id: string;
  name: string;
  email: string;
  balance: number | null;
  employee_id: string;
};

/** Parse employee ID from synthetic auth email emp.{org}.{employee_id}.{suffix}@... */
export function employeeIdFromSyntheticEmail(email: string): string {
  const trimmed = email.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^emp\.[^.]+\.([^.]+)\./i);
  return match?.[1]?.trim() ?? "";
}

export function resolveSubmitterEmployeeId(
  employeeId: string | null | undefined,
  email: string | null | undefined,
): string {
  const fromProfile = employeeId?.trim();
  if (fromProfile) return fromProfile;
  return employeeIdFromSyntheticEmail(email ?? "");
}

/** Expense lists: org profiles + auth fallback for orphaned submitters after user re-import. */
export async function fetchExpenseSubmitterProfiles(
  supabase: SupabaseClient,
  organizationId: string,
  userIds: string[],
): Promise<ExpenseSubmitterProfile[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const batchResults = await Promise.all(
    chunkArray(unique).map(async (batch) => {
      const { data, error } = await supabase.rpc("get_expense_submitter_profiles", {
        p_organization_id: organizationId,
        p_user_ids: batch,
      });

      const rows: ExpenseSubmitterProfile[] = [];

      if (!error && data) {
        for (const row of data as {
          user_id: string;
          name: string | null;
          email: string | null;
          balance: number | null;
          employee_id?: string | null;
        }[]) {
          const email = row.email?.trim() || "";
          rows.push({
            user_id: row.user_id,
            name: row.name?.trim() || "Unknown User",
            email,
            balance: row.balance ?? 0,
            employee_id: resolveSubmitterEmployeeId(row.employee_id, email),
          });
        }
        return rows;
      }

      const fallback = (await fetchProfilesByUserIds(
        supabase,
        organizationId,
        batch,
        "user_id, name, email, balance, employee_id",
      )) as {
        user_id: string;
        name: string;
        email: string;
        balance: number | null;
        employee_id: string | null;
      }[];
      for (const row of fallback) {
        const email = row.email?.trim() || "";
        rows.push({
          user_id: row.user_id,
          name: row.name?.trim() || "Unknown User",
          email,
          balance: row.balance ?? 0,
          employee_id: resolveSubmitterEmployeeId(row.employee_id, email),
        });
      }
      return rows;
    }),
  );

  return batchResults.flat();
}

/** Profile names for many users (chunked; no org filter — RLS scopes results). */
export async function fetchProfileNamesByUserIds(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const nameByUserId = new Map<string, string>();
  if (unique.length === 0) return nameByUserId;

  for (const batch of chunkArray(unique)) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, name")
      .in("user_id", batch);
    if (error) {
      console.warn("fetchProfileNamesByUserIds:", error.message);
      continue;
    }
    for (const row of data || []) {
      nameByUserId.set(
        row.user_id.toLowerCase(),
        row.name?.trim() || "Unknown user",
      );
    }
  }
  return nameByUserId;
}

function collectUuidRows(data: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (typeof row === "string") {
      out.add(row);
      continue;
    }
    const id = (row as { expense_id?: string }).expense_id;
    if (id) out.add(id);
  }
  return out;
}

/** Max IDs per RPC call for resubmission/correction checks (avoids HTTP 500 after ~16s). */
const RESUBMISSION_RPC_CHUNK_SIZE = 200;
/** Max concurrent DB queries in fallback paths. */
const RESUBMISSION_MAX_CONCURRENCY = 3;

/**
 * Run tasks with bounded concurrency. Returns results in input order.
 * Failures are caught and returned as empty sets.
 */
async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) break;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, tasks.length) }, worker),
  );
  return results;
}

/** Expense IDs with an `expense_resubmitted` audit log entry. Never throws. */
export async function fetchResubmittedExpenseIds(
  supabase: SupabaseClient,
  expenseIds: string[],
  organizationId?: string | null,
): Promise<Set<string>> {
  if (expenseIds.length === 0) return new Set();

  // Split into chunks of max 200 IDs to avoid HTTP 500 on large payloads.
  const rpcChunks = chunkArray(expenseIds, RESUBMISSION_RPC_CHUNK_SIZE);

  const rpcTasks = rpcChunks.map((chunk) => async (): Promise<Set<string>> => {
    try {
      const { data, error } = await supabase.rpc("get_resubmitted_expense_ids", {
        p_expense_ids: chunk,
      });
      if (!error && data) return collectUuidRows(data);
      if (error) console.warn("get_resubmitted_expense_ids RPC:", error.message);
    } catch (err) {
      console.warn("get_resubmitted_expense_ids RPC:", err);
    }
    return new Set<string>(); // signal caller to fall through to audit_logs
  });

  const rpcResults = await runConcurrent(rpcTasks, RESUBMISSION_MAX_CONCURRENCY);
  const rpcOut = new Set<string>();
  for (const s of rpcResults) for (const id of s) rpcOut.add(id);

  // If all RPC chunks returned empty, fall back to audit_logs (bounded concurrency).
  // We can't distinguish "no resubmissions" from "RPC failed", so we always merge
  // the fallback result — duplicates are harmless since it's a Set.
  const fallbackTasks = chunkArray(expenseIds, SUPABASE_IN_QUERY_CHUNK_SIZE).map(
    (batch) => async (): Promise<Set<string>> => {
      try {
        let query = supabase
          .from("audit_logs")
          .select("expense_id")
          .in("expense_id", batch)
          .eq("action", "expense_resubmitted");
        if (organizationId) query = query.eq("organization_id", organizationId);
        const { data, error } = await query;
        if (error) {
          console.warn("fetchResubmittedExpenseIds fallback:", error.message);
          return new Set<string>();
        }
        return collectUuidRows(data);
      } catch (err) {
        console.warn("fetchResubmittedExpenseIds fallback:", err);
        return new Set<string>();
      }
    },
  );

  // Only run fallback if the RPC returned no results at all (likely an error)
  const rpcReturnedData = rpcOut.size > 0;
  if (!rpcReturnedData) {
    const fallbackResults = await runConcurrent(fallbackTasks, RESUBMISSION_MAX_CONCURRENCY);
    for (const s of fallbackResults) for (const id of s) rpcOut.add(id);
  }

  return rpcOut;
}

/** Expense IDs with reviewer correction logs. Never throws. */
export async function fetchReviewerCorrectedExpenseIds(
  supabase: SupabaseClient,
  expenseIds: string[],
  organizationId: string | null,
): Promise<Set<string>> {
  if (expenseIds.length === 0) return new Set();

  // Split into chunks of max 200 IDs for the RPC.
  const rpcChunks = chunkArray(expenseIds, RESUBMISSION_RPC_CHUNK_SIZE);

  const rpcTasks = rpcChunks.map((chunk) => async (): Promise<Set<string>> => {
    try {
      const { data, error } = await supabase.rpc("get_reviewer_corrected_expense_ids", {
        p_expense_ids: chunk,
        p_organization_id: organizationId,
      });
      if (!error && data) return collectUuidRows(data);
      if (error) console.warn("get_reviewer_corrected_expense_ids RPC:", error.message);
    } catch (err) {
      console.warn("get_reviewer_corrected_expense_ids RPC:", err);
    }
    return new Set<string>();
  });

  const rpcResults = await runConcurrent(rpcTasks, RESUBMISSION_MAX_CONCURRENCY);
  const out = new Set<string>();
  for (const s of rpcResults) for (const id of s) out.add(id);

  if (out.size === 0) {
    // Fallback to correction_logs with bounded concurrency.
    const fallbackTasks = chunkArray(expenseIds, SUPABASE_IN_QUERY_CHUNK_SIZE).map(
      (batch) => async (): Promise<Set<string>> => {
        try {
          let q = supabase
            .from("expense_correction_logs")
            .select("expense_id")
            .in("expense_id", batch);
          if (organizationId) q = q.eq("organization_id", organizationId);
          const { data, error } = await q;
          if (error) {
            console.warn("fetchReviewerCorrectedExpenseIds fallback:", error.message);
            return new Set<string>();
          }
          return collectUuidRows(data);
        } catch (err) {
          console.warn("fetchReviewerCorrectedExpenseIds fallback:", err);
          return new Set<string>();
        }
      },
    );

    const fallbackResults = await runConcurrent(fallbackTasks, RESUBMISSION_MAX_CONCURRENCY);
    for (const s of fallbackResults) for (const id of s) out.add(id);
  }

  return out;
}
