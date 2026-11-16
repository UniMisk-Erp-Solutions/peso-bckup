# Partial recovery (preferred for accidental DELETE)

Production **stays online**.

1. Restore **isolated** DB to `T_PRE_DELETE` (PITR).  
2. Query missing IDs in recovery DB.  
3. Export bundle (`export-recovered-entity.ts`) with checksums.  
4. Human review + compliance sign-off.  
5. Controlled reinsert into production (manual SQL or approved RPC) — **never automatic**.

Do not use `.68` replica as a substitute for step 1.
