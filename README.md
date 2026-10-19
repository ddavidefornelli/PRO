# prune

An authenticated daily planning desktop app built with **Rust, Tauri 2, and Supabase**, following [SPEC.md](SPEC.md). macOS and Windows are the supported desktop targets.

**Sign-in requires internet; planner actions use a persistent local queue.** After loading your account, tasks and timers update immediately from a cached snapshot and sync to Supabase in the background. There is no SQLite database or old-data import. Supabase remains authoritative across devices.

## Getting started

Install Node.js 22.12+ (or current LTS), a stable Rust toolchain, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

1. Set up a fresh Supabase project using [supabase/README.md](supabase/README.md). Apply **all migrations in order** (currently eight), enable email Auth, and configure the email template to show `{{ .Token }}`. Anonymous sign-in is not used.
2. Set the public desktop configuration in the shell that launches/builds prune:

   ```sh
   # macOS / Unix shell
   export PRO_SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
   export PRO_SUPABASE_ANON_KEY="YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY"
   npm ci
   npm run desktop
   ```

   ```powershell
   # Windows PowerShell
   $env:PRO_SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
   $env:PRO_SUPABASE_ANON_KEY = "YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY"
   npm ci
   npm run desktop
   ```

3. Enter your email, request a code, and enter the code from your inbox. The first sign-in creates an account. Use the same account on another device to access the same planner.

The URL and public key may be embedded at **Rust compile time** using the same environment variables. Runtime environment values override compiled defaults. This lets packaged apps work without terminal configuration. Rust does not automatically load `.env` files. Never build/distribute with a service-role key, `sb_secret_` key, or OpenAI key. Public-key validation rejects privileged keys at runtime, but cannot undo accidentally embedding a secret in an artifact.

`npm run dev` serves a browser preview only. Authentication and cloud IPC require the desktop runtime. Production CSP does not allow arbitrary webview network requests; Rust performs authenticated requests.

## Authentication and storage

- Email one-time-code sign-in; no passwords or browser/deep-link callback required.
- The refresh token is stored in **macOS Keychain / Windows Credential Manager** using native Security Framework operations on macOS and `keyring` on Windows. The access token stays in Rust memory. Tokens never go into webview localStorage, frontend responses, logs, or planner tables.
- A single desktop instance runs at a time. Launching prune again brings the existing window forward instead of opening another credential-store session.
- The refresh token is read once at startup, then kept in Rust memory. Refresh is serialized, uses the in-memory token, and writes to the OS store only when the token changes. Restarting restores the saved session (network access is required). Credential-store failures have no plaintext fallback.
- Open the top-right **Profile** icon to see your stats, with the account email aligned to the right of the page heading. The red **Sign out** button is at the bottom of the stats page, not in the planner header. Pause a running focus timer before opening the profile. Unsynced changes still require confirmation.
- Sign-out removes local credentials even if remote logout is unavailable. Remote logout is best-effort; an already-issued access token may remain valid until expiry.
- Account changes reload the webview to discard the old account's views, in-memory data, and polling timers.
- Supabase row-level security isolates account reads. Direct client table writes are denied. Planner commands run through a transactional RPC deriving identity from `auth.uid()`, not a client-supplied user ID.

### macOS Keychain prompts and release signing

Memory-only login cannot survive a quit or reboot. prune deliberately retains secure OS credential storage rather than putting reusable login tokens in an app-data file. Startup shows an accessible animated ring (static with reduced motion) while restoring the session. Credential initialization is deferred until the webview requests authentication and runs on a blocking worker, including construction of the blocking HTTP client. Native permission dialogs do not block window setup. After 30 seconds, the spinner becomes a waiting/retry screen; a late successful response still opens the planner automatically. Failed initialization is retryable rather than permanently cached.

On macOS, direct SecItem updates/deletion avoid the legacy backend's extra secret reads before writes and sign-out. Existing service/account identifiers are preserved, so saved logins remain compatible. The token is still read only once per process and rotated tokens are still saved securely. This reduces unnecessary Keychain access; it does not bypass Keychain permissions.

Development rebuilds and unsigned/ad-hoc builds may trigger Keychain permission prompts as executable identity changes. Use `npm run desktop:mac:check` to check your installed **Developer ID Application** certificate and public configuration, then `npm run desktop:mac:release` to build a consistently signed `.app`. The release command enables bundling only for that build, refuses unsigned fallback, and verifies the app's team and identifier. Set `PRO_NOTARY_PROFILE` to also notarize and staple it before distribution. See **[macOS signing setup](docs/macos-signing.md)** for the required Apple certificate/private key, notarization setup, installation, and Keychain transition steps. These credentials are not included in the repository.

Quit other prune instances and launch the signed app from `/Applications`; `npm run desktop` remains a development workflow. The first signed launch may still need approval for the existing Keychain item. Signing does not bypass existing permissions, and a locked Keychain can still require interaction.

Before release, manually test on macOS with the actual signed app:

1. Sign in, quit, and relaunch; confirm the same account is restored without another email code.
2. Launch the app a second time; confirm only the original window is shown.
3. Leave it running through access-token expiry; confirm refresh works without repeated password prompts.
4. Restart the computer and verify session restoration, then install a newer build signed with the same identity and repeat.
5. Sign out and relaunch; confirm the account is no longer signed in. Cancel/deny a Keychain prompt and confirm a credential error is shown rather than a plaintext fallback.

Automated credential-store fixtures do not validate macOS prompts or signing trust.

### Fresh start, not an import

Old `pro.sqlite3` files are **not read, migrated, or deleted**. Their contents do not appear in the cloud planner. Keep backups of them if you need the old data; this version has no import tool. A new Supabase account starts empty.

### File paths, not uploads

Attachments store a filename and absolute local path in Supabase. File contents are never uploaded. A path from another Mac/PC may be missing or refer to a different file; reattach it on that device. prune confirms local-file opening, rejects explicit network/device paths on Windows, and only opens supported document/image types. Scripts, executables, shortcuts, and executable-bit files on macOS are rejected. Documents can still contain malicious content; open only trusted files.

Absolute paths and link metadata can themselves contain sensitive information. They are cloud-stored account data, even though they are excluded from AI inputs.

## Planner behavior

- Up to three tasks per day, with 1–60 minute estimates.
- Select the most important task before beginning; finish it before starting other tasks.
- One active task per account, across devices.
- Pause/resume with stop reasons; edit titles and unstarted estimates.
- Tomorrow is available from the start; plan ahead without completing today's tasks first.
- Yearly completion calendar, grouped by actual completion date.
- Profile stats show all-time completions, active days, current/best streaks, today/week/month completions, and tracked focus time for today's tasks. Weeks run Monday–Sunday. A current streak can end yesterday while today is still in progress. Focus time is explicitly scoped to today's planned tasks, not an all-time total; local pending completions appear immediately.
- Periodic reload and focus/wake refresh show server state; this is polling, not realtime subscriptions.
- Today and Focus fit the desktop window without page scrolling. Long titles stay compact (full text is available on hover/edit), and resource collections open in a separate bounded dialog. Overview remains scrollable.

The database takes a per-account row lock for every planner transaction. Unique slot constraints enforce the three-task limit, a partial unique index enforces one active task, and pause/reason writes commit atomically. These rules do not depend on frontend button state.

### Time and network semantics

The device supplies its IANA timezone; Postgres validates it. Normal online operations use server time; queued operations use the bounded captured action time described below. Sleep and time with prune closed continue to count; paused time is excluded. A previous day's active task remains accessible until completed. Completion and stop dates retain the action's timezone and do not change after timezone travel.

### Local queue and background sync

- Task creation, titles, estimates, priorities, links/removals, timer actions, and stop reasons are recorded in an account/project-specific **webview localStorage outbox** before success is shown. The acknowledged snapshot and pending actions share one atomic storage value. Storage failures reject the action rather than falsely claiming it was saved.
- Actions replay in order. Stable UUIDs let later actions reference newly created tasks/links before they reach Supabase. A server-side receipt commits atomically with each mutation, so a lost response or restart can safely retry the same request without duplicating the write. Receipts live until account deletion; do not expire them without a queue-expiry protocol.
- Network/server failures retry automatically with exponential backoff (up to 60 seconds) and on reconnect/focus/poll. Routine sync status and manual sync controls are not shown; only rejected changes requiring a user decision display a notice. Web Locks coordinate multiple windows without holding the storage lock during HTTP requests.
- A definitive server rejection stops the queue and preserves its contents. **Discard rejected changes** explicitly discards all remaining dependent local changes, never already-synced changes. Ambiguous requests cannot be discarded while they may still have committed. Account revisions detect cross-device edits, including changes within the same second; an additional timestamp check rejects events older than the latest acknowledged planner event.
- **Local pause/completion is immediate; other devices do not see it until sync.** Queued timer timestamps and completion dates use the captured action time and timezone, not delayed upload time. The server rejects uncommitted events older than 30 days or more than two minutes in the future. Normal nonqueued operations still use server time. Device clock accuracy therefore matters.
- The cache contains only the last fetched planning days and active task, plus local changes—not the entire account history. Local dates advance after midnight; uncached cross-device tasks may cause a conflict on reconnect.
- Pending actions survive restarts/sign-out and only sync after signing into the **same Supabase project and immutable user ID**. A restart still requires online authentication before the cached planner is accessible. Sign-out warns about pending changes and keeps the cache; it does not erase device data.
- Planner cache/outbox contents (including titles, reasons, links and paths) are **unencrypted app data**, not OS-keychain secrets. Refresh tokens remain in native credential storage. Clearing app storage, uninstalling, or losing the device can lose unsynced changes. Do not clear app data with pending work.
- File attachment/opening and AI settings/generation remain online-only; file operations require the queue to be synced first. Native file attachment itself is not automatically retried.

**Deploy `supabase/migrations/20261017000300_local_queue.sql` before relying on sync.** The client checks the queue protocol before sending retryable writes and will not send them to an older backend that ignores idempotency keys.

## Weekly AI

AI is optional and disabled by default per account and globally. See [backend setup](supabase/README.md) to deploy the function, configure its OpenAI secret, enable the global allowance, and schedule cleanup. Desktop users do not need provider credentials.

- Scheduled reviews become due **Sunday at 4:00 p.m. local time** and cover Monday through the generation snapshot; later Sunday activity is not included. prune checks on launch/once per minute while signed in. Missed weeks collapse to the latest due week. No server scheduler generates reviews while every client is closed.
- Overview shows a live countdown to the next Sunday review and a weekly progress indicator. Reviews generate automatically after opt-in; there are no on-demand or generation-retry buttons. Failed requests retry automatically under server-enforced backoff. Keep development-only unlimited allowances disabled in production.
- Summarizes the week, identifies evidence-linked themes in stop reasons, and suggests 1–3 small improvements. Task value is not scored. AI never edits planner state.
- The Edge Function authenticates the email account, loads activity and consent from Postgres, reserves a quota slot, calls a fixed OpenAI model, validates output, and saves the review and source snapshot in Supabase.
- Clients send **only the timezone**, not arbitrary prompts, user IDs, models, or activity. Resource metadata and contents are excluded. Sensitive text directly entered in titles/reasons is still processed.
- Up to 200 recent stops, 256 task contexts, 16,000 combined title/reason characters. Oversized inputs fail before a provider call rather than silently truncating text. Omitted stops are disclosed.
- At most three attempted generations per weekly slot, at least an hour apart, plus atomic shared daily/monthly caps. Limits apply to explicit retries too. These are attempt bounds, not a guaranteed dollar billing cap.
- Successful reviews are immutable. Overview shows the latest 52 saved reviews. Reviews and source snapshots are retained in the account until account/admin deletion; the seven-day operational retry cache is separate.
- Disabling AI prevents future reservations and discards in-flight results if consent changes. Already-transmitted provider data cannot be recalled. `store: false` does not imply zero provider retention.

## Architecture

```text
src/auth.ts                          Email-code gate; no session tokens
src/api.ts                           Typed IPC client and queue integration
src/local-queue.ts                   Persistent snapshot/outbox, projection, ordered retries
src/main.ts / weekly-review.ts       Planner and Overview UI
src/dom.ts / errors.ts              Shared UI primitives and error handling
src/planner.ts / time.ts            Reused planner bounds, completion and date/timer logic
src-tauri/src/cloud.rs               Auth, OS credentials, Supabase HTTP adapter
src-tauri/src/desktop.rs             Async Tauri commands, native file dialogs/opening
src-tauri/src/resources.rs           Native resource revalidation
supabase/migrations/                 Planner schema, RLS, transactional RPC, AI quotas
supabase/functions/weekly-review/    Authenticated server-owned AI generation
```

Dependency flow: **UI → native Rust IPC → authenticated Supabase RPC → Postgres**. AI additionally goes through the Edge Function. Only public configuration ships in the app; privileged credentials remain server-side.

## Checks

```sh
npm ci
npx playwright install chromium webkit   # Once per machine / browser-version update
npm test                    # All unit, SQL/Edge, native and two-browser workflow tests
npm run test:all             # All tests + frontend/backend type checks, build, fmt, clippy
npm run test:stress          # Repeat every browser scenario three times, without retries
npm run test:coverage        # Coverage for modules exercised by the Node/SQL suites

# Focused runs
npm run test:native
npm run test:backend
npm run test:calendar
npm run test:queue
npm run test:e2e
```

See [TESTING.md](TESTING.md) for coverage, regression findings and limitations, and the [beta readiness audit](docs/beta-readiness.md) for the latest verification and prioritized release checklist. Tests use the actual migrations and browser UI but fixture native IPC, authentication and provider transport. They do not deploy a project, access the real keychain, send email, open user files or issue paid API requests. PGlite tests are not multi-connection load tests. Hosted email delivery, native credential prompts, cross-device concurrent actions, and Windows/macOS file opening require manual release smoke tests.

A signed macOS `.app` build with optional notarization is available via `npm run desktop:mac:release`; it requires your Apple Developer identity. DMG/Windows installer signing, a secure updater, account-deletion UI, white noise, and carrying/dropping unfinished tasks are not implemented. Default installer bundling remains disabled.
