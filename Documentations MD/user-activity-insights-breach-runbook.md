# User Activity Insights — Breach Response Runbook

**Document type:** Security incident / breach response runbook  
**For feature:** User Activity Insights (PesoWise)  
**Doc status:** Draft — review and validate with security/legal team before production rollout  
**Last updated:** 2026-07-13  
**Related:** [user-activity-insights.md](./user-activity-insights.md) · [user-activity-insights-dpia.md](./user-activity-insights-dpia.md) · [user-activity-insights-data-inventory.md](./user-activity-insights-data-inventory.md)

> ⚠️ **This runbook is a technical draft.** It must be reviewed, validated, and owned by a named incident responder or security officer before production rollout. Do not cite statutory notification timelines without legal confirmation.

---

## 1. What counts as a breach for this feature

A breach relevant to User Activity Insights is any unauthorised access, disclosure, alteration, or loss of data in the following tables:

| Table | Data |
|-------|------|
| `public.user_activity_sessions` | Session timestamps, visible seconds, user agent |
| `public.user_activity_daily_rollups` | Per-day activity summaries, expense counts |
| `public.user_activity_notice_acknowledgements` | User acknowledgement records |
| `public.user_activity_feature_audit_logs` | Feature enable/disable audit records |

### Breach scenarios

| Scenario | Severity |
|----------|----------|
| RLS misconfiguration exposes one org's activity data to another org | Critical |
| Supabase service key leaked, granting read access to all activity tables | Critical |
| Unauthorised admin account enabled within an org and viewed activity data | High |
| Bulk export of activity data by a legitimate admin outside authorised purpose | High |
| Activity data included in a backup file that is inadvertently shared | Medium |
| Single user's session data accessed by another user within the same org | Medium |
| Acknowledgement records disclosed without authorisation | Low–Medium |

### What is NOT a breach for this feature

- Normal admin access to their own org's activity data (authorised)
- Master admin access via SQL Editor for support purposes (authorised)
- Activity data being deleted by retention cleanup (authorised)

---

## 2. Data involved

**Per-user data at risk:**

- Session start/end/last-seen timestamps
- Daily visible PesoWise time (seconds)
- Daily session count
- Daily expense submission count
- Browser user agent string
- Acknowledgement timestamp

**Sensitivity:** Low–Medium. Not financial transaction data. Not credentials. Not biometric data. Still identifies when a named user was active in PesoWise, which may be sensitive in employment contexts.

**Volume at risk (estimate):**
- Each session row: ~10 fields
- Each daily rollup row: ~9 fields
- Max rows per active user per year: ~365 rollup rows + ~500–1000 session rows

---

## 3. Immediate containment steps

Upon discovery or suspicion of a breach:

1. **Stop the bleeding**
   - If RLS misconfiguration: immediately identify and patch the RLS policy. Use SQL file 14 (`14_harden_notice_ack_policy_idempotency.sql`) as a reference for safe policy recreation.
   - If service key leaked: rotate the Supabase service key immediately via the Supabase dashboard → Settings → API.
   - If unauthorized account: disable/remove the account from the organization in PesoWise User Management.
   - If feature misconfigured for wrong org: disable the feature for that org immediately via Master Admin Dashboard.

2. **Preserve evidence**
   - Do not modify or delete any data until the investigation is complete.
   - Take a snapshot of relevant Supabase logs (see Section 8).
   - Record the discovery time, reporter identity, and initial description.

3. **Notify incident response owner**
   - Incident owner: **[Name/role — fill in]**
   - Contact: **[Email/phone — fill in]**
   - Escalation: **[Name/role — fill in]**

---

## 4. Impact assessment

Assess the scope of the incident:

| Question | How to determine |
|----------|-----------------|
| Which organisations are affected? | Run Section 5 query (a) |
| Which users are affected? | Run Section 5 query (b) |
| What data was accessed or exposed? | Supabase logs → API logs / Auth logs |
| Was data exfiltrated or only accessible? | Review Supabase API logs and audit events |
| How long was the vulnerability open? | Compare policy creation time vs. last known correct state |
| Was the data modified or deleted? | Compare current counts to backup/snapshot |

---

## 5. Affected org/user identification queries

Run in Supabase SQL Editor (service role or direct Postgres access).

```sql
-- (a) All orgs with activity data (to assess breadth of potential exposure)
SELECT
  o.id           AS org_id,
  o.name         AS org_name,
  COUNT(DISTINCT s.user_id) AS distinct_users_with_sessions,
  COUNT(s.id)    AS total_sessions,
  MIN(s.started_at) AS earliest_session,
  MAX(s.started_at) AS latest_session
FROM public.user_activity_sessions s
JOIN public.organizations o ON o.id = s.organization_id
GROUP BY o.id, o.name
ORDER BY total_sessions DESC;

-- (b) All users with activity data in a specific org
-- Replace %ORG_NAME% with the affected org's name.
SELECT
  u.id    AS user_id,
  u.email,
  COUNT(s.id) AS session_count,
  MIN(s.started_at) AS first_session,
  MAX(s.last_seen_at) AS last_seen
FROM public.user_activity_sessions s
JOIN auth.users u ON u.id = s.user_id
JOIN public.organizations o ON o.id = s.organization_id
WHERE o.name ILIKE '%ORG_NAME%'
GROUP BY u.id, u.email
ORDER BY session_count DESC;

-- (c) Check current RLS state on activity tables
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'user_activity_sessions',
    'user_activity_daily_rollups',
    'user_activity_notice_acknowledgements',
    'user_activity_feature_audit_logs'
  );
-- All rows should show rowsecurity = true.

-- (d) List current policies on activity tables
SELECT policyname, tablename, cmd, permissive, qual
FROM pg_policies
WHERE tablename IN (
  'user_activity_sessions',
  'user_activity_daily_rollups',
  'user_activity_notice_acknowledgements',
  'user_activity_feature_audit_logs'
)
ORDER BY tablename, policyname;
```

---

## 6. Communication placeholders

| Audience | Channel | Owner | Template reference |
|----------|---------|-------|-------------------|
| Internal engineering team | [Slack/email — fill in] | Engineering lead | — |
| Legal/DPO | [Email — fill in] | Incident owner | — |
| Affected organisations | [Email — fill in] | [Account manager/legal — fill in] | See Section 7 |
| Affected users (if individual notification required) | [Method — fill in] | [Org admin / PesoWise — fill in] | — |
| Data protection authority (if legally required) | [Portal/email — fill in] | Legal counsel | — |

---

## 7. Notification checklist

> **Follow applicable DPDP/legal notification timelines after legal review.**  
> Statutory notification timelines must be confirmed with legal counsel — do not assume them from this document.

- [ ] Incident discovered and contained
- [ ] Evidence preserved (do not delete before investigation)
- [ ] Incident owner notified
- [ ] Legal counsel/DPO notified
- [ ] Scope of affected data and users determined
- [ ] Legal counsel advises on notification obligations
- [ ] Affected organisations notified (if legally required or as good practice)
- [ ] Affected users notified (if legally required)
- [ ] Data protection authority notified (if legally required)
- [ ] Notification records kept

---

## 8. Evidence preservation

Preserve the following before any remediation:

| Evidence | Where to find |
|----------|--------------|
| Supabase Auth logs | Supabase Dashboard → Authentication → Logs |
| Supabase API logs | Supabase Dashboard → Logs → API logs |
| Supabase Postgres logs | Supabase Dashboard → Logs → Postgres logs |
| RLS policy state at time of incident | `pg_policies` query (Section 5d) — screenshot immediately |
| Activity data counts per org | Section 5a query — screenshot immediately |
| Feature audit log | `user_activity_feature_audit_logs` (if table applied) |
| Git history | `git log --oneline` on feature branch — preserve commit hash |

---

## 9. Post-incident remediation

After the immediate incident is resolved:

1. **Root cause analysis** — Document what caused the breach and how it was discovered.
2. **Policy/RLS review** — Re-run file 14 (`14_harden_notice_ack_policy_idempotency.sql`) to re-establish correct policies; verify with `pg_policies` query.
3. **Access review** — Audit which admin accounts have access to affected orgs; remove any unauthorised access.
4. **Data impact review** — Determine if any data needs to be deleted as part of breach remediation.
5. **Documentation update** — Update this runbook and the DPIA with lessons learned.
6. **Process improvement** — Add monitoring or alerting for RLS anomalies if technically feasible.
7. **Legal follow-up** — Confirm with legal counsel that all required notifications have been sent and documented.
8. **Ticket closure** — Close the incident ticket with full timeline, root cause, remediation steps, and notification records.

---

## 10. Runbook owner and review

| Item | Detail |
|------|--------|
| Runbook owner | [Name/role — fill in] |
| Last reviewed | 2026-07-13 (draft) |
| Next review due | Before production rollout; annually thereafter |
| Approval status | Draft — not yet approved |
