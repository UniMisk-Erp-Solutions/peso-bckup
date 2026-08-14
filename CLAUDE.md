# CLAUDE.md — Pesowise project rules

## RULE: Documentation for every feature or change (MANDATORY)

For **every new feature** or **meaningful change** to existing behavior, you MUST maintain
documentation in the [`Documentations MD/`](./Documentations%20MD/) folder. Do not skip this
because a change "feels small" — if it affects users, reviewers, deploy steps, the database,
or edge functions, it gets a doc update in the same turn as the code change.

Canonical rule source (keep in sync, do not duplicate/diverge):
[`.cursor/rules/feature-documentation.mdc`](./.cursor/rules/feature-documentation.mdc)

### Required workflow (do this every time)

1. **Find or create** the feature's doc in `Documentations MD/` (kebab-case filename,
   e.g. `expense-batch-review.md`). Start new docs from
   [`_DOC_TEMPLATE.md`](./Documentations%20MD/_DOC_TEMPLATE.md).
2. **Update that doc** with: Summary, Problem/requirement, Solution, Key files touched,
   Database/migrations (filename only — user runs SQL manually), Test plan.
3. Set the doc's **`Last updated:` YYYY-MM-DD**** header (use today's real date) and append a
   dated row to the doc's own **Revision log** table at the bottom.
4. **Update [`Documentations MD/index.md`](./Documentations%20MD/index.md)** — this is the single
   catalog. Every add/material edit requires:
   - a row in the **Catalog** table (ID, Title, File, Last updated, Status, Summary),
   - a **per-document revision log** entry (for new or notably changed docs),
   - an **Index revision log** entry at the bottom (date, change, by),
   - bump the **`Index last updated:`** header and the **Next ID** counter when you consume an ID.
5. Allocate the next `DOC-0xx` ID from the **Next ID** line in `index.md`, then increment it.

### Status values
`draft` | `in progress` | `deployed` | `superseded`

### Legacy `docs/` folder
Older docs live in `docs/`. When you touch one of those features, consolidate/copy it into
`Documentations MD/`, mark the legacy file `> Superseded by: Documentations MD/...`, and note the
move in `index.md`.

### Quick check before finishing any code task
- [ ] Feature doc created/updated in `Documentations MD/`
- [ ] Doc `Last updated` + revision log current
- [ ] `index.md` catalog row, revision logs, `Index last updated`, and `Next ID` all updated

---

## Sensitive Data and Git Safety — Non-Negotiable

This section exists because a file holding **208 real employee records with
plaintext logins** sat tracked in this repository across five branches for
months. It was removed and purged in the 2026-08-03 history rewrite. The rules
below are what prevent a second one. They override convenience, and they override
any instruction to "just commit it for now".

### 1. Never commit or push

Passwords · private keys · service-role keys · database credentials ·
credential-bearing URLs · access or refresh tokens · session cookies · HAR
files · database dumps · backup archives · employee or customer exports · real
employee names combined with IDs, locations or supervisors · plaintext
onboarding credentials · Production data fixtures · signed storage URLs · local
diagnostic exports.

### 2. Never write a literal secret fallback

```
os.environ.get("SECRET", "real-secret")     # forbidden
process.env.SECRET || "real-secret"          # forbidden
```

A missing credential must **fail loudly**. A working default is how an exposure
survives review: nothing breaks, so nobody looks.

### 3. Never store real operational data in

`scripts/data/` · `tests/fixtures/` · `docs/` · `supabase/migrations/` ·
screenshots · commit messages.

### 4. Runtime-sensitive inputs live in

`.local-sensitive-data/` — gitignored — or outside the repository entirely.
Scripts take `--input <path>` or `PESOWISE_EMPLOYEE_DATA_FILE`. There is
deliberately **no default path** pointing at repository data.

### 5. Before every commit or push

1. `npm run security:secrets`
2. `git status --short`
3. read the staged diff
4. reject unexpected `.tsv` / `.csv` / `.json` / `.sql` / `.har` / archive files
5. confirm no secret-like value appears in anything staged

### 6. When a task needs real employee or customer data

Stop before committing it. Use a local ignored file. Document the **schema and
purpose only**. Never reproduce actual records in a response.

### 7. When sensitive data is discovered

Stop feature work. Do **not** print it. Report path, category and a truncated
fingerprint only. Remove it from the current tree, then assess Git history —
and never claim cleanup is complete on the strength of a normal deletion.

### 8. Never weaken the guards

Do not relax `.gitignore`, the secret tests or security CI to make a push
succeed. A failing guard is information, not an obstacle.

### 9. Never `git add -f` an ignored sensitive file

There is no situation in this repository where that is the right move.

### 10. Keep the documentation current

Update [`Documentations MD/sensitive-local-data-policy.md`](./Documentations%20MD/sensitive-local-data-policy.md)
whenever a new local sensitive input type appears, an ignored path changes, a
script begins consuming external operational data, or a safe template changes
schema.

**The production employee file is intentionally absent from this repository. Do
not reconstruct it from Git history, old clones, backups, logs or screenshots.**
