# DOC-081 — Review Actions: Staging Provisioning Plan

**Last updated:** 2026-08-02
**Status:** draft — nothing provisioned; awaiting owner approval
**Related:** [DOC-080](./debug-review-expenses-manual-employee-search.md)

---

## Why this exists

Review actions (verify / advance tier / approve / reject / correct, plus bulk)
are implemented on `dev` behind `VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED`,
which is **false**. They cannot be enabled because **no writable PesoWise
database exists anywhere.**

That is a measured fact, not an assumption. A read-only fingerprint of every
Supabase stack on `websrv` (2026-08-02) found:

| Stack | Domain | PesoWise schema? | Verdict |
|-------|--------|------------------|---------|
| `evo3o0fdjaroxq7uohrm21cp` | pesowise-supabase.unimisk.com | yes — 5 orgs, 449 profiles, 11,965 expenses, activity today | **Production** |
| `i4udj52fusjqg94mxyrmqub2` | servicewise-supabase.unimisk.com | no `expenses` table | different product |
| `qrnm9mnevk57tgd3suc5zkye` | sslip.io, unrouted | has `organizations`, no `expenses` | wrong schema |
| `spfohj2m4ij61p4riaup006i` | sslip.io, unrouted | neither table | wrong schema |
| `kp0c9mpvmfneb2eu1gi5dppo` | sslip.io, unrouted | neither table | wrong schema |

The **"Trial" organization inside Production is explicitly excluded** as a
mutation target by owner decision. Mutating it would still be mutating
Production.

---

## What must be provisioned

A dedicated stack, isolated from Production at every layer.

| Item | Value |
|------|-------|
| Stack name | `pesowise-staging` |
| Domain | `pesowise-staging-supabase.unimisk.com` (or an `sslip.io` host if DNS is slow) |
| Database | its own volume — **not** a Production volume mount |
| Storage | its own MinIO bucket and volume |
| Schema | every migration in `supabase/migrations/`, applied in filename order |
| Seed | synthetic only (below) |

### Port and domain collision check

Before provisioning, confirm the chosen host is not already claimed:

```bash
docker ps --format '{{.Names}}' | grep -i pesowise-staging
docker inspect $(docker ps -q) --format '{{json .Config.Labels}}' | grep -o 'Host(`[^`]*`)' | sort -u
ss -ltnp | awk '{print $4}' | sort -u
```

Coolify assigns its own internal ports per stack, so collisions normally appear
only at the Traefik host rule. The `grep -o 'Host(...)'` line above is the check
that matters.

### Resource requirements

Each Supabase stack on this host runs ~14 containers. Five already run there.
Budget roughly **2 GB RAM and 5 GB disk** for a sixth with synthetic data, and
confirm headroom first:

```bash
free -m; df -h /; docker ps -q | wc -l
```

---

## Seed data — synthetic, never a Production clone

**Do not copy** Production auth users, password hashes, receipt files, employee
names, transaction numbers or balances. A sanitized clone is still personal data
and receipt files are the subject of an open incident (DOC-077/078).

Create instead:

**One organization** — `Staging Co`, feature flags matching Production
(`approval_hierarchy`, `hierarchy_team_leader`, `hierarchy_executive` all on,
which is what the audit measured for the real org).

**Test accounts** — one per role, so tier transitions can actually be exercised:

| Account | Role | Purpose |
|---------|------|---------|
| `staging.engineer@example.invalid` | engineer | engineer-tier verify, approve, reject |
| `staging.leader@example.invalid` | team_leader | team-leader tier advance |
| `staging.exec@example.invalid` | executive | executive tier advance, handoff |
| `staging.employee@example.invalid` | employee | owns the expenses under review |
| `staging.employee2@example.invalid` | employee | second submitter for bulk tests |

**Expense fixtures** — one per scenario the action tests need:

| # | Status | Tier | Purpose |
|---|--------|------|---------|
| 1 | submitted | engineer | engineer verify → terminal |
| 2 | submitted | team_leader | team-leader advance |
| 3 | submitted | executive | executive advance |
| 4 | level_1_verified | executive | mid-workflow, pending not completed |
| 5 | level_2_verified | engineer | manager-ready after handoff |
| 6 | submitted | engineer | approve, within approval limit |
| 7 | submitted | engineer | approve, **exceeds** approval limit |
| 8 | submitted | engineer | reject with reason |
| 9 | submitted | engineer | correction |
| 10 | approved | engineer | terminal — must stay view-only |
| 11 | rejected | (null) | terminal — must stay view-only |
| 12 | submitted | team_leader | wrong-tier denial for the engineer |
| 13 | submitted | engineer | **owned by the reviewer** — self-review denial |
| 14 | submitted | engineer | batch member — batch flow |
| 15 | submitted | engineer | stale-state: mutate out of band, then act |

Fixture 13 reproduces the transaction-03994 defect found in Production.

The realistic *distribution* (≈7.5k submitted at executive tier, 1.8k at
team_leader) is not needed for correctness testing. If a volume check is wanted
later, generate synthetic rows in those proportions — do not import real ones.

---

## Rollout procedure

1. Provision the stack; confirm it has its own DB and storage volumes.
2. **Snapshot the empty database** so teardown/restore is cheap.
3. Apply migrations in order, ending with `20260802020000`.
4. Reload the PostgREST schema cache.
5. `SELECT public.debug_review_queue_capabilities_v1();` → expect
   `ready: true`, `schema_revision: 20260802020000`, and `assigned_scope`,
   `scope_audit`, `page_anchor`, `keyed_scope` all true.
6. Seed the organization, accounts and 15 fixtures.
7. Point a Preview deployment at the staging Supabase URL and anon key.
8. Set `VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED=true`,
   `VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED=true` **in that Preview only**.
9. Run the action checklist in DOC-080 for all three reviewer roles.
10. After each mutation, re-check `reconciliation_ok` on the queue response.

## Backup / restore

```bash
docker exec supabase-db-<staging> pg_dump -U postgres -Fc postgres > staging.dump
docker exec -i supabase-db-<staging> pg_restore -U postgres -d postgres --clean < staging.dump
```

Because the data is synthetic, restore-from-empty is usually faster than a
selective rollback.

## Teardown

Stop and remove the stack **and its volumes** through Coolify. Confirm no
volume is shared with Production before deleting anything:

```bash
docker inspect supabase-db-<staging> --format '{{json .Mounts}}'
```

---

## What is blocked until this exists

- every runtime action test
- the wrong-tier and stale-state conflict tests
- the bulk partial-failure test
- enabling `VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED` anywhere
- merging action enablement to `main`

Read-only Preview against Production is unaffected and remains safe.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-02 | 1.0 | Agent | Initial. Written after a read-only fingerprint proved no PesoWise-schema database exists outside Production. Specifies an isolated stack, synthetic seed data, 5 role accounts and 15 expense fixtures covering every action path including self-review and stale-state. Nothing provisioned; no server stack created or destroyed. |
