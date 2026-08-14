# Contact Form API Setup

The contact form submission endpoint is located at `/api/contact.ts` and handles form submissions by sending emails via Resend.

## Environment Variables Required

Add these environment variables to your Vercel project (or `.env.local` for local development):

```
RESEND_API_KEY=your_resend_api_key_here
CONTACT_TO_EMAIL=info@unimisk.com
```

## Setup Instructions

1. **Get a Resend API Key:**
   - Sign up at https://resend.com
   - Create an API key from the dashboard
   - Copy the API key

2. **Configure in Vercel:**
   - Go to your Vercel project settings
   - Navigate to "Environment Variables"
   - Add `RESEND_API_KEY` with your Resend API key
   - Add `CONTACT_TO_EMAIL` (optional, defaults to info@unimisk.com)

3. **Domain Setup (Optional):**
   - For production, configure your sending domain in Resend
   - Update the `from` email address in `/api/contact.ts` if needed

## How It Works

1. User submits the contact form on `/contact`
2. Form data is POSTed to `/api/contact`
3. The endpoint validates required fields
4. Email is sent via Resend API to the configured recipient
5. Success/error response is returned to the client

## Accessing Form Submissions

Form submissions are delivered via email to the address configured in `CONTACT_TO_EMAIL` (default: info@unimisk.com).

Each submission includes:
- Contact information (name, email, company, phone, role, team size)
- Workflow needs (approval type, balance management, multi-location, receipt requirements)
- Optional: preferred time, timezone
- Message/notes

## Fallback Behavior

If `RESEND_API_KEY` is not configured:
- The endpoint returns a success response but logs an error
- Users see a success message
- You should check logs and configure the API key for actual email delivery
- Users are advised to contact info@unimisk.com directly

## Future Enhancements

- Store submissions in a database for analytics
- Forward to Slack/webhook
- Auto-responder emails
- Integration with CRM systems
