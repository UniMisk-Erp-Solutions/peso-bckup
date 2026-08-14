-- Fix GoTrue "Database error querying schema" after restoring auth.users from cloud backup.
-- GoTrue cannot scan NULL into string fields on auth.users token columns.
-- Run on self-hosted Postgres (Coolify SQL editor or psql).

BEGIN;

-- Replace NULL token/email-change fields with empty strings (required by GoTrue)
UPDATE auth.users SET confirmation_token = '' WHERE confirmation_token IS NULL;
UPDATE auth.users SET recovery_token = '' WHERE recovery_token IS NULL;
UPDATE auth.users SET email_change_token_new = '' WHERE email_change_token_new IS NULL;
UPDATE auth.users SET email_change = '' WHERE email_change IS NULL;
UPDATE auth.users SET email_change_token_current = '' WHERE email_change_token_current IS NULL;
UPDATE auth.users SET phone_change = '' WHERE phone_change IS NULL;
UPDATE auth.users SET phone_change_token = '' WHERE phone_change_token IS NULL;
UPDATE auth.users SET reauthentication_token = '' WHERE reauthentication_token IS NULL;

-- Optional: set defaults for future inserts (requires table owner; skip on hosted pooler)
-- ALTER TABLE auth.users ALTER COLUMN confirmation_token SET DEFAULT '';
-- ALTER TABLE auth.users ALTER COLUMN recovery_token SET DEFAULT '';
-- ALTER TABLE auth.users ALTER COLUMN email_change_token_new SET DEFAULT '';
-- ALTER TABLE auth.users ALTER COLUMN email_change SET DEFAULT '';
-- ALTER TABLE auth.users ALTER COLUMN email_change_token_current SET DEFAULT '';

-- Verify: should return 0 rows
SELECT id, email
FROM auth.users
WHERE confirmation_token IS NULL
   OR recovery_token IS NULL
   OR email_change_token_new IS NULL
   OR email_change IS NULL
   OR email_change_token_current IS NULL;

COMMIT;
