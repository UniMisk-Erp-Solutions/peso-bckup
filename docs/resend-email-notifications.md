# Resend Email Notifications Setup

This project now includes two Supabase Edge Functions:

- `send-account-created-email`
- `send-contact-lead-email`

Both functions send mail through Resend and are wired into:

- Single user creation in `src/pages/UserManagement.tsx`
- Bulk user creation in `supabase/functions/bulk-users-import/index.ts`
- Contact form submission in `src/pages/ContactPage.tsx`

## 1) Resend domain setup

Use `unimisk.com` as the only sender domain.

1. Add domain in Resend: `unimisk.com`
2. Add/verify DNS records from Resend dashboard (SPF/DKIM and suggested DMARC)
3. Confirm domain status is `verified`

Suggested sender:

- `PesoWise <no-reply@unimisk.com>`

## 2) Configure Supabase Edge Function secrets

Set only these required secrets in Supabase project:

```bash
supabase secrets set RESEND_API_KEY=your_resend_api_key
supabase secrets set EMAIL_FUNCTION_TOKEN="create_a_long_random_token"
```

Notes:

- `EMAIL_FUNCTION_TOKEN` is used as a shared bearer token for internal calls to email functions.
- If `EMAIL_FUNCTION_TOKEN` is set, callers must send `Authorization: Bearer <EMAIL_FUNCTION_TOKEN>`.
- These values are now hardcoded by default in Edge Functions:
  - Sender: `PesoWise <no-reply@unimisk.com>`
  - Sign-in URL: `https://pesowise.unimisk.com/auth`
  - Contact recipients: `mithil20056mistry@gmail.com, ranaharmin@gmail.com`
- Optional overrides (not required): `EMAIL_FROM`, `APP_SIGNIN_URL`, `CONTACT_NOTIFY_TO`

## 3) Deploy edge functions

```bash
supabase functions deploy send-account-created-email
supabase functions deploy send-contact-lead-email
supabase functions deploy bulk-users-import
```

Redeploy `bulk-users-import` because it now invokes `send-account-created-email`.

## 4) Expected behavior

### Account created email

- Dynamic recipient: newly created user's email
- Dynamic content: name, email, password
- CTA/button link: sign-in URL (`/auth`)

### Contact us email

- Static recipients from `CONTACT_NOTIFY_TO`
- Dynamic body from submitted contact fields
- Reply-to set to submitter work email when valid

## 5) Operational behavior on failures

Email send failures are logged but do not block:

- user account creation
- bulk import completion for successful rows
- contact lead insertion
