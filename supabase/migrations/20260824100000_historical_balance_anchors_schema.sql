-- Historical Balance Anchors V2 -- schema.
--
-- Owner correction (2026-08-24): the existing historical_opening import mode
-- treats the imported amount as a direct replacement for today's
-- profiles.balance ("new_current_balance = imported_opening_balance"). That
-- is wrong. An Opening Balance is a HISTORICAL BALANCE ANCHOR -- a fact
-- about what an employee's balance was on a past date -- not an instruction
-- to overwrite today's balance. Inserting a missing historical fact must
-- only apply the MISSING HISTORICAL EFFECT: today's balance changes by
-- (stated_balance - reconstructed_balance_immediately_before_the_anchor),
-- not by (stated_balance - today's_balance).
--
-- This is additive only. Nothing in 20260819163000/20260819174000
-- (balance_apply_import_v1, still live) is edited or dropped -- it keeps its
-- old, now-known-wrong-for-this-use-case semantics for any caller that has
-- not yet moved to the new engine (see the _v2 RPCs in the companion
-- migrations). The frontend on this branch stops calling the v1 import path
-- for historical_opening/balance_update once this ships.
--
-- Three financial concepts, kept structurally distinct (see
-- Documentations MD/index.md's 2026-08-24 revision-log entry for the full
-- accounting design):
--   opening_balance  -- historical anchor, START of its effective day
--   balance_update   -- historical anchor, END of its effective day
--   (allocation stays a real additive transaction; unchanged, not an anchor)
--
-- Versioned, never destructively edited: an "edit"/"replace" of an anchor
-- creates a NEW row in the same revision_group_id, marks the prior row
-- superseded, and lets the engine (companion migration) recalculate the
-- materialized effect and every downstream anchor's effect through
-- compensating ledger rows. No anchor row's financial fields are ever
-- UPDATEd in place once materialized.

BEGIN;

CREATE TABLE IF NOT EXISTS public.balance_historical_anchors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  anchor_kind           text        NOT NULL CHECK (anchor_kind IN ('opening_balance', 'balance_update')),

  -- effective_date + day_position + sequence_number together form this
  -- anchor's position on the historical timeline. day_position is derived
  -- from anchor_kind at creation (0 = start of day for an Opening Balance --
  -- it applies before any ordinary event dated the same day; 2 = end of day
  -- for a Balance Update -- it applies after every ordinary event dated the
  -- same day), stored explicitly so the replay engine's ORDER BY / range
  -- comparisons never have to re-derive it from anchor_kind. sequence_number
  -- disambiguates multiple anchors of the same kind on the same date
  -- (the "Add as new update" conflict-resolution choice) -- it is NOT a
  -- UUID-order tiebreak, which would make "which one applied second" the
  -- undefined result of an id's random bytes.
  effective_date        date        NOT NULL,
  day_position          smallint    NOT NULL CHECK (day_position IN (0, 2)),
  sequence_number        integer     NOT NULL DEFAULT 1 CHECK (sequence_number > 0),

  -- The balance the admin asserts existed at this point in history. This is
  -- a TARGET, never a delta -- the engine computes the delta required to
  -- make the reconstructed timeline equal this value at this point.
  stated_balance        numeric(14,2) NOT NULL,

  -- The engine's most recently computed delta for this specific anchor row.
  -- Mirrors the amount_delta of this anchor's current balance_ledger
  -- evidence row (source_type='historical_anchor', source_id=this id).
  -- Recalculated (via a NEW ledger row, never an UPDATE to an old one)
  -- whenever an earlier anchor for the same employee changes.
  materialized_delta    numeric(14,2),

  status                text        NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active', 'superseded', 'reversed')),

  -- Versioning. A brand-new anchor gets a fresh revision_group_id and
  -- revision_number=1. An edit/replace INSERTS a new row in the SAME
  -- revision_group_id with revision_number+1 and supersedes_anchor_id
  -- pointing at the row it replaces; the old row is marked
  -- status='superseded', superseded_by/superseded_at set -- its financial
  -- fields are never rewritten.
  revision_group_id     uuid        NOT NULL,
  revision_number       integer     NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  supersedes_anchor_id  uuid        REFERENCES public.balance_historical_anchors(id),
  superseded_by         uuid        REFERENCES public.balance_historical_anchors(id),
  superseded_at         timestamptz,

  reversed_at           timestamptz,
  reversed_by           uuid        REFERENCES auth.users(id),
  reversal_reason       text,

  -- Provenance: which import (if any) produced this specific revision.
  source_import_batch_id uuid REFERENCES public.balance_import_batches(id) ON DELETE SET NULL,
  source_import_row_id   uuid REFERENCES public.balance_import_rows(id) ON DELETE SET NULL,

  note                  text,
  -- Required on every edit/replace/reversal action; optional on first
  -- creation (there is nothing to explain a reason for yet).
  reason                text,

  created_by            uuid        NOT NULL REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Exactly one ACTIVE row per (org, user, revision_group_id) at a time --
  -- "active" here meaning not yet superseded/reversed. Enforced via a
  -- partial unique index below rather than a CHECK (Postgres CHECK cannot
  -- reference other rows).
  CONSTRAINT balance_historical_anchors_supersedes_not_self
    CHECK (supersedes_anchor_id IS NULL OR supersedes_anchor_id <> id)
);

-- At most one ACTIVE row per revision group -- the structural guarantee that
-- "supersede" always fully retires the row it replaces in the same
-- transaction, never leaving two active revisions of the same logical anchor.
CREATE UNIQUE INDEX IF NOT EXISTS balance_historical_anchors_active_revision_uidx
  ON public.balance_historical_anchors (revision_group_id)
  WHERE status = 'active';

-- At most one ACTIVE Opening Balance per employee, ever (Section 9's
-- duplicate rule) -- a second one must go through supersede/edit, or be
-- entered as a Balance Update, never as an ambiguous second baseline.
CREATE UNIQUE INDEX IF NOT EXISTS balance_historical_anchors_one_active_opening_uidx
  ON public.balance_historical_anchors (organization_id, user_id)
  WHERE status = 'active' AND anchor_kind = 'opening_balance';

-- The replay engine's primary access path: "every active anchor for this
-- employee, in timeline order."
CREATE INDEX IF NOT EXISTS balance_historical_anchors_timeline_idx
  ON public.balance_historical_anchors (organization_id, user_id, effective_date, day_position, sequence_number)
  WHERE status = 'active';

-- _balance_next_anchor_sequence_v1's exact access path: MAX(sequence_number)
-- for a given (org, user, date, kind) across EVERY revision status, not just
-- active ones (an anchor's sequence number must never collide with a
-- superseded/reversed sibling's either) -- the timeline index above can't
-- serve this since it's partial on status='active'.
CREATE INDEX IF NOT EXISTS balance_historical_anchors_sequence_lookup_idx
  ON public.balance_historical_anchors (organization_id, user_id, effective_date, anchor_kind, sequence_number);

CREATE INDEX IF NOT EXISTS balance_historical_anchors_revision_group_idx
  ON public.balance_historical_anchors (revision_group_id, revision_number);

CREATE INDEX IF NOT EXISTS balance_historical_anchors_source_batch_idx
  ON public.balance_historical_anchors (source_import_batch_id) WHERE source_import_batch_id IS NOT NULL;

COMMENT ON TABLE public.balance_historical_anchors IS
  'Historical Balance Anchors V2. One row per REVISION of a historical '
  'opening/balance-update anchor. A revision is never edited in place -- '
  'superseding/reversing always inserts a new row and marks the old one '
  'non-active. materialized_delta mirrors the amount_delta of this row''s '
  'own balance_ledger evidence entry (source_type=historical_anchor, '
  'source_id=this row''s id). See the companion engine migration for the '
  'replay/materialization/cascade functions that maintain this table and '
  'profiles.balance together, in one transaction, per anchor operation.';
COMMENT ON COLUMN public.balance_historical_anchors.day_position IS
  '0 = start of effective_date (Opening Balance: applies before any '
  'ordinary event dated the same day). 2 = end of effective_date (Balance '
  'Update: applies after every ordinary event dated the same day). Position '
  '1 is reserved for ordinary balance_ledger/expense_balance_deductions '
  'events when the replay engine compares them against anchors on the same '
  'calendar date.';
COMMENT ON COLUMN public.balance_historical_anchors.materialized_delta IS
  'The engine''s current computed delta for this anchor row: stated_balance '
  'minus the reconstructed balance immediately before this anchor''s '
  'timeline position. NULL until first materialized (should not remain '
  'NULL for any active row after a successful apply).';

-- ---------------------------------------------------------------------------
-- RLS -- admin-only, organization-scoped. Employees see the financial
-- EFFECT of an anchor via their existing unified-history read RPC (which the
-- companion migration extends to surface anchor context), never this table
-- directly -- matching balance_import_batches/rows' existing admin-only
-- pattern, and expense_balance_deductions' "no client table access, RPC
-- only" precedent.
-- ---------------------------------------------------------------------------
ALTER TABLE public.balance_historical_anchors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read org historical anchors" ON public.balance_historical_anchors;
CREATE POLICY "Admins read org historical anchors"
  ON public.balance_historical_anchors FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = balance_historical_anchors.organization_id
        AND om.role = 'admin' AND om.is_active = true
    )
  );

-- No INSERT/UPDATE/DELETE policy for any role, ever -- exactly like
-- balance_ledger. The SECURITY DEFINER engine functions in the companion
-- migration write this table as their owner, bypassing RLS entirely. A
-- client-side INSERT/UPDATE/DELETE against this table is structurally
-- impossible regardless of role.
REVOKE ALL ON TABLE public.balance_historical_anchors FROM PUBLIC;
REVOKE ALL ON TABLE public.balance_historical_anchors FROM anon;
GRANT SELECT ON TABLE public.balance_historical_anchors TO authenticated;

-- ---------------------------------------------------------------------------
-- balance_ledger: widen the entry_type/source_type CHECK constraints
-- additively. 20260819160000 (already applied/live) is never edited in
-- place -- these are new ALTER TABLE statements against the live
-- constraint, dropping and recreating it with a superset of values.
-- ---------------------------------------------------------------------------
ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_entry_type_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_entry_type_check CHECK (entry_type IN (
    'historical_opening',
    'allocation',
    'manual_adjustment',
    'cash_transfer_in',
    'cash_transfer_out',
    'expense_deduction',
    'reversal',
    'correction',
    -- New for Historical Balance Anchors V2:
    'historical_balance_update',        -- first materialization of a Balance Update anchor
    'historical_anchor_recalculation',  -- a downstream anchor's effect recalculated because an earlier anchor changed
    'historical_anchor_reversal'        -- an anchor explicitly reversed (retired without a replacement)
  ));

ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_source_type_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_source_type_check CHECK (source_type IN (
    'manual_add',
    'manual_adjust',
    'cashier_transfer',
    'bank_transfer_offer',
    'import_batch',
    'expense_approval',
    'reversal',
    -- Already added by 20260820130000_money_return_approve_v2 (same branch,
    -- earlier timestamp, applies first): approve_money_return_request_v2
    -- inserts source_type='money_return'. This ALTER replaces the whole
    -- constraint, so it MUST re-include every value the prior widening
    -- added, not just the ones this file itself introduces -- omitting it
    -- here would silently un-widen the live constraint and break that RPC's
    -- very next call once both migrations are applied in order.
    'money_return',
    -- New: every historical-anchor ledger row's source_id points at the
    -- balance_historical_anchors.id it materializes/recalculates/reverses.
    'historical_anchor'
  ));

COMMENT ON CONSTRAINT balance_ledger_entry_type_check ON public.balance_ledger IS
  'Widened 2026-08-24 (Historical Balance Anchors V2) to add '
  'historical_balance_update / historical_anchor_recalculation / '
  'historical_anchor_reversal. historical_opening is reused unchanged as '
  'the entry_type for an Opening Balance anchor''s first materialization -- '
  'only the RPC that produces it changed (see balance_apply_historical_anchor_v1), '
  'not the ledger vocabulary.';

-- ---------------------------------------------------------------------------
-- balance_import_batches.mode: add balance_update as a third mode.
-- historical_opening keeps its name (an Opening Balance import) but is now
-- processed by balance_apply_import_v2's anchor engine, not v1's direct-set
-- logic, once the frontend on this branch switches over.
-- ---------------------------------------------------------------------------
ALTER TABLE public.balance_import_batches
  DROP CONSTRAINT IF EXISTS balance_import_batches_mode_check;
ALTER TABLE public.balance_import_batches
  ADD CONSTRAINT balance_import_batches_mode_check
  CHECK (mode IN ('historical_opening', 'balance_update', 'allocation'));

-- balance_import_rows.validation_status: add invalid_date for the two
-- historical-anchor modes, where a missing/unparseable Effective Date must
-- block the row (an anchor with no timeline position is meaningless) --
-- distinct from invalid_amount, which is about the stated-balance/amount
-- column instead.
ALTER TABLE public.balance_import_rows
  DROP CONSTRAINT IF EXISTS balance_import_rows_validation_status_check;
ALTER TABLE public.balance_import_rows
  ADD CONSTRAINT balance_import_rows_validation_status_check
  CHECK (validation_status IN (
    'pending', 'valid', 'unknown', 'ambiguous',
    'invalid_amount', 'duplicate', 'no_op', 'invalid_date'
  ));

-- ---------------------------------------------------------------------------
-- balance_import_rows: per-row conflict-resolution state for the V2 import
-- path. NULL/defaults for every pre-existing row and for allocation-mode
-- rows, which never conflict with a historical anchor.
-- ---------------------------------------------------------------------------
ALTER TABLE public.balance_import_rows
  ADD COLUMN IF NOT EXISTS conflict_status text NOT NULL DEFAULT 'none'
    CHECK (conflict_status IN ('none', 'conflict', 'resolved', 'skipped')),
  ADD COLUMN IF NOT EXISTS conflict_type text,
  ADD COLUMN IF NOT EXISTS resolution_action text
    CHECK (resolution_action IS NULL OR resolution_action IN ('create', 'add_new_update', 'replace', 'edit', 'skip')),
  ADD COLUMN IF NOT EXISTS resolution_target_anchor_id uuid REFERENCES public.balance_historical_anchors(id),
  ADD COLUMN IF NOT EXISTS resolution_reason text,
  -- "edit" lets the admin override the imported values before they become
  -- the new revision; NULL means "use the row's own staged values verbatim"
  -- (this is what "replace" always does).
  ADD COLUMN IF NOT EXISTS resolution_override_balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS resolution_override_effective_date date,
  ADD COLUMN IF NOT EXISTS resolution_override_note text,
  ADD COLUMN IF NOT EXISTS resulting_anchor_id uuid REFERENCES public.balance_historical_anchors(id),
  -- Historical modes only: the reconstructed balance immediately before this
  -- row's timeline position, as computed at validate time -- surfaced
  -- separately from current_balance_snapshot (today's actual balance) and
  -- calculated_new_balance (today's PROJECTED balance) so the Preview UI can
  -- show "Historical position before / Target / Adjustment / Current today /
  -- Projected" as five distinct numbers, never conflating them.
  ADD COLUMN IF NOT EXISTS historical_position_before numeric(14,2);

COMMENT ON COLUMN public.balance_import_rows.conflict_status IS
  'V2 (historical_opening/balance_update modes only). ''conflict'' = an '
  'existing active anchor at the same employee+date (or an existing active '
  'Opening Balance elsewhere, for a second-opening-balance row) was found '
  'during validate; apply refuses to proceed for this row until '
  'resolution_action is set. ''resolved'' = the admin chose an action. '
  '''skipped'' = the admin chose skip; zero mutation for this row.';

COMMIT;

NOTIFY pgrst, 'reload schema';
