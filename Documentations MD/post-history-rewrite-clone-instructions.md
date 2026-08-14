# DOC-084 — Post-History-Rewrite Clone Instructions

**Last updated:** 2026-08-03
**Status:** deployed
**Audience:** every collaborator, and anyone administering a deployment that checks this repository out
**Related:** [DOC-083](./sensitive-local-data-policy.md), [DOC-082](./security-sweep-and-merge-readiness-2026-08-02.md)

---

## What happened

On **2026-08-03** the history of `main` and `dev` was rewritten to purge tracked
sensitive data. **Every commit SHA changed.** The rewritten branches were
force-pushed.

The code is identical. Only the history differs.

---

## What you must do

### 1. Stop pushing immediately

Do not push, merge or open a PR from an existing clone. **A push from an old
clone silently restores every purged object** — one `git push` undoes the entire
rewrite.

### 2. Preserve any uncommitted work as a patch

From your old clone, before deleting it:

```bash
git diff > ~/my-work.patch
git status --short
```

Read the patch before reapplying it. If it touches a `.tsv`, `.csv`, `.json`,
`.sql`, `.har` or archive file you did not deliberately create, stop and ask.

### 3. Delete the old clone

```bash
cd ..
rm -rf peso-patidar
```

Do not keep it "just in case". It contains the sensitive history.

### 4. Clone fresh

```bash
git clone https://github.com/Mithil1105/peso-patidar.git
cd peso-patidar
npm ci
npm run security:secrets
```

### 5. Reapply your patch

```bash
git apply ~/my-work.patch
npm run security:secrets
```

Then delete the patch file.

---

## Rules from here

- **Never push an old clone.** Not a branch, not a tag, not a single commit.
- **Never merge an old branch** into a rewritten one — it reintroduces old
  objects wholesale.
- **Never push old tags.** (There were none, so there is nothing to restore.)
- **Do not cherry-pick from an old clone** without reviewing the diff first.
- If you are unsure whether a clone is old, check whether `git log --oneline -1`
  on `main` matches the SHA the administrator published. If it does not, it is
  old.

---

## Administrator checklist

| Surface | Action |
|---|---|
| Collaborator clones | Notify everyone; confirm each has re-cloned |
| Local branches | Old local branches on any machine must be deleted, not merged |
| Deploy keys | Review; rotate any that are unaccounted for |
| GitHub Apps / integrations | Review installed apps and their repository access |
| CI checkouts | None configured — no `.github/workflows` in this repository |
| Vercel Git integration | Reconnects automatically; trigger a fresh deployment and confirm READY |
| Coolify / server checkouts | Any server holding a clone must re-clone, not `git pull` |
| Backup mirrors | The pre-rewrite mirror contains sensitive history — keep offline, restricted, and delete after the agreed retention period |
| Forks | Check the fork network; a fork retains the old objects independently |

---

## GitHub cached objects

GitHub can retain unreachable objects and cached commit views after a force-push.
An administrator should submit a sensitive-data removal request to GitHub Support
naming the repository, the affected historical paths and the old commit SHAs,
confirming history was rewritten, and asking for cached objects and views to be
purged.

**Do not include any secret value or employee record in that request.**

---

## Residual risk

Repository cleanup does not recall data already copied. The
**owner-accepted residual account risk** described in
[DOC-083 §9](./sensitive-local-data-policy.md) remains open, and repository work
cannot close it.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-03 | 1.0 | Agent | Created with the authorized history rewrite. Covers the stop-pushing rule, patch preservation, delete-and-re-clone procedure, the prohibition on pushing or merging old clones, the administrator surface checklist, the GitHub Support cached-object request, and the residual risk that repository cleanup cannot close. |
