# PesoWise — Lessons & Fixes

**Doc ID:** DOC-142  
**Status:** deployed (living document)  
**Last updated:** 2026-10-08  

## Purpose

This file records important Production incidents, bugs, architectural lessons, root causes, fixes and regression-prevention rules. It exists to help future developers and AI agents avoid repeating previously solved mistakes.

It is **cumulative**: append a new `LESSON-nnn` entry (or extend an existing one) instead of creating a new lessons file. Each entry points to the incident-specific document, which holds the long-form evidence.

**Before changing a subsystem that has an entry here, read that entry first and keep its regression constraints.** Search this file (and the linked incident documents) for the subsystem name, table, RPC or component you are about to touch.

**What does not belong here:** real employee names or ids, organization or ledger UUIDs, JWTs, secrets, private URLs, file names, or any other sensitive Production identifier. Use counts, redacted references and role/pattern descriptions.

> **Merge note.** LESSON-001 to LESSON-011 and the Documentation & Lessons rule live on the unmerged `hotfix/attachment-upload-preview-performance` branch (PR #11), which created this file. This branch adds LESSON-012 only, so the two copies of this file will conflict when both are merged: keep **both** sets of entries and both index rows.

```text
## LESSON-nnn — <title>
### Date / ### Area / ### Symptom / ### Root Cause / ### Why It Was Missed
### Fix / ### Verification / ### Regression Protection / ### Rule Going Forward
### Related Documentation / ### Related PR / Commit
```

## Index

| Entry | Title |
|---|---|
| LESSON-012 | UI-visible attachment state must be the canonical source for finalize and persistence |
| LESSON-015 | A paged report must page its keys first and enrich only the page; diagnose the failing report type before fixing |
| LESSON-014 | Never authorize report scope from a client-supplied user ID list (LESSON-013 is reserved by `fix/batch-verify-error-translation`) |

---

## LESSON-012 — UI-visible attachment state must be the canonical source for finalize and persistence

### Date
2026-10-08

### Area
Expenses / receipt upload, finalize-expense-receipts, attachment rows

### Symptom
Employees removed some uploaded bill photos from the expense form before pressing Submit, yet the submitted expense showed the removed photos too (one report: 4 meant to remain, many more attached).

### Root Cause
The upload list the employee sees and the list the form finalizes at submit were two different structures. Removing a preview changed only the upload component's private list. The form kept five append-only registries for the same uploads (URL list, temp-name set, metadata map, URL-to-path map, blob cache) and built the finalize payload from the temp-name set, so every file ever uploaded in the session was finalized and given an active attachment row. A retried MicroLink draft replayed the same expense and attached the files again as duplicates.

### Why It Was Missed
Nothing failed: every upload, finalize and insert succeeded, so there was no error, no monitoring event and no test that compared the persisted set with the visible set. Earlier attachment work checked that files arrived, not that only the intended files arrived.

### Fix
The attachments visible in the form are the single canonical set. `FileUpload` reports removals; the form drops a removed file from every registry immediately; the finalize manifest is derived only from the visible attachments; an in-flight upload that was removed is ignored when it completes; restored draft attachments are listed so they can be removed; and a retried draft is reconciled so stale or duplicate rows are unlinked (soft delete, metadata only). Other screens with the same pattern (admin submit, batch) were aligned.

### Verification
A local reproduction with the real upload component and an in-memory backend: 8 uploaded, 4 removed gave a finalize payload of 8 and 8 active rows before the fix, and 4 and 4 after. Tests assert the payload and the persisted rows, not call success. No Production trace was available.

### Regression Protection
`FileUploadAttachmentRemoval.test.tsx`, `expenseAttachmentManifest.test.ts`, `removedAttachmentsWiring.test.ts` (structural guards that fail if a screen goes back to an append-only registry).

### Rule Going Forward
- **UI-visible attachment state must be the canonical source for finalize and persistence.** Removing a preview is not sufficient if stale upload manifests remain.
- Never keep a second, append-only copy of "what the user selected". If a registry must exist, every removal path must update it, and the submit step must derive from the visible set, not from the registry.
- A user-visible removal must propagate to every registry, draft payload and backup at the moment it happens.
- A retry that replays an existing record must reconcile what is already attached, not only add.
- Tests for upload flows must assert the persisted set (payload, rows, count), including removals, re-adds, duplicate names, in-flight removal and retries.

### Related Documentation
`removed-attachments-reappearing-incident.md` (DOC-143); `microlink-expense-submission-attachment-incident.md` (DOC-140).

### Related PR / Commit
Branch `hotfix/removed-attachments-reappearing`.

---

## LESSON-014 — Never authorize report scope from a client-supplied user ID list

### What happened
Team report RPCs checked the caller's role but then trusted the `p_user_ids` array the browser sent (and treated NULL as organization-wide). Some were also executable by `anon`, because `PUBLIC` still held EXECUTE.

### Rule Going Forward
- Derive or validate report membership server-side from `auth.uid()` and always apply organization scope; a client list may only narrow, never widen.
- Revoke `PUBLIC` as well as `anon` on SECURITY DEFINER functions that have no anonymous caller.
- Prove isolation with behavioural tests (own, coworker, unrelated, other organization, anon) against a throwaway database, not only code review.

### Related Documentation
`scoped-report-access.md` (DOC-147).

---

## LESSON-015 — Page the keys first; enrich only the page (and confirm which report is failing)

### What happened
The Daily Project row producer enriched, grouped and json-aggregated the entire organisation on every 250-row page and applied the cursor and LIMIT last, so a 9,000-row report cost 209 s with pages above the 8 s statement timeout. The incident was first attributed to Detailed Expense; only a read-only look at the failed jobs showed they were all Daily Project Report jobs.

### Rule Going Forward
- When output rows are groups, select the page's group keys from cheap columns, then enrich only those groups. Cost must be proportional to the page, not the organisation.
- Prove such a change with byte-identical rows and cursor chains against the old body across filters, plus per-call timings that stay flat as data grows. Never raise `statement_timeout` to hide it.
- Before building a fix, read the failing records (report type, row counts, stored error) in Production.
- Do not copy a repo function over a live one without diffing: Production's custom-field helper had been corrected outside the migrations.

### Related Documentation
`daily-project-report-server-scalability.md` section 10.

## LESSON-016 — Never implement Submit as an unguarded two-step "create draft, then submit"

### What happened
The older single-expense form and the batch form inserted a draft row and only then submitted it. A rejected or interrupted submit left a stranded draft; the next press of Submit inserted another row. Separately, a 2026-09-22 RLS narrowing silently blocked owner draft updates, the batch-link `.update()` error was ignored (no batch child attached for three weeks), and stranded drafts could not be edited, so users re-entered them (55 re-submit pairs, 53 with no unique data).

### Rule Going Forward
- A logical Submit must be atomic, OR its identity must live in the DATABASE: a client-generated logical id with a UNIQUE index so (org, user, id) is one row. Browser memory (ref, sessionStorage) is only a convenience; never make correctness depend on it, and persist the id with the recoverable form.
- When you depend on a "durable" cache, test it across a simulated restart (fresh module, sessionStorage wiped): `loadExpenseFormDraft` had silently never read localStorage after a reload.
- Ask the server's own validator before creating anything (a rolled-back throwaway row reuses the real rules instead of copying them).
- Never ignore the error of a write whose success later steps depend on. A batch link that fails must fail the line visibly.
- A policy "hardening" that removes a door must be checked against every client write that used it (search the code for `.update(` on that table), not just the ones named in the migration comment.
- Success is only reported once the row is read back as past `draft`.

### Related Documentation
`draft-incident-forensic-audit.md` (DOC-148).

## LESSON-017 — Classify every "session is gone" error, and sign out one device, not all of them

### What happened
Production users often hold many concurrent sessions (153 with more than one, one with 83). The explicit Sign out used the default GLOBAL scope, so one person signing out ended every other device's session. Those devices' access tokens stayed valid until expiry, so `/auth/v1/user` answered 403 `session_not_found` and `/token` answered 400 `refresh_token_not_found`. The client only recognised "refresh token" messages and 401s, so it never cleaned up and kept calling the dead session. Separately, a settings column the app read never existed in Production, and three components each re-sent the failing request on every mount.

### Rule Going Forward
- Treat GoTrue's `session_not_found`, `refresh_token_not_found` and `refresh_token_already_used` as "session gone": one local sign-out, one notice, no loop.
- Explicit Sign out is `scope: "local"` and single-flight. Global sign-out is a separate, deliberate action.
- A failed read of a setting must be latched once per page load and shared by all consumers; never let each component retry on its own.
- Before blaming the app for a console error, check whether the string exists in `src/`; extension noise (Grammarly, runtime.lastError) is not ours.
- Check a "multiple clients" warning against the real storage keys before redesigning anything.

### Related Documentation
`console-errors-auth-notifications-audit.md` (DOC-149).

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-10-08 | Added LESSON-012 (UI-visible attachment state is the canonical source for finalize and persistence) on the removed-attachments hotfix branch. | Claude Code |
| 2026-10-15 | Added LESSON-014 (never authorize report scope from a client-supplied user ID list). | Claude Code |
| 2026-10-16 | Added LESSON-015 (page keys first, enrich only the page). | Claude Code |
| 2026-10-26 | Added LESSON-016 (never implement Submit as an unguarded create-draft-then-submit). | Claude Code |
| 2026-10-26 | Added LESSON-017 (classify every session-gone error; sign out one device). | Claude Code |
