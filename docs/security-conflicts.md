# Security Conflicts Log

Track any functional regression caused by security/performance hardening here.

## How to use

- Add one entry per conflict.
- Keep newest entries at the top.
- Update `Status` as fixes land.

## Template

```md
## [YYYY-MM-DD] <short title>
- Change introduced:
- Impacted flow:
- Reproduction steps:
  1.
  2.
  3.
- Severity: blocker | high | medium | low
- Temporary mitigation:
- Final fix:
- Status: open | mitigated | resolved
```

## Current entries

## [2026-04-28] Existing automated test-suite failures block full regression sign-off
- Change introduced: Security hardening rollout baseline verification.
- Impacted flow: Automated regression coverage confidence.
- Reproduction steps:
  1. Run `npm run test -- --run`
  2. Observe failing integration tests in `src/__tests__/integration/expense-flow.test.tsx`
  3. Errors reference unresolved `require('@/contexts/AuthContext')` usage.
- Severity: medium
- Temporary mitigation: Use `npm run build` plus targeted manual checks for critical flows while test fixes are prepared.
- Final fix: Refactor failing tests to ESM-safe imports/mocks and restore green baseline.
- Status: open

## [2026-04-28] Repository-wide lint baseline contains pre-existing errors
- Change introduced: Security hardening verification.
- Impacted flow: CI gate quality checks.
- Reproduction steps:
  1. Run `npm run lint`
  2. Observe multiple existing lint errors across app and generated cache files.
- Severity: medium
- Temporary mitigation: Track security-specific changed files with focused lint checks and continue hardening rollout.
- Final fix: Clean existing lint backlog and exclude transient cache artifacts from lint scope.
- Status: open

