# Partitioning plan (design only — no live conversion)

Do **not** run these on production until table-replacement migration is approved.

| CURRENT TABLE | PROPOSED KEY | INTERVAL | FK IMPACT | PK/UNIQUE | RLS | RPC | POSTGREST | REALTIME | COMPLEXITY | DOWNTIME |
|---------------|--------------|----------|-----------|-----------|-----|-----|-----------|----------|------------|----------|
| expenses | `created_at` or `trip_start` | monthly or yearly | High (many FKs) | UUID PK ok on parent | Policies reference whole table | Many RPCs filter by org+status | Direct `.from('expenses')` | Enabled on expenses | **Very high** | **High if in-place** |
| audit_logs | `created_at` | monthly | Medium (expense_id) | UUID | Org-scoped select | Manager review scans | 10 frontend files | UNKNOWN | High | Medium |
| notifications | `created_at` | monthly | Low (user_id) | UUID | Per-user | RPC inserts | 5 frontend files | Realtime | Medium | Low–medium |
| balance_ledger | `effective_at` | yearly | **RESTRICT** on user | UUID | RPC-only | Balance engine | None direct | No | **Critical — defer** | High |

**Recommendation:** Partition **notifications** or **audit_logs** first in a **new** partitioned table + dual-write migration, not `ALTER` on live `expenses`.

**Later migration pattern (conceptual):**

1. Create `public.expenses_partitioned` (LIKE + PARTITION BY RANGE).  
2. Backfill in batches.  
3. Swap views/RPCs — **requires dedicated project phase**.

Stop: **expenses** table replacement not implemented in this framework release.
