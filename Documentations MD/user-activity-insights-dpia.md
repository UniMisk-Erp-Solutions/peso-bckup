# User Activity Insights — Data Protection Impact Assessment (DPIA)

**Document type:** Privacy Impact Assessment  
**For feature:** User Activity Insights (PesoWise)  
**Doc status:** Draft — must be reviewed by legal/DPO before production rollout  
**Last updated:** 2026-07-13  
**Prepared by:** Engineering team — legal review required  
**Related:** [user-activity-insights.md](./user-activity-insights.md) · [user-activity-insights-data-inventory.md](./user-activity-insights-data-inventory.md) · [user-activity-insights-privacy-notice.md](./user-activity-insights-privacy-notice.md)

> ⚠️ **This DPIA is a technical draft.** It must be reviewed and formally adopted by legal counsel and/or a Data Protection Officer before the feature is rolled out in production. It does not constitute legal or compliance advice.

---

## 1. Feature overview

**Name:** User Activity Insights  
**Branch:** `feature/user-activity-insights`  
**Purpose:** Allows organisation admins in PesoWise to review in-app activity data for their employees — specifically visible PesoWise app time, session count, last seen time, and expense submission activity.

**Feature flag:** `user_activity_insights` in `organization_features` table.  
Disabled by default. Enabled per-organisation by master admin only, with a confirmation disclaimer.

---

## 2. Necessity and proportionality

| Question | Answer |
|----------|--------|
| Is collection necessary for the stated purpose? | Yes — visible session time and last-seen time cannot be derived from expense data alone. |
| Is the data volume proportionate? | Yes — only 6 data points per session (start time, last seen, visible seconds, session count, expense count, user agent). No content is recorded. |
| Could the same purpose be achieved with less data? | Partially — expense count comes from an existing trigger. Session time requires explicit tracking. The current set is already minimal. |
| Is processing limited to what is necessary? | Yes — no keystrokes, screenshots, mouse data, off-app activity, or device sensors are collected. |

---

## 3. Data minimisation analysis

| Data collected | Necessity | Could be removed? |
|---------------|-----------|-------------------|
| Session start time | Required for "first seen" | No |
| Last seen time | Required for "inactive" detection | No |
| Visible seconds | Core metric (time in foreground) | No |
| Session count | Indicates re-engagement pattern | Low risk; optional future reduction |
| Expenses submitted count | Correlates activity with work output | Low risk; could be excluded if not needed |
| User agent | Browser/device type; used for session hygiene | Low sensitivity; could be excluded |
| Heartbeat count | Internal counter; not shown in UI | Could be excluded from UI; kept for data integrity |

**Conclusion:** The dataset is already minimal. No high-risk identifiers (location, biometrics, financial data) are included.

---

## 4. Purpose limitation

The data is collected for the following declared purposes only:

1. Workflow visibility for admins (last seen, active/inactive status)
2. Attendance/activity review
3. Expense operations correlation
4. Administrative reporting

**Controls preventing purpose creep:**

- Data is stored in a separate schema from expense financial data.
- No cross-feature linkage that exposes activity data to non-admin roles.
- No advertising, profiling, or third-party sharing.
- Feature key prevents activation outside this feature.

**Risk:** Without a clear organisational policy, admins may informally use activity data for disciplinary decisions beyond the stated purpose.  
**Mitigation:** Admin disclaimer in enablement dialog; admin privacy card in UI; policy template in privacy notice document.

---

## 5. User notice and acknowledgement

| Control | Implemented? | Notes |
|---------|-------------|-------|
| Blocking notice modal before tracking starts | ✅ Yes | `UserActivityNoticeGate.tsx` — non-dismissible dialog |
| Notice explains what IS tracked | ✅ Yes | Session time, last seen, session count, expenses |
| Notice explains what is NOT tracked | ✅ Yes | Keystrokes, screenshots, other apps, location, etc. |
| Acknowledgement stored server-side | ✅ Yes | `user_activity_notice_acknowledgements` table |
| Tracking blocked until acknowledged | ✅ Yes | `noticeAcknowledged` prop on tracker |
| Notice versioning (re-acknowledgement on material change) | ✅ Yes | `NOTICE_VERSION = "user_activity_notice_v1"` — increment to force re-ack |
| Access/correction/deletion info in notice | ✅ Yes | Added in DPDP compliance pass |
| Retention period mentioned in notice | ✅ Yes | Added in DPDP compliance pass |

---

## 6. Access controls

| Control | Status |
|---------|--------|
| RLS on all activity tables | ✅ Enabled |
| Reads via SECURITY DEFINER RPCs | ✅ Yes |
| Writes via SECURITY DEFINER RPCs | ✅ Yes |
| Feature flag gate (per-org, off by default) | ✅ Yes |
| Admin-only UI route | ✅ Yes (`/admin/user-activity`) |
| Master admin enablement disclaimer | ✅ Yes |
| No cross-org data exposure | ✅ Validated in RPC WHERE clauses |

---

## 7. Risks

| # | Risk | Likelihood | Severity | Overall |
|---|------|-----------|----------|---------|
| R1 | Employee feels secretly monitored despite notice | Medium | High | High |
| R2 | Admin uses activity data for disciplinary action without HR policy | Medium | High | High |
| R3 | Over-retention — data kept longer than necessary | Medium | Medium | Medium |
| R4 | Cross-org data exposure via RPC misconfiguration | Low | High | Medium |
| R5 | Data breach exposing activity records | Low | High | Medium |
| R6 | Inaccurate interpretation of activity data (e.g. short session = absent) | High | Medium | Medium |
| R7 | Notice not actually seen (if skipped by error or future regression) | Low | High | Medium |
| R8 | Audit log missing — enable/disable events not recorded | Medium | Medium | Medium |
| R9 | Retention cleanup not run — data accumulates indefinitely | Medium | Low | Low |
| R10 | Notice version not incremented when notice copy changes materially | Low | Medium | Low |

---

## 8. Mitigations

| Risk | Mitigation |
|------|-----------|
| R1 — Feeling monitored | User notice modal before tracking starts. Privacy card on admin page. Privacy notice template for client orgs. |
| R2 — Disciplinary use | Admin disclaimer in enablement dialog mentioning lawful basis and HR policy. Privacy notice template mentions purpose limitation. Legal review required. |
| R3 — Over-retention | Retention cleanup SQL file (10). Recommended 180-day retention period. Documented cleanup process. |
| R4 — Cross-org exposure | All RPCs include org-scoped WHERE clauses. RLS enforces org isolation. Reviewed in SQL files. |
| R5 — Data breach | Standard Supabase RLS + SECURITY DEFINER pattern. Breach runbook documented. |
| R6 — Misinterpretation | Privacy card in admin UI explains data is visible app time only. Training/policy responsibility lies with client org. |
| R7 — Notice skipped | `isLoading` check prevents tracker from starting before acknowledgement check completes. Blocking modal cannot be dismissed without clicking "I understand". Acknowledgement stored server-side. |
| R8 — Audit log missing | Audit log SQL (file 13) + frontend call after saveOrganizationFeature. TODO documented if SQL not yet applied. |
| R9 — Retention cleanup not run | Documented in this DPIA and data inventory. Organisation responsibility. |
| R10 — Notice version | `NOTICE_VERSION` constant in both frontend and SQL. Increment string to force re-ack. Documented. |

---

## 9. Residual risks

After mitigations, the following residual risks remain:

| Risk | Residual notes |
|------|---------------|
| R1 (employee feels monitored) | Cannot be fully eliminated by technical means. Requires clear internal communication by the enabling organisation. |
| R2 (disciplinary use) | Requires the enabling organisation to adopt a documented HR policy. PesoWise cannot enforce this. |
| R6 (misinterpretation) | Admin UX includes explanatory copy, but human interpretation risk remains. Requires org-level guidance. |
| R5 (data breach) | Residual risk inherent to any cloud data system; reduced by Supabase RLS and minimal data collection. |

**Overall residual risk:** Low-to-medium with mitigations in place, provided the enabling organisation adopts appropriate HR/legal policy.

---

## 10. Final go/no-go checklist

Complete all items before merging to main and enabling for any production organisation.

### Technical (Engineering)
- [x] Tracker does not start before acknowledgement
- [x] Notice explains what is tracked and what is not
- [x] Acknowledgement stored server-side
- [x] RLS on all activity tables
- [x] SECURITY DEFINER RPCs
- [x] Feature flag off by default
- [x] Admin enablement disclaimer
- [x] Retention cleanup SQL available
- [x] Access/export SQL available
- [x] Erasure/deletion SQL available
- [x] Breach runbook documented
- [x] Data inventory documented
- [x] Audit log SQL created (pending DB run)
- [x] DPDP compliance controls implemented

### Legal / Business (Organisation)
- [ ] Legal counsel reviewed this DPIA
- [ ] Legal counsel reviewed the privacy notice template
- [ ] Organisation adopted privacy notice into HR/internal policy
- [ ] Lawful basis for processing confirmed (legitimate interest / employment / contract / other)
- [ ] Grievance / contact email operational
- [ ] Retention period decided and documented
- [ ] Breach notification process and owner named
- [ ] One-org pilot tested before full rollout
- [ ] Client onboarding documentation updated

---

## 11. Compliance wording

> **DPDP compliance controls implemented — legal review required before production rollout.**  
> This feature must not be represented as legally DPDP compliant until reviewed by qualified legal counsel and adopted into the enabling organisation's policy framework.
