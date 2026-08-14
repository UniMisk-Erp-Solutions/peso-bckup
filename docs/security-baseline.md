# Security Baseline And Non-Breakable Flows

This baseline is used to verify that security/performance hardening does not break core product behavior.

## Non-breakable flows

1. Authentication
   - Sign in
   - Sign out
   - Session persistence
2. User management (admin)
   - Create user
   - Edit user (name/email/role/balance)
   - Reset password
3. Expense lifecycle
   - Create/submit expense
   - Review/verify/approve/reject
4. Money movement
   - Transfer assignment
   - Return money request/approval
5. Reporting and history
   - Transfer history view/export
   - Reports view/export
6. Notifications
   - In-app list
   - Read/unread state

## Baseline commands

- Lint: `npm run lint`
- Tests: `npm run test -- --run`
- Build: `npm run build`

## Baseline evidence checklist

- [ ] Lint passes
- [ ] Tests pass
- [ ] Build passes
- [ ] Auth flow manually validated
- [ ] User management manually validated
- [ ] Expense flow manually validated
- [ ] Money return flow manually validated
- [ ] Report export manually validated

