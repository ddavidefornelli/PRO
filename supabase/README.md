# prune — Supabase backend

Supabase owns **authoritative account data**; the desktop also persists an unencrypted local planner snapshot and write queue. Email-code Auth identifies users; Postgres stores tasks, timer state, stop reasons, resource metadata, AI settings and saved reviews. Attachments remain paths, not uploaded file contents. SQLite is no longer used and old desktop files are untouched.

**Status:** implemented and locally tested; not remotely deployed by these changes. No Supabase project or secrets are included. Use a fresh project and perform the hosted smoke tests below before distributing the app.

## 1. Configure Auth

Create a Supabase project and select an appropriate data region.

In the hosted **Authentication** settings:

- Enable the email provider and new-user signups.
- Enable email confirmation; disable anonymous sign-in and unused providers.
- Use a numeric email OTP (the local configuration uses 6 digits and a 10-minute expiry).
- Edit the **Magic Link** email template to display `{{ .Token }}`, for example:

  ```html
  <h2>Your prune sign-in code</h2>
  <p>{{ .Token }}</p>
  <p>Enter this code in prune. If you did not request it, ignore this email.</p>
  ```

  The app calls `/auth/v1/otp` with `create_user: true`, then `/auth/v1/verify` with `type: "email"`. It does not use a magic-link redirect/deep link. Confirm the initial signup email also presents a usable code in your hosted configuration.
- Configure production SMTP and email delivery limits. Supabase's default mail service is restricted and is not a production delivery solution.
- Configure Auth/signup/endpoint rate limits and monitoring. Consider CAPTCHA for public signup; the current desktop UI does **not** implement CAPTCHA, so enabling a mandatory challenge requires an additional client flow.

`config.toml` configures the **local** stack; it does not apply these hosted dashboard settings automatically.

### Troubleshooting sign-in email failures

An Auth response such as:

```json
{"code":500,"error_code":"unexpected_failure","msg":"Error sending confirmation email"}
```

means the request reached Supabase, but its email-delivery step failed. `Error sending magic link email` is the equivalent failure for an existing account. Neither means the desktop is offline. A failed signup email can roll back account creation, so the address may not yet appear under Auth users. Reloading prune, changing the desktop public key, or reapplying planner migrations does not repair SMTP.

prune recognizes these fixed messages and displays an `email_delivery` error with the HTTP status and, when available, Supabase's request ID. Unknown Auth errors remain sanitized; raw SMTP responses, tokens and account details are never displayed or logged by prune.

1. Open the hosted project's **Auth logs** in Supabase Logs Explorer. Find the failed `/otp` request by its request ID and timestamp. The internal error distinguishes SMTP authentication, sender rejection, connection/TLS, quota/account restrictions, and email-hook failures. The generic `unexpected_failure` code alone does **not** distinguish them.
2. Check **Authentication → Email → SMTP settings** against the provider's current SMTP configuration. Use the SMTP username and SMTP credential, not the account login password or an unrelated REST API key. For Brevo, the usual endpoint is `smtp-relay.brevo.com`, port **587** with STARTTLS; copy the SMTP login and generate an **SMTP key** from Brevo's SMTP settings.
3. Confirm the exact **sender email** is authorized by the provider, the transactional account is active, and sending limits have not been reached. Check Brevo's transactional logs if it accepted the message. For production, use a domain you control with the provider's required SPF/DKIM setup rather than relying on a Gmail From address.
4. If a **Send Email hook** is enabled, investigate that hook too; configuring SMTP will not repair a failing hook that replaces delivery.
5. After fixing delivery, request one new code, respecting the hosted resend interval. Check both the **Confirm signup** and **Magic Link** templates for `{{ .Token }}` so first-time and returning users can enter a numeric code. Hosted OTP length may differ from the local configuration; prune accepts 6–10 digits.

A **429** is a rate limit, not the same failure. Wait and inspect hosted Auth/provider limits instead of repeatedly requesting codes. Do not disable email confirmation, expose privileged keys in the app, or reset the database to work around email delivery. Local fixture tests do not verify real hosted SMTP; run the hosted signup/returning-user smoke tests after configuration changes.

## Development review limits

Local database seeding enables unlimited AI review attempts and removes request
cooldowns. It does not enable AI itself, bypass user consent, or permit concurrent
duplicate generation. Production migrations keep limits enabled by default.

For an existing development database, apply
`20261018000300_development_review_limits.sql`, then run as a database administrator:

```sql
update public.ai_controls set development_unlimited = true where id;
```

Do not enable this flag in production. Set it back to `false` to restore app quotas.
OpenAI or Supabase infrastructure limits are independent of this flag.

## 2. Apply database migrations

With the Supabase CLI installed (or using `npx supabase`):

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Apply all eight migrations in order:

1. `20261017000100_weekly_reviews.sql`: private AI controls, quota state, leases and service-only RPCs; AI defaults off.
2. `20261017000200_cloud_planner.sql`: authenticated planner tables/RLS, atomic planner RPC, server-owned activity loading and durable AI reviews.
3. `20261017000300_local_queue.sql`: private executor, authenticated queue-protocol check, bounded action-time replay, stable entity IDs, conflict checks, and atomic per-user idempotency receipts. **Required before the desktop queue can sync.** This migration can also be applied incrementally to a project already using the first two; no reset is required.

4. `20261017000400_review_lease_validation.sql`: rejects null/mismatched AI lease tokens and missing consent revisions when persisting a review. Apply this incremental hardening migration to existing deployments too; it requires no reset.
5. `20261018000100_review_previews.sql`: adds consent-gated current-week previews with independent per-account quotas and shared global budgets.
6. `20261018000200_filter_placeholder_review_stops.sql`: excludes placeholder stop reasons from AI input without deleting the original logs.
7. `20261018000300_development_review_limits.sql`: adds a development-only unlimited mode, **off by default in production**. Do not enable it on the hosted beta project.
8. `20261018000400_sunday_review_schedule.sql`: schedules reviews for Sunday at 4:00 p.m. local time with timezone/DST-aware catch-up.

They are designed for a **fresh application database**. They do not import/delete SQLite data. Review changes before applying to an existing/shared project. Do not reset an existing remote database unless its contents are intentionally disposable.

### Troubleshooting queued sync

Older desktop builds display the same migration warning for any failed queue-protocol check, including network outages. Current builds distinguish safe native network/server errors from unsupported protocol/dispatcher errors internally, but routine sync status is no longer displayed in the planner. Retries run automatically; only definitively rejected changes requiring a user decision display a notice. Pending changes remain on this device. Do not clear app storage or reset the database.

To check the deployed schema, run this **read-only** query in your project's Supabase SQL Editor:

```sql
select coalesce(
  pg_get_functiondef(to_regprocedure('public.planner_call(text,jsonb,text)'))
    like '%queue_protocol%', false
) as queue_protocol_installed;
```

If false, apply the unapplied migrations in order, including `20261017000300_local_queue.sql` and `20261017000400_review_lease_validation.sql`. Use `supabase db push` on the linked project, or run the complete pending migration files in SQL Editor. Do not rerun already-applied migrations or use `db reset` on the hosted project. If true, confirm the desktop URL points to this same project, use the current desktop build, and investigate the connection/session error. After correcting the problem, the existing outbox retries automatically (within 60 seconds or on reconnect). No manual sync button is needed.

### Tables and permissions

| Tables | Purpose | Client access |
| --- | --- | --- |
| `planner_accounts` | AI opt-in, consent notice/version and revision | Owner SELECT only |
| `planner_tasks` | Outcomes, priorities, planning dates, timer state | Owner SELECT only |
| `planner_stops` | Written reasons and server timestamp/local date | Owner SELECT only |
| `planner_resources` | Filename/label, URL or absolute path | Owner SELECT only |
| `planner_reviews` | Immutable review plus source snapshot | Owner SELECT only |
| `planner_receipts` | Queue request fingerprint and result, committed atomically with each write | No client table access |
| `ai_controls`, `ai_usage`, `ai_review_requests` | Global controls, quotas, temporary AI state | No client table access |

All tables have RLS. Client table mutations are denied; authenticated users execute `planner_call(p_action, p_args, p_timezone)`. The function derives identity from `auth.uid()`, rejects anonymous identities, locks the user's account row and performs validation/writes in one transaction. Unique day slots and a partial unique active-task index additionally enforce database invariants. Nonqueued dates/timer timestamps use Postgres time. Queued commands carry `_requestId` and `_at`; the wrapper validates an event time within the past 30 days / next two minutes and injects private executor arguments itself. Client-supplied internal arguments are stripped. Queued task/link IDs equal the request UUID so dependent actions need no remapping. All retries with the same identity must match the original action, arguments, timezone and timestamp.

The account lock serializes receipt lookup, validation, mutation and receipt insertion. A receipt is returned before revalidating age or current state, so even an old ambiguous committed action can be acknowledged safely. Receipts retain request data and full results until Auth account deletion; do not purge them casually, since an old outbox could otherwise replay twice. The private `planner_execute` function is not executable by authenticated/anonymous roles. Each planner mutation increments an account revision. The desktop captures the expected revision with each queued action, so even same-second cross-device edits stop replay rather than overwrite unseen changes. An account-level last-event timestamp also rejects older queued events. Rejected queues require explicit user resolution, not silent overwrite.

Internal helpers and AI reservation/completion functions are not executable by ordinary clients. Security-definer functions have an empty search path and explicitly qualify application objects. Only Edge server code receives the service-role key. No client-supplied user ID is trusted.

## 3. Connect the desktop

Set `PRO_SUPABASE_URL` and `PRO_SUPABASE_ANON_KEY` before launching/building the Rust application, as shown in [the root README](../README.md). Use a modern **publishable key** or legacy **anon** key, never a service-role/secret key.

These public values can be compiled into releases. Session access tokens stay in Rust memory; refresh tokens are stored in Keychain/Credential Manager. Signing in creates the cloud account lazily; the planner starts empty. There is no SQLite database; the webview persists an account/project-specific planner snapshot and outbox.

## 4. Deploy optional weekly AI

Scheduled reviews become due **Sunday at 4:00 p.m. in the device's local timezone**.
Apply `20261018000400_sunday_review_schedule.sql` to enable this schedule.
prune checks while open and catches up at the next launch if closed; there is no
background delivery while the app is closed. Reviews include Monday through the
generation snapshot, not activity logged later that Sunday. The manual preview
remains available independently. IANA timezone calculations preserve 4:00 p.m.
across daylight-saving changes.

The planner works without enabling AI. To enable it:

```sh
cp supabase/.env.example supabase/.env.local
# Edit locally: add a dedicated OpenAI project key. Never commit it.
npx supabase secrets set --env-file supabase/.env.local
npx supabase functions deploy weekly-review
```

The Edge runtime supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Only `OPENAI_API_KEY` and optional `ALLOWED_ORIGINS` need your configuration. Never copy privileged keys into Vite variables, desktop configuration, installers, Git, or chat.

Keep `verify_jwt = false` for this function. This disables the legacy gateway JWT check, **not application authentication**: the function validates every bearer token with `/auth/v1/user`, requires an email identity and rejects anonymous sessions before accessing any planner data.

The desktop sends:

```http
POST /functions/v1/weekly-review
Authorization: Bearer <signed-in user's access token>
apikey: <public project key>
Content-Type: application/json

{"timezone":"Europe/Rome"}
```

The function:

1. Authenticates the verified user.
2. Accepts only the timezone and optional boolean `preview` flag; rejects client-supplied activity, prompts, models and user IDs.
3. Loads consent and the latest Sunday-due week's activity snapshot using the service-only `planner_review_input` RPC.
4. Validates/bounds that activity and atomically reserves a paid attempt with `reserve_planner_review`.
5. Calls fixed `gpt-4.1-mini` with a server-owned prompt, `store: false`, 6,000 output tokens, 90-second timeout and no redirects.
6. Validates response sizes/schema/evidence and saves the report plus source activity in `planner_reviews` before returning. Completion requires an unexpired matching lease and unchanged AI consent revision.

An empty week returns `{ "noData": true }` without reservation/provider usage. Otherwise success is `{ "analysis": ..., "model": ..., "generatedAt": ..., "cached": false }`. Retry cache hits return `cached: true`. The desktop reloads the durable review from Postgres; it does not persist a second copy locally.

### On-demand current-week previews

Overview includes **Review this week so far**. It posts `{"timezone":"Europe/Rome","preview":true}` to the same authenticated function. The server loads Monday-through-today activity, excluding tomorrow's plan. Consent, bounded inputs, output/evidence validation and global limits still apply.

Previews use a separate service-only reservation with a three-minute lease, at least ten minutes between attempts and at most three attempts per account per UTC day. Failures count. Timezone changes do not reset these limits. They share the global daily/monthly budget but do not consume or replace the scheduled weekly slot. A consent revision change prevents an in-flight preview from completing.

The response is `{ "review": ... }` with the source snapshot and report, or `{ "noData": true }`. Previews remain visible in the current app session only, not saved review history. The database retains only one quota/lease metadata row per account; preview inputs and output are not stored there. Provider retention still applies.

Deploy migration `20261018000100_review_previews.sql`, redeploy the function and rebuild the desktop app to enable this path.

### Quotas and disable controls

Enable after reviewing limits:

```sql
update public.ai_controls
set enabled = true, daily_attempt_limit = 150, monthly_attempt_limit = 600
where id = true;
```

Emergency shutoff:

```sql
update public.ai_controls set enabled = false where id = true;
```

This blocks new reservations/cache responses, not an already-started provider request. Revoke the provider key separately if needed. Saved account reviews remain readable.

Limits are one slot per user/server UTC week, unique requested week, at most three attempts an hour apart, and shared daily/monthly ceilings. Failed/time-out attempts count and are not refunded. A three-minute lease prevents duplicate generation; stale lease tokens cannot finish a newer request. Activity changes after success do not buy another generation. Timezone changes do not create extra UTC quota slots.

**Attempt/token bounds are not a dollar billing guarantee.** Use a dedicated OpenAI project, conservative limits and billing alerts. Email accounts are stronger than anonymous identities, but attackers can still create multiple accounts and exhaust the free allowance or infrastructure resources. Add gateway rate/concurrency limits and monitor abuse; CORS is not an abuse defense.

Errors use `{ "error": { "code": "...", "message": "..." } }`:

- `400`: invalid timezone/request/activity; provider not called.
- `401`: missing/invalid/expired account session.
- `403`: AI consent missing or browser origin disallowed.
- `409`: generation already running or a successful slot has different activity.
- `410`: operational retry content expired; durable saved reviews are unaffected.
- `408` / `413` / `415`: body timeout, oversized request/response, unsupported content type.
- `429`: account allowance/backoff reached.
- `502` / `503`: invalid provider output, upstream failure, shared cap or kill switch.

Raw upstream errors, inputs and credentials are not logged/exposed by application code. Configure infrastructure logging to avoid capturing sensitive headers/bodies.

## 5. Retention and cleanup

Planner data, filenames/paths, stop reasons, and durable AI reviews/source snapshots are stored in Supabase **until account/admin deletion**. There is currently no account-deletion or review-deletion UI. Deleting the Auth user cascades their planner data and private request rows; aggregate usage counters remain. Overview returns only the latest 52 saved reviews, although older reports remain in Postgres.

Operational AI rows temporarily contain the selected activity while generating, and cache output for seven days. Source activity is cleared on success/failure or after lease expiry by cleanup. Failed/killed requests may retain activity until that cleanup runs. Quota metadata is removed after 90 days; aggregate daily counters after 90 days, monthly counters after one year. This is separate from durable account review retention.

Enable Supabase Cron and schedule once:

```sql
select cron.schedule(
  'pro-ai-retention',
  '17 3 * * *',
  $$select public.purge_weekly_review_content();$$
);
```

Check job history/alert on failures. Do not schedule duplicates on every deployment. Backups, Auth/IP logs, and OpenAI processing have separate provider retention policies. Active-database deletion does not erase backups. `store: false` is not a promise of zero OpenAI retention. Complete [the bundled privacy notice](../PRIVACY.md) and [privacy release checklist](../docs/privacy-release-checklist.md) before public distribution, including the actual provider regions, transfer safeguards, log/backup retention and manual rights/deletion workflow. `npm run privacy:check` must pass before distribution; it is not a legal-compliance certification.

## 6. Verification

```sh
npm ci
npm run test:backend
# If Deno is installed:
deno check supabase/functions/weekly-review/index.ts
```

Tests apply the actual migrations to PGlite with minimal Supabase role/Auth fixtures. They cover RLS, denied table writes, cross-account isolation, planner transitions, constraints, pause transactions, resources, consent, durable reports, quota leases, limits, safe errors and bounded/deadline reads. They use no real Auth/OpenAI credentials. PGlite serializes statements and is **not** a multi-connection concurrency/load test.

For a full local stack, install Docker/compatible runtime:

```sh
npx supabase start
npx supabase db reset   # DESTRUCTIVE to local Supabase data only
npx supabase functions serve weekly-review --env-file supabase/.env.local
```

Use `http://127.0.0.1:54321` and the local public key in a **debug** desktop build. Production builds require HTTPS. Inspect local test email in Supabase's mail viewer; no production SMTP is needed locally.

### Required hosted smoke tests

- Request and verify an email code for new and existing accounts.
- Restart prune; verify native credential restore/rotation and sign-out.
- Sign in as a different account; confirm no prior account data appears.
- Sign into one account on Mac and Windows. Race task creation, start, pause/resume and completion; verify database invariants.
- After loading the planner, disconnect the network: actions report durable local saves, pending work survives a webview reload, and pause/completion is immediate locally. Reconnect and verify ordered replay without duplicates. A native-app restart still requires online authentication; other devices do not see local timer changes until sync. Verify cross-device rejection and explicit discard preserve already-synced work.
- Verify attachment contents are never uploaded; missing/cross-device paths give a useful error and files require native confirmation.
- AI off/opt-in/revocation, no-data week, successful durable review, quota denial, invalid token and global shutoff.
- Confirm no activity/credentials appear in logs; confirm retention Cron succeeds.

Deploying, resetting remote data, issuing emails, and making paid AI requests are intentionally not done by the test suite.
