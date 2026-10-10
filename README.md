# Learner Attendance API

This backend stores learners, attendance records, audit logs, and user accounts in MySQL. It also provides a protected SMS endpoint for a Philippine SMS provider.

## Setup

1. Install Node.js 20+.
2. Create a Supabase project and copy the **Transaction pooler** connection string from Connect.
3. Run `schema.sql` in the Supabase SQL Editor.
4. Copy `.env.example` to `.env` and set `DATABASE_URL`, a strong `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SMS_CLIENT_TOKEN`, and SMS provider values.
5. Run `npm install`.
6. Create an administrator: `npm run setup-admin -- admin@example.com "a-long-password"`.
7. Start the API: `npm run dev`.

The API starts on `http://localhost:3000`. It now uses Supabase PostgreSQL through the `pg` driver and keeps the existing `/api/auth/login`, `/api/learners`, `/api/attendance`, and `/api/sms/send` routes.

Google sign-in is verified through Supabase Auth and then matched against an existing email in `public.users`. Only provisioned emails receive an application role. Configure the Google provider in Supabase Auth and Google Cloud before using `/api/auth/supabase`.

## Enable Google sign-in

1. In Google Cloud, create/use a Web OAuth client. Its client ID must match the ID configured in `frontend/app.js`.
2. In Supabase, open Authentication → Sign In / Providers → Google, enable it, and enter the Google OAuth client ID and client secret.
3. Add the Supabase callback URL shown in the Google provider settings to the OAuth client's authorized redirect URIs. Add the GitHub Pages origin (`https://quilatanramcie798-art.github.io`) and local development origins to its authorized JavaScript origins.
4. In Supabase Authentication URL Configuration, allow the app redirect URL(s), including `https://quilatanramcie798-art.github.io/prototype/` and the local URL used for development.
5. Copy the Supabase **publishable** key from Project Settings → API Keys. Set it as `SUPABASE_PUBLISHABLE_KEY` in the backend `.env` and Render environment. It may also be placed in `window.SUPABASE_PUBLISHABLE_KEY` in `frontend/index.html`; never use a secret/service-role key in the browser.
6. Create the authorized user's matching email and role in `public.users` (for example, use `npm run setup-admin -- admin@example.com "a-strong-password"` for the first admin). The Google account email must match this row; otherwise the backend returns 403.

For the current frontend SMS flow, set the Settings tab to `http://localhost:3000/api/sms/send` and enter the same value as `SMS_CLIENT_TOKEN`. Configure `SMS_API_URL`, `SMS_API_KEY`, and `SMS_SENDER_ID` for your actual Philippine SMS provider. The simulation option remains available for testing, but real backend SMS is now the default.
