# Option Branches Data Loss — Root Cause & Fix

**Doc ID:** DOC-045  
**Last updated:** 2026-07-07  
**Status:** superseded — see [DOC-047](#doc-047-why-batching-was-insufficient--the-complete-fix)

---

## Summary

`expense_form_field_option_branches` rows were silently wiped on a recurring basis — the table went from 720+ rows to 184 rows multiple times with no apparent human action. Two separate bugs in `saveDraftBranchesForTemplate` caused this. Both have been fixed. This document explains exactly what happened, what was changed, how to verify, and what to do if data is ever lost again.

---

## Background — what this table stores

`expense_form_field_option_branches` holds **conditional sub-fields** that appear inside the expense submission form when a user picks a specific value from a select-type custom field.

For the "Project" template (`id = 51181324-68cc-4174-bbe0-4834e5e22c48`) the table stores:

| parent_option_value | field_key | name | field_type | options |
|---|---|---|---|---|
| `197001M3` | `project_id` | Project ID | select | `["326","506"]` |
| `197001M3` | `project_name` | Project Name | select | `["Support","Training"]` |
| `202307M260` | `project_id` | Project ID | select | `["12708"]` |
| `202307M260` | `project_name` | Project Name | select | `["RBML Rebranding for COCO RO's"]` |
| … | … | … | … | … |

408 source rows → ~407 unique Uniq IDs → ~814 rows in the table (2 per Uniq ID).

The only code path that **deletes** from this table is `saveDraftBranchesForTemplate` in `src/lib/optionBranchPersistence.ts`. It uses a **delete-then-reinsert** strategy:

```
DELETE WHERE org = ? AND template = ?
INSERT new rows
```

If `INSERT` never completes (timeout) or inserts with an empty array (race condition), all data for that template is gone.

---

## Bug 1 — Sequential per-row inserts → HTTP timeout

### What the old code did

```typescript
// OLD — one network round-trip per branch row
for (const item of rootItems) {
  const { data, error } = await supabase
    .from("expense_form_field_option_branches")
    .insert(item.row)
    .select("id")
    .single();
  if (error) throw error;
  localToDb.set(item.localId, data.id);
}
```

With 407 unique Uniq IDs × 2 branch rows each = **814 rows**, this produced **814 sequential HTTP calls** to Supabase. Each call takes ~50–200 ms. Total wall-clock time: **40–160 seconds**.

Supabase's PostgREST + network proxy enforces a hard request timeout (usually 30–60 s). The sequence of events:

1. `DELETE` completes instantly — all 814 rows are gone.
2. Sequential `INSERT` loop starts.
3. ~300–500 rows in, the request times out or the browser tab goes offline momentarily.
4. The loop is interrupted. The thrown error is caught by the caller's `.catch()` or just swallowed.
5. **Result:** table has 0–400 rows instead of 814. Looks like silent deletion.

This explains why the row count always landed somewhere between 0 and ~500 — it was a partial insert after a successful full delete.

### The fix — batch inserts in chunks of 200

```typescript
async function batchInsert(
  items: Array<{ localId: string; row: Record<string, unknown> }>,
): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("expense_form_field_option_branches")
      .insert(chunk.map((item) => item.row))
      .select("id");
    if (error) throw error;
    (data ?? []).forEach((row: { id: string }, idx: number) => {
      localToDb.set(chunk[idx].localId, row.id);
    });
  }
}
```

814 rows → **5 HTTP calls** (chunks: 200, 200, 200, 200, 14). Wall-clock: ~250–500 ms. Well within any timeout.

PostgreSQL `INSERT ... RETURNING` preserves input row order, so we can map returned IDs back to `localIds` by index — which is how nested branch parent IDs are resolved.

---

## Bug 2 — Race condition: save fires before branch data finishes loading

### What the old code did

When the admin opens the template editor in `CategoryManagement`, the page:
1. Calls `loadDraftBranchesForTemplate(orgId, templateId)` — async
2. Sets `branchDrafts` state when the load resolves

**But the Save button was always enabled.** If the admin opened the editor and immediately (or accidentally) clicked Save before the branch load completed, the component still had the initial state:

```typescript
const [branchDrafts, setBranchDrafts] = useState<DraftOptionBranch[]>([]);
// ^ starts empty; async load not yet done
```

Clicking Save would call `saveDraftBranchesForTemplate(orgId, templateId, [], validOptions)`.

The function:
```typescript
// If drafts is empty, just delete everything and return
if (drafts.length === 0) return;  // ← after the DELETE has already run!
```

Wait — the actual code is:
```typescript
await supabase
  .from("expense_form_field_option_branches")
  .delete()
  .eq("organization_id", organizationId)
  .eq("parent_template_id", parentTemplateId);

if (drafts.length === 0) return;  // exits after delete
```

So passing an empty `drafts` array does the `DELETE` but skips the `INSERT` entirely — **wiping all rows with no reinsertion**.

This could happen:
- Admin opens the template editor
- Page is slow / Supabase is cold-starting → branch load takes 2+ seconds
- Admin sees the dialog open and immediately hits Save (possibly thinking it was already loaded)
- `branchDrafts` is still `[]`
- All 814 rows deleted, nothing reinserted

### The fix — `branchDraftsLoading` guard

Added a boolean state to `CategoryManagement.tsx`:

```typescript
const [branchDraftsLoading, setBranchDraftsLoading] = useState(false);
```

When the template editor opens:
```typescript
setBranchDraftsLoading(true);
loadDraftBranchesForTemplate(orgId, templateId)
  .then((drafts) => setBranchDrafts(drafts))
  .finally(() => setBranchDraftsLoading(false));
```

Save button is disabled while loading:
```typescript
<Button
  disabled={savingTemplate || branchDraftsLoading || /* other conditions */}
>
  {branchDraftsLoading ? "Loading conditional fields…" : "Save"}
</Button>
```

The OptionBranchEditor section also shows a loading indicator:
```tsx
{branchDraftsLoading ? (
  <p className="text-sm text-muted-foreground">Loading conditional fields…</p>
) : (
  <OptionBranchEditor ... />
)}
```

Guard is also reset on:
- Dialog close
- Field type change (which reloads branches)

---

## Why both bugs had to exist together

Either bug alone could cause data loss:

| Scenario | Bug 1 only fixed | Bug 2 only fixed |
|---|---|---|
| Admin opens + saves slowly (waits for load) | Save times out mid-insert → partial | Save works (load finished) |
| Admin opens + saves immediately | Save sends empty array → full wipe | Save blocked by loading guard |
| Automated re-save triggered in background | Could time out | Guard prevents empty saves |

With both fixes in place:
1. The save button is **disabled** until branch data has loaded → no empty-array wipe possible
2. When save does run with data, all 814 rows are inserted in **5 batched calls** in under 1 second → no timeout, no partial insert

---

## Key files changed

| File | Change |
|---|---|
| `src/lib/optionBranchPersistence.ts` | Replaced 814 sequential `.insert().single()` calls with `batchInsert()` helper — chunks of 200 rows per HTTP call |
| `src/pages/CategoryManagement.tsx` | Added `branchDraftsLoading` state; Save button disabled during load; loading indicator shown in branch editor section; guard reset on dialog close + field type change |

---

## The partial unique index (why the SQL is safe to re-run)

The migration `20260514120000_conditional_dropdown_branches.sql` creates:

```sql
CREATE UNIQUE INDEX idx_option_branches_root_field_key
  ON public.expense_form_field_option_branches
  (parent_template_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NULL;
```

This allows the re-population SQL to use `ON CONFLICT ... DO UPDATE` safely:

```sql
ON CONFLICT (parent_template_id, parent_option_value, field_key)
WHERE parent_branch_id IS NULL
DO UPDATE SET options = EXCLUDED.options, updated_at = now();
```

Running the SQL multiple times will never create duplicate rows — it upserts.

---

## How to re-populate data if rows are ever missing again

Run the SQL script from the Supabase SQL editor (project `avrbgpmzabktqwyzqibq`). The latest version was generated from `Project_Name_list_Latest.csv` (408 data rows, 2026-07-07).

The script is a single atomic CTE:

```sql
WITH raw (p, pid, pname) AS (
  VALUES
    ('197001M3','506','Support'),
    -- ... all 408 rows ...
),
agg AS (
  SELECT p,
    to_jsonb(array_agg(pid   ORDER BY pid::integer)) AS pids,
    to_jsonb(array_agg(pname ORDER BY pid::integer)) AS pnames
  FROM raw GROUP BY p
),
_upd AS (
  UPDATE expense_form_field_templates
  SET options = (SELECT to_jsonb(array_agg(p ORDER BY p)) FROM agg)
  WHERE id = '51181324-68cc-4174-bbe0-4834e5e22c48'
  RETURNING id
),
_ins_pid AS (
  INSERT INTO expense_form_field_option_branches (...) SELECT ... FROM agg
  ON CONFLICT (...) WHERE parent_branch_id IS NULL DO UPDATE SET options = EXCLUDED.options, updated_at = now()
  RETURNING id
)
INSERT INTO expense_form_field_option_branches (...) SELECT ... FROM agg
ON CONFLICT (...) WHERE parent_branch_id IS NULL DO UPDATE SET options = EXCLUDED.options, updated_at = now();
```

**What it does in one atomic round-trip:**
- Step 1 (`_upd`): Updates `expense_form_field_templates.options` with all unique Project Uniq IDs
- Step 2 (`_ins_pid`): Upserts `project_id` branch row per Uniq ID
- Step 3 (final INSERT): Upserts `project_name` branch row per Uniq ID

**Safe to run at any time** — idempotent, will not create duplicates, will update stale options arrays.

---

## Schema context

```
expense_form_field_templates
  id: uuid PK
  options: jsonb  ← array of Project Uniq IDs (dropdown choices)

expense_form_field_option_branches
  id: uuid PK
  organization_id: uuid FK → organizations.id ON DELETE CASCADE
  parent_template_id: uuid FK → expense_form_field_templates.id ON DELETE CASCADE
  parent_option_value: text  ← the Uniq ID selected by the user
  parent_branch_id: uuid FK → self ON DELETE CASCADE (for nested branches)
  field_key: text
  name: text
  field_type: text ('select' | 'text' | 'number' | 'date' | 'textarea' | 'checkbox')
  required: boolean
  options: jsonb  ← array of choices when field_type = 'select'
  display_order: integer

UNIQUE INDEX idx_option_branches_root_field_key
  ON (parent_template_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NULL
```

**CASCADE behaviour:** If the parent `expense_form_field_templates` row is deleted, all branch rows for that template are automatically cascade-deleted. Do not delete the template row.

---

## How to verify the fix is working

**1. Check row count after opening + saving a template:**
```sql
SELECT COUNT(*) FROM expense_form_field_option_branches
WHERE parent_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48';
-- Expected: 814 (407 unique Uniq IDs × 2 branch rows each)
-- 197001M3 has 2 Project IDs, so its branches have options arrays with 2 entries
```

**2. Check the loading guard is in place:**
Open DevTools → Network tab. Open the Category Management page and open the template editor. You should see:
- A request to `expense_form_field_option_branches?parent_template_id=eq.51181324...` fire
- The Save button is disabled (greyed out) until that request completes
- "Loading conditional fields…" text appears in the branch section

**3. Check the batch insert timing:**
Open DevTools → Network. Save the template after making a change. You should see **5 POST requests** to `expense_form_field_option_branches` (chunks of 200, 200, 200, 200, 14), not 814 individual requests. All 5 should complete in under 2 seconds total.

---

## Remaining risks to be aware of

| Risk | Likelihood | Mitigation |
|---|---|---|
| Admin force-closes browser mid-save (after delete, before inserts complete) | Low | Run re-population SQL to restore |
| Supabase project paused mid-save (cold start causes network drop) | Very low | Re-population SQL handles recovery |
| A future developer removes `branchDraftsLoading` guard assuming it is unnecessary | Low | This doc explains why it must stay |
| New code added that calls `saveDraftBranchesForTemplate` with `[]` without a loading guard | Low | `saveDraftBranchesForTemplate` itself does a no-op `return` after the DELETE when `drafts.length === 0`; the only risk is the preceding DELETE |
| CASCADE delete if someone deletes the parent template row | Medium if confused with "reset options" | Never delete the template row — only update its `options` column |

**There is no automated process (pg_cron, DB trigger, RLS policy) that deletes from this table.** The only SQL that can remove rows is:
1. `saveDraftBranchesForTemplate` (now guarded)
2. A manual `DELETE` query run directly in Supabase SQL editor
3. CASCADE from deleting a parent `expense_form_field_templates` row

---

---

## DOC-047 — Why batching was insufficient: the complete fix

### What the batching fix (Rev 1.0) left unresolved

The batch-insert fix (Bug 1) and the `branchDraftsLoading` guard (Bug 2) reduced the chance of silent data loss dramatically, but they did not eliminate the underlying structural hazard: the save path still followed a **DELETE then INSERT** sequence. The DELETE was committed before any INSERT began, so any failure between those two steps left the table empty.

Four residual failure modes remained after Rev 1.0:

| Scenario | Risk after Rev 1.0 |
|---|---|
| Browser tab killed/refreshed between DELETE and first INSERT chunk | All rows gone; no recovery path other than re-population SQL |
| Supabase connection reset mid-batch (e.g. project waking from pause) | Partial row set; the partial state is indistinguishable from a valid state |
| Two admins saving the same template concurrently | Last-write-wins on DELETE; second DELETE wipes the first session's inserts |
| Any future code that calls `saveDraftBranchesForTemplate` with a bug | DELETE runs before the bug is caught |

### The real fix — atomic server-side RPC (DOC-047)

Migration `290707_3000_branch_config_atomic_save.sql` (pending application) replaces the DELETE+INSERT pattern with a SECURITY DEFINER PL/pgSQL function `save_option_branch_configuration_atomically` that:

1. Locks the template row FOR UPDATE (serialises concurrent saves)
2. Validates the entire payload before any mutation (completeness, blank names, duplicate keys)
3. Applies a stale-edit check (rejects if `updated_at` changed since the editor opened)
4. **Never DELETEs.** Instead it UPDATEs existing rows, INSERTs new rows, and sets `retired_at` on rows removed from the payload — all in one transaction.
5. Writes an append-only audit row to `expense_form_field_branch_config_revisions`
6. A `BEFORE DELETE` trigger blocks direct PostgREST DELETEs so no code path can accidentally wipe the table directly.

After migration is applied, `saveDraftBranchesForTemplate` (the old function) is no longer called anywhere. The TypeScript API is now `saveOptionBranchConfigurationAtomically` in `src/lib/optionBranchPersistence.ts`.

### Migration status

> **PENDING APPLICATION** — `supabase/migrations/290707_3000_branch_config_atomic_save.sql` is committed to the local worktree but has not yet been applied to the Supabase project `avrbgpmzabktqwyzqibq`.
>
> **Important — CLI compatibility:** This file uses a short custom timestamp format (e.g. `290707_3000_...`) that does not match the 14-digit format required by the Supabase CLI migration runner. Running `supabase db push` will silently skip this file. **Do not rely on `supabase db push` to apply this migration.** Apply it manually by copying and running the full SQL in the Supabase SQL Editor (service-role / postgres) after completing the pre-production checklist below. If CLI application is preferred, first rename the file to a valid 14-digit timestamp (e.g. `20260707030000_branch_config_atomic_save.sql`) before pushing.

### Schema additions (from the migration)

```sql
-- Soft retirement columns (ADD COLUMN IF NOT EXISTS — idempotent)
ALTER TABLE expense_form_field_option_branches
  ADD COLUMN IF NOT EXISTS retired_at     timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by     uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retired_reason text;

-- Active-only unique index replaces the old unconditional index.
-- Name is unchanged (DROP + CREATE); now filtered to retired_at IS NULL,
-- so multiple retired rows for the same (template, option, field_key) are allowed.
DROP INDEX IF EXISTS public.idx_option_branches_root_field_key;
CREATE UNIQUE INDEX idx_option_branches_root_field_key
  ON public.expense_form_field_option_branches
  (parent_template_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NULL AND retired_at IS NULL;

-- Audit table (append-only; note ON DELETE CASCADE for org + template FKs)
CREATE TABLE IF NOT EXISTS public.expense_form_field_branch_config_revisions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  template_id             uuid        NOT NULL
    REFERENCES public.expense_form_field_templates (id) ON DELETE CASCADE,
  changed_by              uuid
    REFERENCES auth.users (id) ON DELETE SET NULL,
  source                  text        NOT NULL DEFAULT 'unknown',
  reason                  text,
  parent_options_snapshot jsonb       NOT NULL DEFAULT '[]',
  branches_inserted       integer     NOT NULL DEFAULT 0,
  branches_updated        integer     NOT NULL DEFAULT 0,
  branches_retired        integer     NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);
```

> **Note (2026-07-08 pre-commit cleanup):** The schema snippet above was corrected to match the actual migration file.
> Earlier versions of this doc used `revised_by` (→ `changed_by`), `parent_options` (→ `parent_options_snapshot`), and `idx_option_branches_root_field_key_active` (→ `idx_option_branches_root_field_key`).
> The full authoritative SQL is embedded in [Appendix A](#doc-047-appendix-a--full-migration-sql-pending-review) below.

### Health checks

Read-only verification queries are in:

```
docs/sql/project-branch-integrity-check.sql
```

Run all 7 sections after applying the migration and after each save session.

The full SQL for both appendices is embedded in this document — see
[Appendix A](#doc-047-appendix-a--full-migration-sql-pending-review) (migration)
and [Appendix B](#doc-047-appendix-b--full-read-only-health-check-sql) (health-check)
so the reviewer can audit the SQL without leaving this document.

### Pre-production deployment checklist

Do **NOT** apply the migration to production until ALL of the following steps are
completed in order:

1. **Export / backup current data** — before any schema change, export the current
   contents of `expense_form_field_option_branches` and
   `expense_form_field_templates` from the Supabase SQL Editor. Keep the export
   somewhere recoverable. This is your rollback point.

2. **Review Appendix A SQL** — read every statement in Appendix A line-by-line.
   Confirm: no `DELETE` in the RPC body, `SECURITY DEFINER` + `SET search_path`
   present, stale-edit check present, project-integrity check present, audit table
   created with RLS, BEFORE DELETE trigger created. Only proceed once satisfied.

3. **Test on local or staging DB by manually running the SQL** — copy the full
   Appendix A SQL block and paste it into the SQL Editor of a staging Supabase
   project (or a local `supabase start` instance). Run it and confirm zero errors.
   **Do not use `supabase db push` or `supabase db reset` — the migration file
   uses a short timestamp format that the Supabase CLI migration runner does not
   recognise and will silently skip.** If CLI application is ever needed, rename
   the file to a valid 14-digit timestamp first (e.g.
   `20260707030000_branch_config_atomic_save.sql`).

4. **Run Appendix B health-check SQL against the staging DB** — paste and run all
   7 sections of Appendix B in the staging SQL Editor. Confirm 0 rows returned by
   Sections 2 (completeness), 3 (orphans), 6 (duplicates), and 7a (orphaned nested
   branches).

5. **Test Category Management UI against the staging DB** — open the Project
   Unique ID template in CategoryManagement, edit a branch value, and save. Confirm:
   the save succeeds without errors; an audit row appears in
   `expense_form_field_branch_config_revisions`; no rows were hard-deleted from
   `expense_form_field_option_branches`; running Appendix B again still shows 0
   rows in Sections 2, 3, 6.

6. **Plan production application** — only after steps 1–5 pass on staging, schedule
   a low-traffic window to manually apply the SQL in the production Supabase SQL
   Editor. Re-run Appendix B immediately after. Monitor for errors.

---

## DOC-047 Appendix A — Full migration SQL pending review

> **Read-only reference.** This is an exact copy of
> `supabase/migrations/290707_3000_branch_config_atomic_save.sql`
> embedded for chat-based review. Do not execute this block automatically.
>
> **Application method:** Copy and paste the SQL below into the Supabase SQL Editor
> (service-role / postgres) on a staging instance first, then production. Do **not**
> use `supabase db push` — this file's short timestamp format is ignored by the
> Supabase CLI migration runner. See the pre-production checklist above for the full
> sequence.

```sql
-- ── PEsoWise · DOC-047: Branch Config Atomic Save & Data-Integrity Repair ────
-- Migration: 290707_3000_branch_config_atomic_save.sql
-- Purpose : Replace the browser-side DELETE+INSERT pattern with a
--           server-side atomic save RPC.  Adds soft retirement, a
--           configuration audit trail, and a BEFORE DELETE guard.
--
-- ⚠  Do NOT apply to any Supabase project until the matching frontend
--    changes (CategoryManagement.tsx, optionBranchPersistence.ts) are
--    deployed.  Both must land together.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── E1.  Soft-retirement columns ─────────────────────────────────────────────

ALTER TABLE public.expense_form_field_option_branches
  ADD COLUMN IF NOT EXISTS retired_at     timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by     uuid
    REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retired_reason text;

COMMENT ON COLUMN public.expense_form_field_option_branches.retired_at IS
  'NULL = active.  Set to now() to retire without physical deletion.';
COMMENT ON COLUMN public.expense_form_field_option_branches.retired_by IS
  'auth.uid() of the admin who retired this row.';
COMMENT ON COLUMN public.expense_form_field_option_branches.retired_reason IS
  'Short code: removed_from_configuration | superseded | manual_repair';

-- ── E2.  Rebuild unique indexes to exclude retired rows ───────────────────────

DROP INDEX IF EXISTS public.idx_option_branches_root_field_key;
CREATE UNIQUE INDEX idx_option_branches_root_field_key
  ON public.expense_form_field_option_branches
  (parent_template_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NULL
    AND retired_at IS NULL;

DROP INDEX IF EXISTS public.idx_option_branches_nested_field_key;
CREATE UNIQUE INDEX idx_option_branches_nested_field_key
  ON public.expense_form_field_option_branches
  (parent_branch_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NOT NULL
    AND retired_at IS NULL;

-- ── E3.  Configuration revision audit table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_form_field_branch_config_revisions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  template_id             uuid        NOT NULL
    REFERENCES public.expense_form_field_templates (id) ON DELETE CASCADE,
  changed_by              uuid
    REFERENCES auth.users (id) ON DELETE SET NULL,
  source                  text        NOT NULL DEFAULT 'unknown',
  reason                  text,
  parent_options_snapshot jsonb       NOT NULL DEFAULT '[]',
  branches_inserted       integer     NOT NULL DEFAULT 0,
  branches_updated        integer     NOT NULL DEFAULT 0,
  branches_retired        integer     NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.expense_form_field_branch_config_revisions IS
  'Append-only audit log: one row per call to save_option_branch_configuration_atomically.';

ALTER TABLE public.expense_form_field_branch_config_revisions
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view branch config revisions"
  ON public.expense_form_field_branch_config_revisions;
CREATE POLICY "Admins can view branch config revisions"
  ON public.expense_form_field_branch_config_revisions FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

-- The SECURITY DEFINER RPC bypasses RLS on INSERT; this policy is a belt-and-
-- suspenders guard for any future direct-insert path.
DROP POLICY IF EXISTS "SECURITY DEFINER RPC may insert revisions"
  ON public.expense_form_field_branch_config_revisions;
CREATE POLICY "SECURITY DEFINER RPC may insert revisions"
  ON public.expense_form_field_branch_config_revisions FOR INSERT
  WITH CHECK (true);

-- ── G.  BEFORE DELETE guard trigger ─────────────────────────────────────────
--
-- Blocks direct PostgREST DELETE calls to expense_form_field_option_branches.
-- The approved RPC sets app.branch_write_context before any DML that causes a
-- DELETE, so that path is explicitly allowed.
-- Cascade deletes from parent table deletion are detected by request.path not
-- containing 'expense_form_field_option_branches' (PostgREST sets request.path
-- to the table being called directly).

CREATE OR REPLACE FUNCTION public.block_direct_branch_delete ()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _ctx  text;
  _path text;
BEGIN
  _ctx  := coalesce(current_setting('app.branch_write_context', TRUE), '');
  _path := coalesce(current_setting('request.path',             TRUE), '');

  -- Allow: write context set by the approved atomic-save RPC
  IF _ctx = 'save_option_branch_configuration_atomically' THEN
    RETURN OLD;
  END IF;

  -- Allow: not a direct PostgREST DELETE targeting this table
  -- (e.g. cascade from template/org deletion, or SQL editor)
  IF position('expense_form_field_option_branches' IN _path) = 0 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Direct DELETE on expense_form_field_option_branches is not permitted. '
    'Use the save_option_branch_configuration_atomically RPC instead.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_direct_branch_delete
  ON public.expense_form_field_option_branches;
CREATE TRIGGER trg_block_direct_branch_delete
  BEFORE DELETE ON public.expense_form_field_option_branches
  FOR EACH ROW
  EXECUTE FUNCTION public.block_direct_branch_delete();

-- ── F.  Atomic branch configuration save RPC ─────────────────────────────────
--
-- p_branches element JSON schema (one object per draft branch):
--   local_id           text     required — browser-generated UUID
--   db_id              text     nullable — null for new branches, uuid for existing
--   parent_option_value text    required
--   parent_local_id    text     nullable — null for root branches
--   field_key          text     required
--   name               text     required
--   field_type         text     required (text|number|date|textarea|select|checkbox)
--   required           boolean  required
--   placeholder        text     nullable
--   help_text          text     nullable
--   options            jsonb    nullable — array of strings for select/checkbox
--   display_order      integer  required
--
-- Returns jsonb:
--   { ok, revision_id, latest_updated_at, branches_inserted,
--     branches_updated, branches_retired }
--
-- Error codes raised:
--   'P0001' — stale_edit: (p_expected_updated_at mismatch)
--   'P0002' — project_integrity: (Project template missing required branches)

CREATE OR REPLACE FUNCTION public.save_option_branch_configuration_atomically (
  p_organization_id     uuid,
  p_template_id         uuid,
  p_expected_updated_at timestamptz,   -- NULL = new template, skip stale check
  p_parent_options      jsonb,         -- jsonb array of option strings
  p_branches            jsonb,         -- jsonb array of branch objects
  p_source              text  DEFAULT 'category_management',
  p_reason              text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_updated_at   timestamptz;
  v_valid_parent_options text[]  := ARRAY[]::text[];
  v_opt                  text;
  v_branch               jsonb;
  v_db_id                uuid;
  v_new_id               uuid;
  v_parent_local_id      text;
  v_parent_db_id         uuid;
  v_payload_db_ids       uuid[]  := ARRAY[]::uuid[];
  v_local_to_db          jsonb   := '{}'::jsonb;
  v_branches_inserted    integer := 0;
  v_branches_updated     integer := 0;
  v_branches_retired     integer := 0;
  v_prev_remaining       integer := -1;
  v_remaining_count      integer;
  v_revision_id          uuid;
  v_missing_option       text;
BEGIN

  -- ── 1.  Authorisation: caller must be an active admin in the org ──────────
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id
      AND user_id         = auth.uid()
      AND is_active       = true
      AND role            = 'admin'
  ) THEN
    RAISE EXCEPTION 'Permission denied: admin role required in organisation %',
      p_organization_id;
  END IF;

  -- ── 2.  Lock the template row (prevents concurrent saves) ─────────────────
  SELECT t.updated_at INTO v_current_updated_at
  FROM   public.expense_form_field_templates t
  WHERE  t.id              = p_template_id
    AND  t.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  -- ── 3.  Stale-edit detection ───────────────────────────────────────────────
  IF p_expected_updated_at IS NOT NULL
     AND v_current_updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION
      'stale_edit: Template configuration was modified by another session. '
      'Close and reopen the editor to reload the latest version.'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 4.  Normalise and deduplicate parent options ──────────────────────────
  FOR v_opt IN
    SELECT DISTINCT trim(x.val)
    FROM   jsonb_array_elements_text(p_parent_options) AS x(val)
    WHERE  trim(x.val) <> ''
  LOOP
    v_valid_parent_options := array_append(v_valid_parent_options, v_opt);
  END LOOP;

  IF array_length(v_valid_parent_options, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one non-empty parent option is required';
  END IF;

  -- ── 5.  Validate branch payload ────────────────────────────────────────────
  FOR v_branch IN
    SELECT value FROM jsonb_array_elements(p_branches)
  LOOP
    IF coalesce(trim(v_branch->>'name'),     '') = '' THEN
      RAISE EXCEPTION 'Branch name cannot be empty (local_id=%)',
        v_branch->>'local_id';
    END IF;
    IF coalesce(trim(v_branch->>'field_key'), '') = '' THEN
      RAISE EXCEPTION 'Branch field_key cannot be empty (local_id=%)',
        v_branch->>'local_id';
    END IF;
    IF (v_branch->>'field_type') NOT IN
         ('text','number','date','textarea','select','checkbox') THEN
      RAISE EXCEPTION 'Invalid field_type "%" (local_id=%)',
        v_branch->>'field_type', v_branch->>'local_id';
    END IF;
  END LOOP;

  -- ── 6.  Project-specific completeness check ───────────────────────────────
  --    Template 51181324-68cc-4174-bbe0-4834e5e22c48 ("Project Unique ID")
  --    must carry both field_key='project_id' and field_key='project_name'
  --    for every parent option value (root level, parent_local_id IS NULL).
  IF p_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48'::uuid THEN
    SELECT opt INTO v_missing_option
    FROM   unnest(v_valid_parent_options) AS opt
    WHERE  NOT (
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_branches) AS b
        WHERE  b.value->>'parent_option_value' = opt
          AND  b.value->>'field_key'            = 'project_id'
          AND  (b.value->>'parent_local_id')    IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_branches) AS b
        WHERE  b.value->>'parent_option_value' = opt
          AND  b.value->>'field_key'            = 'project_name'
          AND  (b.value->>'parent_local_id')    IS NULL
      )
    )
    LIMIT 1;

    IF v_missing_option IS NOT NULL THEN
      RAISE EXCEPTION
        'project_integrity: Parent option "%" is missing a required '
        'project_id or project_name root branch', v_missing_option
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- ── 7.  Arm the write context (allows retirement UPDATEs; no DELETEs used) ─
  PERFORM set_config('app.branch_write_context',
                     'save_option_branch_configuration_atomically', TRUE);

  -- ── 8.  Pass 1 — root branches (parent_local_id IS NULL) ──────────────────
  FOR v_branch IN
    SELECT value FROM jsonb_array_elements(p_branches)
    WHERE  (value->>'parent_local_id') IS NULL
  LOOP
    v_db_id := nullif(v_branch->>'db_id', '')::uuid;

    IF v_db_id IS NOT NULL THEN
      -- UPDATE existing row (un-retire if needed)
      UPDATE public.expense_form_field_option_branches
      SET
        parent_option_value = trim(v_branch->>'parent_option_value'),
        field_key           = trim(v_branch->>'field_key'),
        name                = trim(v_branch->>'name'),
        field_type          = v_branch->>'field_type',
        required            = (v_branch->>'required')::boolean,
        placeholder         = NULLIF(trim(v_branch->>'placeholder'), ''),
        help_text           = NULLIF(trim(v_branch->>'help_text'),   ''),
        options             = CASE
                                WHEN (v_branch->>'field_type') IN ('select','checkbox')
                                THEN v_branch->'options'
                                ELSE NULL
                              END,
        display_order       = (v_branch->>'display_order')::integer,
        retired_at          = NULL,
        retired_by          = NULL,
        retired_reason      = NULL,
        updated_at          = now()
      WHERE  id                  = v_db_id
        AND  parent_template_id  = p_template_id
        AND  organization_id     = p_organization_id;

      v_local_to_db    := v_local_to_db
                          || jsonb_build_object(v_branch->>'local_id', v_db_id::text);
      v_payload_db_ids := array_append(v_payload_db_ids, v_db_id);
      v_branches_updated := v_branches_updated + 1;

    ELSE
      -- INSERT new row
      INSERT INTO public.expense_form_field_option_branches (
        organization_id, parent_template_id, parent_option_value,
        parent_branch_id, field_key, name, field_type, required,
        placeholder, help_text, options, display_order
      ) VALUES (
        p_organization_id,
        p_template_id,
        trim(v_branch->>'parent_option_value'),
        NULL,
        trim(v_branch->>'field_key'),
        trim(v_branch->>'name'),
        v_branch->>'field_type',
        (v_branch->>'required')::boolean,
        NULLIF(trim(v_branch->>'placeholder'), ''),
        NULLIF(trim(v_branch->>'help_text'),   ''),
        CASE
          WHEN (v_branch->>'field_type') IN ('select','checkbox')
          THEN v_branch->'options'
          ELSE NULL
        END,
        (v_branch->>'display_order')::integer
      )
      RETURNING id INTO v_new_id;

      v_local_to_db    := v_local_to_db
                          || jsonb_build_object(v_branch->>'local_id', v_new_id::text);
      v_payload_db_ids := array_append(v_payload_db_ids, v_new_id);
      v_branches_inserted := v_branches_inserted + 1;
    END IF;
  END LOOP;

  -- ── 9.  Pass 2+ — nested branches (parent_local_id NOT NULL) ──────────────
  --    Iterate until every nested branch is processed or no progress is made
  --    (cycle detection via v_prev_remaining guard).
  LOOP
    -- Count unprocessed nested branches whose parent is not yet resolved
    SELECT count(*) INTO v_remaining_count
    FROM   jsonb_array_elements(p_branches)
    WHERE  (value->>'parent_local_id') IS NOT NULL
      AND  NOT (v_local_to_db ? (value->>'local_id'));

    EXIT WHEN v_remaining_count = 0;
    EXIT WHEN v_remaining_count = v_prev_remaining;  -- no progress → graph cycle
    v_prev_remaining := v_remaining_count;

    FOR v_branch IN
      SELECT value FROM jsonb_array_elements(p_branches)
      WHERE  (value->>'parent_local_id') IS NOT NULL
        AND  v_local_to_db ? (value->>'parent_local_id')
        AND  NOT (v_local_to_db ? (value->>'local_id'))
    LOOP
      v_parent_local_id := v_branch->>'parent_local_id';
      v_parent_db_id    := (v_local_to_db ->> v_parent_local_id)::uuid;
      v_db_id           := nullif(v_branch->>'db_id', '')::uuid;

      IF v_db_id IS NOT NULL THEN
        UPDATE public.expense_form_field_option_branches
        SET
          parent_option_value = trim(v_branch->>'parent_option_value'),
          parent_branch_id    = v_parent_db_id,
          field_key           = trim(v_branch->>'field_key'),
          name                = trim(v_branch->>'name'),
          field_type          = v_branch->>'field_type',
          required            = (v_branch->>'required')::boolean,
          placeholder         = NULLIF(trim(v_branch->>'placeholder'), ''),
          help_text           = NULLIF(trim(v_branch->>'help_text'),   ''),
          options             = CASE
                                  WHEN (v_branch->>'field_type') IN ('select','checkbox')
                                  THEN v_branch->'options'
                                  ELSE NULL
                                END,
          display_order       = (v_branch->>'display_order')::integer,
          retired_at          = NULL,
          retired_by          = NULL,
          retired_reason      = NULL,
          updated_at          = now()
        WHERE  id                  = v_db_id
          AND  parent_template_id  = p_template_id
          AND  organization_id     = p_organization_id;

        v_local_to_db    := v_local_to_db
                            || jsonb_build_object(v_branch->>'local_id', v_db_id::text);
        v_payload_db_ids := array_append(v_payload_db_ids, v_db_id);
        v_branches_updated := v_branches_updated + 1;

      ELSE
        INSERT INTO public.expense_form_field_option_branches (
          organization_id, parent_template_id, parent_option_value,
          parent_branch_id, field_key, name, field_type, required,
          placeholder, help_text, options, display_order
        ) VALUES (
          p_organization_id,
          p_template_id,
          trim(v_branch->>'parent_option_value'),
          v_parent_db_id,
          trim(v_branch->>'field_key'),
          trim(v_branch->>'name'),
          v_branch->>'field_type',
          (v_branch->>'required')::boolean,
          NULLIF(trim(v_branch->>'placeholder'), ''),
          NULLIF(trim(v_branch->>'help_text'),   ''),
          CASE
            WHEN (v_branch->>'field_type') IN ('select','checkbox')
            THEN v_branch->'options'
            ELSE NULL
          END,
          (v_branch->>'display_order')::integer
        )
        RETURNING id INTO v_new_id;

        v_local_to_db    := v_local_to_db
                            || jsonb_build_object(v_branch->>'local_id', v_new_id::text);
        v_payload_db_ids := array_append(v_payload_db_ids, v_new_id);
        v_branches_inserted := v_branches_inserted + 1;
      END IF;
    END LOOP;
  END LOOP;

  -- ── 10.  Retire active branches absent from the payload ───────────────────
  UPDATE public.expense_form_field_option_branches
  SET
    retired_at     = now(),
    retired_by     = auth.uid(),
    retired_reason = 'removed_from_configuration',
    updated_at     = now()
  WHERE parent_template_id = p_template_id
    AND organization_id    = p_organization_id
    AND retired_at         IS NULL
    AND id                 <> ALL (v_payload_db_ids);

  GET DIAGNOSTICS v_branches_retired = ROW_COUNT;

  -- ── 11.  Atomically update template options + updated_at ──────────────────
  UPDATE public.expense_form_field_templates
  SET
    options    = to_jsonb(v_valid_parent_options),
    updated_at = now()
  WHERE  id              = p_template_id
    AND  organization_id = p_organization_id
  RETURNING updated_at INTO v_current_updated_at;

  -- ── 12.  Write audit row ─────────────────────────────────────────────────
  INSERT INTO public.expense_form_field_branch_config_revisions (
    organization_id, template_id, changed_by, source, reason,
    parent_options_snapshot,
    branches_inserted, branches_updated, branches_retired
  ) VALUES (
    p_organization_id,
    p_template_id,
    auth.uid(),
    p_source,
    p_reason,
    to_jsonb(v_valid_parent_options),
    v_branches_inserted,
    v_branches_updated,
    v_branches_retired
  )
  RETURNING id INTO v_revision_id;

  -- ── 13.  Clear write context ─────────────────────────────────────────────
  PERFORM set_config('app.branch_write_context', '', TRUE);

  RETURN jsonb_build_object(
    'ok',                true,
    'revision_id',       v_revision_id,
    'latest_updated_at', v_current_updated_at,
    'branches_inserted', v_branches_inserted,
    'branches_updated',  v_branches_updated,
    'branches_retired',  v_branches_retired
  );

EXCEPTION WHEN OTHERS THEN
  -- Always clear write context on any error path
  PERFORM set_config('app.branch_write_context', '', TRUE);
  RAISE;
END;
$$;

REVOKE ALL   ON FUNCTION public.save_option_branch_configuration_atomically FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_option_branch_configuration_atomically TO authenticated;

COMMENT ON FUNCTION public.save_option_branch_configuration_atomically IS
  'Atomic branch config save: validates, upserts/retires branches, writes audit row. '
  'Replaces the old browser-side DELETE+INSERT pattern (DOC-047).';
```

---

## DOC-047 Appendix B — Full read-only health-check SQL

> **Read-only reference.** This is an exact copy of
> `docs/sql/project-branch-integrity-check.sql`
> embedded for chat-based review.  All queries are `SELECT`-only.
> They are safe to run at any time but are **not automatically executed**.
>
> **Note:** The comment in Section 6 of this file references
> `idx_option_branches_root_field_key_active`, but the migration creates the
> index as `idx_option_branches_root_field_key` (the `_active` suffix is absent).
> This is a cosmetic discrepancy in the health-check comment only — the index name
> in the migration SQL is authoritative.

```sql
-- =============================================================================
-- Project Branch Integrity — Read-Only Health Checks
-- DOC-047  2026-07-07
--
-- PURPOSE
--   Verify the state of expense_form_field_option_branches for the Project
--   template after migration 290707_3000_branch_config_atomic_save.sql is
--   applied.  All queries are SELECT-only and safe to run at any time on the
--   live database.
--
-- RUN IN:  Supabase SQL editor (project avrbgpmzabktqwyzqibq)
--          Role: postgres (service-role)
--
-- SECTIONS
--   1. Active-row summary
--   2. Completeness check — every parent option must have both project_id
--      and project_name root branches
--   3. Orphan check — active branches whose parent option is absent from
--      the template options array
--   4. Retired-row audit — how many rows were retired and when
--   5. Stale-edit risk — template updated_at vs most-recent audit revision
--   6. Duplicate active root branches — should be zero after atomic save
--   7. Nested branches health
--   8. Manual recovery guide (comment block)
-- =============================================================================

-- ── 0. Constants ────────────────────────────────────────────────────────────
-- Change this if the template UUID ever differs.
\set project_template_id '51181324-68cc-4174-bbe0-4834e5e22c48'

-- =============================================================================
-- SECTION 1 — Active-row summary
-- =============================================================================
SELECT
  COUNT(*)                                        AS total_active_branches,
  COUNT(*) FILTER (WHERE parent_branch_id IS NULL) AS root_branches,
  COUNT(*) FILTER (WHERE parent_branch_id IS NOT NULL) AS nested_branches,
  COUNT(DISTINCT parent_option_value)             AS distinct_parent_options
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND retired_at IS NULL;

-- Expected: total = 2 × distinct_parent_options (one project_id + one
-- project_name root branch per option).  If total < 2 × distinct, some
-- parent options are incomplete.

-- =============================================================================
-- SECTION 2 — Completeness: parent options missing project_id or project_name
-- =============================================================================
WITH active AS (
  SELECT parent_option_value, field_key
  FROM expense_form_field_option_branches
  WHERE parent_template_id = :'project_template_id'
    AND parent_branch_id   IS NULL
    AND retired_at         IS NULL
),
required AS (
  SELECT unnest(ARRAY['project_id', 'project_name']) AS required_key
),
options AS (
  SELECT DISTINCT parent_option_value FROM active
)
SELECT
  o.parent_option_value,
  r.required_key,
  CASE WHEN a.field_key IS NULL THEN 'MISSING' ELSE 'ok' END AS status
FROM options o
CROSS JOIN required r
LEFT JOIN active a
  ON a.parent_option_value = o.parent_option_value
 AND a.field_key            = r.required_key
WHERE a.field_key IS NULL
ORDER BY o.parent_option_value, r.required_key;

-- Expected: 0 rows.  Any row here is a parent option that will trigger a
-- project_integrity error in the RPC if re-saved without fixing first.

-- =============================================================================
-- SECTION 3 — Orphan branches (parent option absent from template options)
-- =============================================================================
WITH template_opts AS (
  SELECT jsonb_array_elements_text(options) AS opt
  FROM expense_form_field_templates
  WHERE id = :'project_template_id'
)
SELECT
  b.id,
  b.parent_option_value,
  b.field_key,
  b.name,
  b.created_at
FROM expense_form_field_option_branches b
WHERE b.parent_template_id = :'project_template_id'
  AND b.retired_at         IS NULL
  AND b.parent_option_value NOT IN (SELECT opt FROM template_opts)
ORDER BY b.parent_option_value, b.field_key;

-- Expected: 0 rows.  Orphan branches exist when the template's options array
-- was edited but the atomic RPC was not called, or when rows were inserted
-- manually without updating the template options column.

-- =============================================================================
-- SECTION 4 — Retired-row audit
-- =============================================================================
SELECT
  DATE_TRUNC('day', retired_at) AS retired_day,
  retired_reason,
  COUNT(*)                       AS rows_retired,
  COUNT(DISTINCT retired_by)     AS distinct_retirer_uids
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND retired_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- Expected after first atomic save: rows equal to branches that were present
-- before the save but absent from the new payload.  retired_reason = 'absent
-- from save payload'.

-- =============================================================================
-- SECTION 5 — Stale-edit risk (last revision vs template updated_at)
-- =============================================================================
SELECT
  t.updated_at                          AS template_updated_at,
  r.created_at                          AS last_revision_at,
  r.source                              AS last_revision_source,
  r.branches_inserted,
  r.branches_updated,
  r.branches_retired,
  CASE
    WHEN r.created_at IS NULL         THEN 'NO REVISION YET (migration not applied or RPC not yet called)'
    WHEN r.created_at < t.updated_at  THEN 'STALE — template was modified after the last atomic save'
    ELSE 'ok'
  END                                   AS stale_status
FROM expense_form_field_templates t
LEFT JOIN LATERAL (
  SELECT *
  FROM expense_form_field_branch_config_revisions
  WHERE template_id = t.id
  ORDER BY created_at DESC
  LIMIT 1
) r ON TRUE
WHERE t.id = :'project_template_id';

-- Expected: stale_status = 'ok'.  A 'NO REVISION YET' result means the atomic
-- RPC has never been called for this template (migration applied but not yet
-- exercised through the UI).

-- =============================================================================
-- SECTION 6 — Duplicate active root branches (must be zero)
-- =============================================================================
SELECT
  parent_option_value,
  field_key,
  COUNT(*) AS duplicates
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND parent_branch_id   IS NULL
  AND retired_at         IS NULL
GROUP BY parent_option_value, field_key
HAVING COUNT(*) > 1
ORDER BY duplicates DESC;

-- Expected: 0 rows.  The partial unique index
-- idx_option_branches_root_field_key_active prevents duplicates after the
-- migration.  If rows appear here the migration may not have been applied.

-- =============================================================================
-- SECTION 7 — Nested branches health
-- =============================================================================
-- 7a. Nested branches whose parent branch is itself retired or missing
SELECT
  c.id                        AS child_id,
  c.parent_option_value,
  c.field_key                 AS child_key,
  c.parent_branch_id,
  p.id                        AS parent_exists,
  p.retired_at IS NOT NULL    AS parent_retired
FROM expense_form_field_option_branches c
LEFT JOIN expense_form_field_option_branches p
  ON p.id = c.parent_branch_id
WHERE c.parent_template_id = :'project_template_id'
  AND c.parent_branch_id   IS NOT NULL
  AND c.retired_at         IS NULL
  AND (p.id IS NULL OR p.retired_at IS NOT NULL)
ORDER BY c.parent_option_value;

-- Expected: 0 rows.  Any row means an active nested branch is orphaned from
-- its retired/deleted parent — the RPC would retire these in the next atomic
-- save that covers this parent_option_value.

-- 7b. Nesting depth summary
SELECT
  CASE
    WHEN parent_branch_id IS NULL THEN 'depth_1 (root)'
    ELSE                               'depth_2+ (nested)'
  END                 AS depth,
  COUNT(*)            AS active_count
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND retired_at         IS NULL
GROUP BY 1;

-- =============================================================================
-- SECTION 8 — MANUAL RECOVERY GUIDE (read-only context; no DML in this file)
-- =============================================================================
/*
  IF any of the above checks indicate a problem, use the following steps:

  STEP A — Identify which parent options are incomplete
    Run Section 2.  Note the parent_option_value values that have MISSING rows.

  STEP B — Re-populate via the atomic RPC (preferred)
    Open the CategoryManagement UI as an org admin.
    Edit the Project template.
    Click Save without making changes — the RPC will reconcile active branches
    against the current branchDrafts state and retire/insert as needed.
    This is the safest path because it goes through all 13 validation steps.

  STEP C — Emergency SQL recovery (use only if the UI is unavailable)
    Run the idempotent re-population CTE from:
      docs/sql/batch-review-production-verification.sql
    That CTE uses ON CONFLICT ... DO UPDATE so it is safe to run multiple times.
    It only inserts project_id and project_name root branches.
    It does NOT write audit rows to expense_form_field_branch_config_revisions.

    After running the CTE:
      - Verify with Section 1 and 2 of this file.
      - The next atomic save via the UI will write a proper audit row.

  STEP D — If retired rows need to be un-retired (rare)
    Only do this in the Supabase SQL editor as postgres (service role):

      UPDATE expense_form_field_option_branches
      SET retired_at = NULL, retired_by = NULL, retired_reason = NULL
      WHERE id IN ('<uuid1>', '<uuid2>')  -- IDs from the retired audit
        AND parent_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48';

    Then verify with this script.  Do NOT un-retire without understanding why
    the row was retired — it may have been intentionally removed.

  STEP E — If the unique index blocks re-insertion
    After migration 290707_3000_branch_config_atomic_save.sql, the active index:
      idx_option_branches_root_field_key_active
    allows multiple rows for the same (template, option, field_key) as long as
    all but one are retired.  If a re-insertion is blocked, it means a
    non-retired duplicate already exists — resolve by retiring the duplicate:

      UPDATE expense_form_field_option_branches
      SET retired_at = now(), retired_by = auth.uid(), retired_reason = 'manual-dedup'
      WHERE id = '<duplicate_id>';

  CONTACT: Report persistent integrity failures to the engineering team with
  the output of all 7 sections above and the relevant revision_id from
  expense_form_field_branch_config_revisions.
*/

-- =============================================================================
-- END OF FILE
-- =============================================================================
```

---

## Revision log

| Date | Rev | Notes |
|---|---|---|
| 2026-07-07 | 1.0 | Initial document — both bugs identified and fixed; re-population SQL generated from Project_Name_list_Latest.csv (408 rows) |
| 2026-07-07 | 2.0 | Added DOC-047 section explaining why batching was insufficient; new atomic RPC approach documented; migration `290707_3000_branch_config_atomic_save.sql` created (pending application) |
| 2026-07-08 | 3.0 | Pre-commit safety cleanup: "Three" → "Four" residual failure modes (table had 4 rows); schema snippet corrected (`revised_by`→`changed_by`, `parent_options`→`parent_options_snapshot`, index name corrected to `idx_option_branches_root_field_key`); full migration SQL embedded as Appendix A; full health-check SQL embedded as Appendix B; pre-production deployment checklist added; index.md DOC-045 status and Next ID footer corrected |
