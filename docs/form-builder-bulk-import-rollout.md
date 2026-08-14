# Org Form Builder + Bulk Import Rollout

## Feature flags

`organization_settings` includes:

- `enable_form_builder_v2`
- `enable_bulk_imports`

Recommended rollout:

1. Enable both for internal/test orgs only.
2. Validate submit/review/detail rendering and bulk dry-run responses.
3. Enable for one production org at a time.
4. Keep a rollback path by turning flags off.

## Bulk import functions

All functions expect authenticated org-admin callers and support `dry_run`.

- `bulk-users-import`
- `bulk-categories-import`
- `bulk-field-definitions-import`
- `bulk-field-values-import`

Common request shape:

```json
{
  "organization_id": "<optional-org-id>",
  "dry_run": true,
  "rows": []
}
```

### Users CSV format

Required headers:

- `name`
- `email`
- `position` (or `role`)
- `password`

Optional headers:

- `assigned_manager_email`
- `location`

`position` aliases:

- `manager` -> `engineer`
- `administrator` -> `admin`
- `staff` -> `employee`

Manager resolution:

1. `assigned_manager_email`

If manager is unresolved, import continues with a row warning.

Example:

```csv
name,email,position,password,assigned_manager_email,location
John Manager,john.manager@company.com,manager,Password@123,,Mumbai
Alice Employee,alice.employee@company.com,employee,Password@123,john.manager@company.com,Mumbai
Bob Cashier,bob.cashier@company.com,cashier,Password@123,john.manager@company.com,Mumbai
```

Common response shape:

```json
{
  "success": true,
  "organization_id": "<org-id>",
  "dry_run": true,
  "total": 10,
  "ok": 8,
  "failed": 2,
  "results": []
}
```

## Validation checklist

- Base field config changes in Settings reflect in Expense Form.
- Hidden base fields are not shown in `ExpenseForm`.
- Required base fields block submit when missing.
- Dynamic fields respect `show_on_review` / `show_on_detail`.
- Dry-run returns validation output without data changes.
- Cross-org calls are rejected.
