# Example input for employee-operation scripts

**THIS FILE CONTAINS SYNTHETIC EXAMPLE DATA ONLY.**

Every name, employee ID, supervisor ID and location in
`employee-operation.example.tsv` is fictional. Nothing here was copied from any
real record, and no value corresponds to a real person, organization or system.

## Deliberate omissions

There is **no `password` column**, and there never will be. The shared loader
(`scripts/lib/employeeDataInput.mjs`) rejects `password`, `secret`, `token`,
`api_key`, `private_key` and `service_role` outright, so an input carrying one
fails before a value reaches memory. Bulk import authenticates server-side with
administrative authorization against immutable user IDs; a per-employee
credential was never needed.

There are also no real emails, UUIDs or organization IDs.

## Using it

```bash
node scripts/generate-remove-org-employees-sql.mjs \
  --input scripts/data/examples/employee-operation.example.tsv --confirm
```

Real operational data must live **outside the repository**, or under
`.local-sensitive-data/`, which is gitignored. See
[`sensitive-local-data-policy.md`](../../../Documentations%20MD/sensitive-local-data-policy.md).
