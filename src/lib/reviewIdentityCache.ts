/**
 * Review-row identity resolution (DEV — DOC-080).
 *
 * Employee identity (name + employee ID + balance) is CORE display data for a
 * Review row, not optional enrichment. This layer resolves it independently of
 * the optional badge/custom-field lookups so a failure in one can never blank a
 * name, and it is keyed by `user_id` — a profile belongs to a user, not to an
 * expense.
 *
 * It replaces the previous page-local effect whose bug was proven from a live
 * audit: that effect marked expense IDs "enriched" BEFORE the async profile
 * fetch, incremented a global sequence, and discarded the ENTIRE result — the
 * successfully-fetched profiles included — whenever a later render superseded
 * the run. The marked IDs stayed marked, so those rows never retried and their
 * names stuck on "—" (transactions 10585-10589 in the audit).
 *
 * The rules that prevent a recurrence:
 *  - A resolved profile is cached the moment it arrives and is NEVER discarded
 *    because another render happened — identity is globally reusable.
 *  - Resolution is keyed by user_id; applying it patches EVERY held row sharing
 *    that user_id, so all lines of a batch populate together and rows on other
 *    pages benefit from a lookup they did not trigger.
 *  - A failed fetch is retryable, never a permanent placeholder: the user is not
 *    marked resolved, and `clearFailures()` (called on an explicit refetch) lets
 *    it try again. Failures are NOT auto-retried every render (no spin).
 */

export type IdentityProfile = {
  user_id: string;
  name?: string | null;
  email?: string | null;
  employee_id?: string | null;
  balance?: number | null;
};

export type IdentityStatus = "resolved" | "inflight" | "failed" | "unknown";

/** A batched profile fetch: given user_ids, return whatever profiles resolved. */
export type IdentityFetcher = (userIds: string[]) => Promise<IdentityProfile[]>;

export type ResolveOutcome = {
  /** user_ids whose profile became available in this call. */
  newlyResolved: string[];
  /** user_ids that were attempted but did not resolve (retryable). */
  failed: string[];
};

/**
 * A session-scoped identity store. Held in a ref by the page; driven directly by
 * tests. Not reactive on its own — the caller re-patches rows after `resolve`.
 */
export class ReviewIdentityStore {
  private resolved = new Map<string, IdentityProfile>();
  private inflight = new Map<string, Promise<void>>();
  private failed = new Set<string>();

  get(userId: string | null | undefined): IdentityProfile | undefined {
    if (!userId) return undefined;
    return this.resolved.get(userId);
  }

  hasResolved(userId: string): boolean {
    return this.resolved.has(userId);
  }

  status(userId: string): IdentityStatus {
    if (this.resolved.has(userId)) return "resolved";
    if (this.inflight.has(userId)) return "inflight";
    if (this.failed.has(userId)) return "failed";
    return "unknown";
  }

  /**
   * The user_ids from `userIds` that still need a fetch — not already resolved,
   * not currently in flight, and not in the failed set (failures wait for an
   * explicit `clearFailures()` rather than retrying on every render).
   */
  pending(userIds: Iterable<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of userIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (this.resolved.has(id) || this.inflight.has(id) || this.failed.has(id)) continue;
      out.push(id);
    }
    return out;
  }

  /** Clear retryable failures so the next resolve attempts them again. Resolved identities persist. */
  clearFailures(): void {
    this.failed.clear();
  }

  /** Full reset — used when the organization or reviewer changes. */
  reset(): void {
    this.resolved.clear();
    this.inflight.clear();
    this.failed.clear();
  }

  /**
   * Resolve the given user_ids through `fetcher`, de-duplicating concurrent
   * work per user. A profile is cached as soon as it arrives and is never
   * discarded by a later render. Users the fetch could not resolve (error, or
   * simply absent from the response) are marked failed and become retryable via
   * `clearFailures()`.
   */
  async resolve(userIds: string[], fetcher: IdentityFetcher): Promise<ResolveOutcome> {
    const need = this.pending(userIds);
    if (need.length === 0) {
      // Nothing new to fetch; wait on any in-flight work these ids belong to so
      // callers that await this see a settled store.
      const waits = userIds
        .map((id) => this.inflight.get(id))
        .filter((p): p is Promise<void> => Boolean(p));
      if (waits.length > 0) await Promise.allSettled(waits);
      return { newlyResolved: [], failed: [] };
    }

    const before = new Set(this.resolved.keys());

    const work = (async () => {
      try {
        const profiles = await fetcher(need);
        for (const p of profiles) {
          if (p?.user_id) {
            this.resolved.set(p.user_id, p);
            this.failed.delete(p.user_id);
          }
        }
        // Users we asked for but the fetch did not return: retryable, not resolved.
        for (const id of need) {
          if (!this.resolved.has(id)) this.failed.add(id);
        }
      } catch {
        // A failed fetch must not poison the cache — mark retryable and move on.
        for (const id of need) {
          if (!this.resolved.has(id)) this.failed.add(id);
        }
      } finally {
        for (const id of need) this.inflight.delete(id);
      }
    })();

    for (const id of need) this.inflight.set(id, work);
    await work;

    const newlyResolved = need.filter((id) => this.resolved.has(id) && !before.has(id));
    const failed = need.filter((id) => this.failed.has(id));
    return { newlyResolved, failed };
  }
}

/**
 * Patch one review row from the store, keyed by user_id. A no-op when the user's
 * profile is not yet resolved (the row keeps its placeholder). `resolveEmployeeId`
 * is injected so this module stays free of any Supabase/identity-format import.
 */
export function applyReviewRowIdentity<
  T extends {
    user_id?: string | null;
    user_name?: string | null;
    user_email?: string | null;
    user_employee_id?: string | null;
    user_balance?: number | null;
  },
>(
  row: T,
  store: ReviewIdentityStore,
  resolveEmployeeId: (employeeId: string | null | undefined, email: string | null | undefined) => string,
): T {
  const profile = store.get(row.user_id);
  if (!profile) return row;
  const email = profile.email || row.user_email || "";
  const nextName = profile.name || row.user_name || "";
  const nextEmployeeId = resolveEmployeeId(profile.employee_id, email);
  const nextBalance = profile.balance != null ? Number(profile.balance) : (row.user_balance ?? undefined);

  // Avoid allocating a new row object when nothing actually changed — keeps
  // React from re-rendering identical rows on repeated patch passes.
  if (
    row.user_name === nextName &&
    row.user_email === email &&
    row.user_employee_id === nextEmployeeId &&
    row.user_balance === nextBalance
  ) {
    return row;
  }
  return {
    ...row,
    user_name: nextName,
    user_email: email,
    user_employee_id: nextEmployeeId,
    user_balance: nextBalance,
  };
}
