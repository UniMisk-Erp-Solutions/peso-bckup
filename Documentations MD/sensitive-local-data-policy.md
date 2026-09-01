# DOC-083 — Sensitive Local Data Policy

**Last updated:** 2026-08-03
**Status:** deployed
**Related:** [DOC-082](./security-sweep-and-merge-readiness-2026-08-02.md), [CLAUDE.md](../CLAUDE.md), [clone instructions](./post-history-rewrite-clone-instructions.md)

> **The production employee file is intentionally not included in this
> repository. Do not reconstruct it from Git history, old clones, backups, logs
> or screenshots.**

This document names no person, no password, no formula and no credential.

---

## 1. Why `scripts/data/microlink-remove-employees.tsv` is absent

It held real employee operational data for a whole organization — identities,
employee IDs, positions, plaintext login credentials, supervisor mappings and
work locations — and it was **tracked**, reachable from five branches, from a
single commit in early history until the 2026-08-02 audit.

It was removed from the working tree and then purged from all reachable history
in the authorized 2026-08-03 rewrite.

**It must never be restored.** Not from an old clone, not from a backup mirror,
not by re-exporting the same query into the same path. If you need that data to
run something, supply it at runtime from outside the repository (§3).

Removed alongside it, for the same reason:

| Path | Why |
|---|---|
| `scripts/data/microlink-supervisor-emails.json` | real supervisor email addresses |
| `scripts/remove-org-employees-microlink-6709.sql` | generated 208-ID artifact; regenerable |
| `scripts/reset-microlink-employee-passwords.sql` | bulk credential-reset tooling |
| `scripts/sync-microlink-passwords.mjs` | existed only to push plaintext employee passwords |
| `scripts/sync-microlink-passwords-service.mjs` | same |
| `.env` (history only) | database credentials |

The two password-sync scripts were **deleted rather than refactored**. Their
entire purpose was to read per-employee plaintext credentials and write them into
the auth system. There is no safe input for that, so there was nothing to
refactor toward.

Separately, a real database password literal was found in
`scripts/post-restore/run-auth-null-token-fix.ps1` and
`scripts/post-restore/run-storage-policies.ps1` during this work and replaced
with a `PESOWISE_DB_PASSWORD` environment reference.

---

## 2. Scripts that used to depend on it

| Script | Purpose | Needed the password column? |
|---|---|---|
| `scripts/generate-link-microlink-supervisors-sql.mjs` | employee → supervisor SQL | no |
| `scripts/generate-microlink-import-csv.mjs` | bulk-import CSV | it read one; it never needed one |
| `scripts/generate-remove-org-employees-sql.mjs` | removal SQL by employee ID | no |

All three now share `scripts/lib/employeeDataInput.mjs`. The import CSV no longer
emits a password column at all: bulk import authenticates **server-side with
administrative authorization against immutable user IDs**, so a per-employee
credential was never required.

`generate-remove-org-employees-sql.mjs` also no longer rewrites its own input
file in place — reading operator data and writing back to it is not that tool's
business, and it is part of how a working file became a tracked one.

---

## 3. Runtime input contract

```bash
node scripts/generate-remove-org-employees-sql.mjs --input /secure/path/file.tsv --confirm
```

```bash
PESOWISE_EMPLOYEE_DATA_FILE=/secure/path/file.tsv node scripts/generate-microlink-import-csv.mjs
```

The loader enforces:

- **no default path** — omitting input exits `1` with an explanatory message
- input resolved with `path.resolve`, so a traversal string cannot smuggle a path
- input **must be a regular file** — a directory or symlink is rejected explicitly
- input **must not live inside the repository**, except under `.local-sensitive-data/`
- POSIX group/other read permission produces a warning
- output defaults to `.local-sensitive-data/exports/`, never a tracked directory
- destructive operations require `--confirm`
- temporaries are removed via `finally` and an `exit` hook
- **no record is ever logged** — only a row count
- validation errors name a row number and a field name, never a value

### Accepted columns

`name` · `employee_id` · `position` · `immediate_supervisor_employee_id` ·
`location` · `email`

### Rejected columns

`password` · `passwd` · `pwd` · `secret` · `token` · `api_key` · `private_key` ·
`service_role`

A rejected column fails the run **before any value is read into a row**.

---

## 4. The canonical local directory

```
.local-sensitive-data/
  employee-operations/   operator-supplied inputs
  imports/               prepared import files
  exports/               generated output (default --out)
  temporary/             scratch, cleaned each run
  db-backups/<date>/     full database dumps (see 4a)
```

Entirely gitignored. Nothing in it is ever committed.

### 4a. Database backups (added 2026-09-01)

Full `pg_dump` backups of the **backup** Supabase instance are written to
`.local-sensitive-data/db-backups/<YYYY-MM-DD>/`. A dump is the single most
sensitive artifact this repository's workflow ever produces — one file holding
every auth user, every profile and every expense record — so it is treated as
strictly as the employee TSV that caused this policy to exist.

Each dated folder holds:

| File | Contents |
|---|---|
| `pesowise_<date>_full_db.sql.gz` | every schema, all data, ownership, ACLs, RLS policies, functions |
| `pesowise_<date>_globals.sql.gz` | cluster roles, role passwords, memberships, grants |
| `SHA256SUMS.txt` | checksums, verified against the server after transfer |
| `MANIFEST.md` | provenance, object/row counts, restore procedure, exclusions |

Rules specific to dumps:

- **Storage bucket contents are never included.** Only `storage.objects`
  metadata rows travel in the dump. Bucket blobs are excluded by construction
  (they do not live in Postgres) and must not be added.
- **The globals file contains role passwords.** It is small enough to be
  mistaken for something harmless. It is not.
- Take dumps from the **backup** instance. A Production dump requires explicit
  owner authorization and does not belong on a workstation by default.
- Verify with `sha256sum -c SHA256SUMS.txt` before relying on a backup, and
  `gzip -t` before restoring.
- Restores use `--clean --if-exists`; they **DROP before recreating**. Never
  restore over a live database you intend to keep.
- Delete dated folders once they are no longer needed. They do not expire on
  their own, and every stale copy is standing exposure.

**Verify a file is ignored** before you put anything real in it:

```bash
git check-ignore -v .local-sensitive-data/whatever.tsv
```

Output means ignored. **No output means it would be committed — stop.**

**If Git reports an ignored file** as untracked or stages it, the ignore rule is
wrong. Fix the rule. Never reach for `git add -f`: it is the command that put the
original file into this history, and it has no legitimate use here.

---

## 5. Who may supply the file, and disposal

Only someone already authorized to access that employee data in the source
system. Receiving it does not grant onward distribution rights.

**Delete it when the operation is done.** These are working files with a lifetime
of one task, not a local dataset. On POSIX, `chmod 600` before use.

---

## 6. Synthetic fixtures

Use `scripts/data/examples/employee-operation.example.tsv` — fictional names,
`EX-` prefixed IDs, invented locations, no password column, no real email, UUID
or organization ID. Tests assert it stays that way.

New fixtures must be invented, never sampled from production and lightly edited.

---

## 7. Running the scanner

```bash
npm run security:secrets
```

```bash
npm run security:secrets -- --staged
```

Exits `0` clean, non-zero on detection, and prints **category and path only** —
never a value. Offline, Windows and Linux.

It detects: forbidden paths, tracked local-sensitive paths, risky file types,
service-role JWTs, Supabase secret keys, private-key blocks, GitHub tokens, AWS
keys, HAR `Authorization` headers, session-cookie exports, SSH and database
password literals, credential-bearing DSNs, credential columns in delimited
files, and bulk personal exports.

It deliberately does **not** flag `.env.example`, placeholder DSNs, interpolated
variables, DSN-parsing regexes, the synthetic templates, the word "password" in
UI translations, or documentation explaining that passwords are prohibited.

---

## 8. Updating this policy

Update it in the **same commit** as the change when a new local sensitive input
type is introduced, an ignored path changes, a script begins consuming external
operational data, or a template changes schema. `sensitiveDataPolicy.test.ts`
checks this document and `CLAUDE.md` have not drifted apart.

---

## 9. History rewrite and residual risk

The 2026-08-03 rewrite removed the sensitive paths from every reachable commit on
`main` and `dev` and force-pushed sanitized history. See
[post-history-rewrite-clone-instructions.md](./post-history-rewrite-clone-instructions.md)
— **every collaborator must re-clone**, and no old clone may ever be pushed.

### OWNER-ACCEPTED RESIDUAL ACCOUNT RISK

The owner has decided **not** to reset the affected employee passwords.

State this plainly wherever the cleanup is described:

- Removing data from GitHub **does not invalidate copies already taken.** Anyone
  who cloned, forked or downloaded before the rewrite still has the records.
- The credentials followed a **predictable scheme**, so they are guessable in
  bulk even without the file.
- Those accounts may therefore still be accessible.
- **Repository cleanup cannot prove any of those accounts is secure.**

This is **owner-accepted residual account risk** — not a resolved finding. It
does not become resolved through further repository work. Only an account-level
credential reset to values outside the original scheme would resolve it.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-03 | 1.0 | Agent | Created with the authorized sensitive-data removal and history rewrite. Documents why the employee TSV is absent and must not be restored, the six other paths removed with it, the real DB password literal scrubbed from two post-restore scripts, the runtime `--input` contract and its validation rules, the ignored `.local-sensitive-data/` directory, the synthetic template, the `npm run security:secrets` scanner, the `git add -f` prohibition, disposal expectations, and the owner-accepted residual account risk. Names no person, password, formula or credential. |
| 2026-09-01 | 1.1 | Agent | Added §4a covering full database backups, a new class of local sensitive artifact: `.local-sensitive-data/db-backups/<date>/` now holds gzipped `pg_dump` output for the backup instance. Records the two-file layout (database + cluster globals, the latter carrying role passwords), the checksum/manifest requirement, that storage bucket blobs are excluded by construction while `storage.objects` metadata is retained, that dumps come from the backup instance rather than Production absent owner authorization, that restores are destructive (`--clean --if-exists`), and that stale dated folders must be deleted rather than left to accumulate. Names no person, credential or record. |
