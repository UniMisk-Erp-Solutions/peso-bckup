# Manual SQL restore (copy-paste in Supabase)

Use this after reloading the **May 27 ~5:30 AM** backup.

**Dashboard:** [Supabase](https://supabase.com/dashboard) → project `kqlqirdneocivumdjtvx` → **SQL Editor** → **New query**

Run **3 sections in order**. Copy the **entire file** for each section, paste, click **Run**.

| Step | File | What it does | Size |
|------|------|----------------|------|
| **1a** | [`290529_1200_safe_grants_rls_urls_after_restore.sql`](./290529_1200_safe_grants_rls_urls_after_restore.sql) | **Safe** `public` grants + RLS enable + URL rewrite | Medium |
| **1b** | **`npm run post-restore:storage-policies`** (not SQL Editor) | Storage policies via **Direct** `psql` connection | — |
| **1c** | [`290529_1202_verify_after_safe_restore.sql`](./290529_1202_verify_after_safe_restore.sql) | Optional read-only checks (run after 1a + 1b) | Small |
| ~~1~~ | ~~`manual-section-1-grants-and-urls.sql`~~ | **Deprecated** — do not use | — |

**Storage / `SET ROLE supabase_storage_admin` errors?** The Dashboard SQL Editor cannot change `storage.objects`. For **1b**:

1. In `.env` add **Direct** URI: `DATABASE_DIRECT_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.kqlqirdneocivumdjtvx.supabase.co:5432/postgres`  
   (Dashboard → **Project Settings** → **Database** → **Connection string** → **Direct**)
2. From project root: `npm run post-restore:storage-policies`

If your May 27 backup already had org-scoped storage policies, you can skip **1b** and only run **1c** to confirm.

**Already ran unsafe Section 1?** Run **1a** anyway (revokes broad grants). URLs are idempotent.
| **2** | [`manual-section-2-hierarchy-migrations.sql`](./manual-section-2-hierarchy-migrations.sql) | 18 review/hierarchy migrations (your screenshot list) | Large |
| **3** | [`manual-section-3-manager-and-verify.sql`](./manual-section-3-manager-and-verify.sql) | Manager queue RPC + row counts | Medium |

**If Section 2 or 3 failed with `42P13: cannot change name of input parameter "p_org_id"`:**  
1. Run [`290529_1203_fix_manager_rpc_42p13.sql`](./290529_1203_fix_manager_rpc_42p13.sql) in SQL Editor  
2. Re-run **Section 2** (updated file drops functions before recreating them)  
3. Then run **Section 3**

After SQL:

```powershell
npm run post-restore:storage
```

---

## Self-hosted Supabase (Coolify) — fix login 500 after restore

If login returns **"Database error querying schema"** (HTTP 500 from `/auth/v1/token`), run the auth token fix on **Coolify Postgres** (not the cloud pooler):

1. In Coolify, copy the **Postgres connection URI** for your Supabase stack.
2. Add to `.env`:
   ```
   COOLIFY_DATABASE_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@HOST:5432/postgres
   ```
3. From project root:
   ```powershell
   npm run post-restore:auth-null-tokens
   ```
   Or paste [`090606_1600_fix_auth_users_null_tokens.sql`](./090606_1600_fix_auth_users_null_tokens.sql) into Coolify SQL editor.

**Production CSP:** ensure [`vercel.json`](../../vercel.json) allows your Supabase host in `connect-src` / `wss://` (currently `https://*.unimisk.com`). Redeploy Vercel after changes.

---

## If Section 2 is too large for the SQL Editor

Run migrations **one file at a time** from `supabase/migrations/` in this order (same as inside section 2):

1. `20260524180000_expense_hierarchy_review_select_expand.sql`
2. `20260524190000_list_organizations_for_dev_login.sql`
3. `20260524190100_fix_dev_tenant_list_use_slug.sql`
4. `20260524200000_tl_executive_expense_submit_and_select.sql`
5. `20260524210000_list_hierarchy_reviewer_expenses_rpc.sql`
6. `20260524220000_fix_hierarchy_reviewer_act_permissions.sql`
7. `20260524230000_fix_hierarchy_verify_advance.sql`
8. `20260524240000_hierarchy_tl_verify_fix.sql`
9. `20260524250000_hierarchy_verification_statuses.sql`
10. `20260524250100_hierarchy_verification_statuses_apply.sql`
11. `20260524260000_fix_hierarchy_verify_status_by_role.sql`
12. `20260524270000_backfill_level2_queue_after_tl_verify.sql`
13. `20260524280000_manager_review_queue_and_managing_engineer.sql`
14. `20260524290000_expand_manager_team_visibility.sql`
15. `20260524300000_fix_level2_verified_manager_queue.sql`
16. `20260524310000_executive_handoff_to_manager_level2.sql`
17. `20260524320000_manager_sees_stuck_executive_queue.sql`
18. `20260524330000_manager_verify_auto_repair.sql`

Then run **Section 3**.

---

## One big file (optional)

[`MASTER-after-270526-0530.sql`](./MASTER-after-270526-0530.sql) = all 20 migrations + URLs in one paste (~2800 lines). Use only if the editor accepts it.

---

## Regenerate section files

If migrations change in git:

```powershell
node scripts/post-restore/build-manual-sections.mjs
```

---

## Change project refs

If not using `kqlqirdneocivumdjtvx`, edit **Section 1** `replace(...)` lines:

- Find: `briypgrgqagbexudarba`
- Replace with: your **old** ref from backup URLs
- Find: `kqlqirdneocivumdjtvx`
- Replace with: your **current** live ref
