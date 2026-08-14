# SQL to re-run after May 27, 2026 5:30 AM backup

## Easiest manual way (3 copy-paste files)

See **[MANUAL-RUN.md](./MANUAL-RUN.md)** and run in order:

1. `manual-section-1-grants-and-urls.sql`
2. `manual-section-2-hierarchy-migrations.sql`
3. `manual-section-3-manager-and-verify.sql`

Then: `npm run post-restore:storage`

---

## Automated way (PC with psql)

```powershell
npm run post-restore:migrations:full
npm run post-restore:storage
```

---

## Full list of 20 migrations (reference)

| # | File |
|---|------|
| 1–18 | See MANUAL-RUN.md (hierarchy batch) |
| 19 | `20260528183500_manager_visibility_stable_rpc.sql` → Section 3 |
| 20 | `20260530120000_fix_public_schema_grants_after_restore.sql` → Section 1 |
