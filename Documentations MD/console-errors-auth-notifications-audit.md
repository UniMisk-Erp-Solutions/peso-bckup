# Console errors audit: auth 403, notification_settings 400, GoTrue warning, dialog accessibility

**ID:** DOC-149 · **Last updated:** 2026-10-21 · **Status:** in progress (ported to `fix/patidar-users-console-production` from current main; migration applied to Production 2026-10-21) · **Original branch:** `fix/console-auth-notification-errors` (local-only)

## 1) Classification

| Message | Source | Severity | Root cause (proven) | Fix? |
|---|---|---|---|---|
| `GET /auth/v1/user` 403 | APP + BACKEND | medium | GoTrue answers 403 `session_not_found`: the session row no longer exists. Cause: explicit Sign out used the **global** scope (ends every session of the user on every device). The client did not classify the 403 as an invalid session, so it never recovered. | **Yes** |
| `profiles?select=notification_settings` 400 (repeated) | APP + SCHEMA | medium | `profiles.notification_settings` **does not exist in Production** (no migration ever added it; generated types agree). Three components each fetched it on every mount; nothing latched the 400. | **Yes** |
| Multiple GoTrueClient instances | APP architecture (benign) | low | auth-js 2.72 warns for **any** second client. The bundle holds exactly two with distinct storage keys. | No (documented, tested) |
| Setup/Cleanup dashboard notification subscription | APP | low | The Dashboard effect depended on `userRole`, which resolves after the user id, so every load rebuilt the channel; reconnects also leaked the previous channel's cleanup. | **Yes** |
| Missing `Description` / `aria-describedby` | APP accessibility | low | 7 dialogs/sheets had neither. | **Yes** |
| `Unchecked runtime.lastError ... message port closed` | EXTENSION | none | Chrome extension messaging. Not emitted by the app. | No |
| `Node cannot be found in the current page` | EXTENSION | none | Extension content script. | No |
| Grammarly.js | EXTENSION | none | Injected by the Grammarly extension. | No |

The only occurrences of those strings in `dist/` are inside the app's own `monitoringClassify` filter, which recognises them as third-party noise so it can ignore them. Nothing in `src/`, `public/` or `index.html` emits them.

## 2) auth 403: evidence and cause
- GoTrue log, 96 h: `/user` 2,317 x 200, **3 x 403 session_not_found**; `/logout` 3 x 403 session_not_found; `/token` 20 x 400 `refresh_token_not_found`. All 403s today: 09:47, 10:02, 11:54, 12:27 UTC. At 11:54 there were **five `/logout` 403s in six seconds** (repeated Sign out clicks against a dead session).
- Production `auth.sessions`: 879 sessions; **153 users have more than one**, one has 83 (shared logins). `auth.audit_log_entries` (4 days): 126 logins, 62 logouts, 894 token revocations. A global sign-out by one device deletes the others' sessions, whose access tokens stay valid until expiry, so `/user` returns 403 and the refresh returns `refresh_token_not_found`.
- Classification: **F (session revoked server-side)**, mechanism = global sign-out; not an expired token, wrong key, stale project or a client race. No tokens or JWTs were read or printed.
- Gap: `isInvalidAuthSessionError` only knew "refresh token" messages and AuthApiError **401**. A 403 `session_not_found` was ignored, so the app never cleaned up.
- Fix (`authSession.ts`, `AuthContext.tsx`): recognise `session_not_found`, `refresh_token_not_found`, `refresh_token_already_used`; recovery stays single-shot (one local sign-out, one "session expired" event, latch); explicit Sign out is **local scope** and single-flight, and always clears this origin's auth keys. "Sign out everywhere" is not offered by the UI today; add it as an explicit option if wanted.
- Payload sequence: PostgREST data calls do not check the session, so they kept working until the JWT expired; only auth endpoints returned 403.

## 3) Supabase clients
Two in the browser bundle: primary (`integrations/supabase/client.ts`, default key `sb-pesowise-supabase-auth-token`, persistSession + autoRefreshToken) and maintenance Cloud (`integrations/maintenance-cloud/client.ts`, explicit key `pw-maintenance-cloud-auth`). Keys are distinct; `clearLocalAuthStorage` removes only the primary key (and `-` suffixed siblings). Verdict: benign library warning; no auth redesign. (The read-only maintenance status fetch could use plain `fetch` to avoid the second instance for ordinary visitors; deliberately not done because that module is the fail-open maintenance path.)

## 4) notification_settings
- Production `information_schema`: 17 `profiles` columns, none named `notification_settings`; Kong shows 6 x 400 in 24 h. Class **A: column missing**.
- Decision: **server-backed** (preferences should follow the account; the pages already tried to). Migration `20261027100000_profiles_notification_settings_v1.sql`: `jsonb NOT NULL DEFAULT {popup:true, sound:true, desktop:false}`, object CHECK, no backfill, no policy change (existing "Users can update their own profile" governs writes), `NOTIFY pgrst`.
- Code: `lib/notificationSettings.ts` + `hooks/useNotificationSettings.ts` = one shared load per user (in-flight de-dupe + cache), a missing-column 400 is latched for the page load (so deploying before the migration is safe, with no retry loop), browser copy as fallback. Settings page, Notification Settings page and the realtime manager all use it (previously the manager read only localStorage and defaulted desktop to **on**; now all agree on off).
- Bug found on the way: the realtime handlers closed over the first render's preferences; they now read a ref.

## 5) Subscription lifecycle
`useNotificationManager` (`notification-popups-<user>-<org>`), `useUnreadNotifications` (`unread-notifications-count-<user>`) and the Dashboard (`dashboard-notifications-<user>`) each own one channel by design (three listeners on the same table, not duplicates of one). Dashboard fixed: effect keyed by (user, organization); cashier return-request channel is its own effect; channel kept in a ref so a reconnect can never leak. Hook tests prove one channel per user, no rebuild on re-render, removal on unmount/user change.

## 6) Relation to expense/draft bugs
`notification_settings` 400, dialog warning, extension messages, GoTrue warning: **unrelated** to expense persistence. The 403/refresh failures **are relevant**: a session revoked between draft resolution and submit makes the submit fail; with DOC-148 the retry carries the same logical id (tested, one row, one audit trail). Reports are unaffected.

## 7) Tests
`authRevokedSession`, `supabaseClientIdentity`, `notificationSettings`, `notificationSubscriptions`, `dialogAccessibility`, `authFailureDuringSubmit`; DB: `supabase/tests/console_audit/notification_settings_test.sh`.

## Revision log
| Date | Rev | Change | By |
|------|-----|--------|----|
| 2026-10-26 | 1.0 | Audit and local fixes. Migration not applied to Production. | Claude Code |
