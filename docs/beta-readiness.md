# Beta readiness audit

## Verdict

**The tested local workflows are passing; this is a candidate for a small, supervised beta, not proof of production readiness.** Finish the hosted/native release checks below before distributing a build. No production data, real credentials, inboxes, Keychain entries or paid AI APIs were accessed by this audit.

The existing suite passed before the audit. Additional beta-user scenarios reproduced gaps that it did not cover; these were fixed and now have regression tests. Existing uncommitted work was preserved.

## Changes made

| Finding | Resolution |
| --- | --- |
| Sign-in UI required exactly eight digits even though local Auth sends six and the native client supports 6–10. | Keep the boxed interface, accept all supported lengths, adapt pasted/autofilled codes and longer typing, reject incomplete codes, and reset on resend. |
| Whitespace-only task titles could be saved locally and then rejected, blocking subsequent queued work. | Validate before enqueue; keep the input editable and allow correction without a queue conflict. |
| Unsupported links, credentials in URLs, and oversized UTF-8 URLs could reach the outbox before native/SQL rejection. | Validate HTTP/HTTPS (including the literal scheme delimiter required by SQL), credentials, control/space characters and the database byte limit before saving. Native/server validation remains authoritative. |
| AI settings load/save errors were hidden when preferences were accessed through Profile. | Show errors and retry controls on the currently visible preferences surface. Failed consent saves still never trigger generation. |
| Several keyboard controls had no visible focus indicator. | Restore a global `:focus-visible` outline; verify the outcome field and estimate dial in both browsers. |
| No discoverable support contact in the interface. | Add “Any problems with the app? Contact me at: fornelli.dv@gmail.com” below the app, with an underlined `mailto:` link, including sign-in/startup failures. The desktop uses a fixed-target native command to open the default email app without needing an authenticated cloud session. An opening failure displays the address for manual contact. |
| Setup documents still said four migrations and Monday generation. | Document all eight migrations and the existing Sunday 16:00 local schedule. Keep development-only unlimited AI usage disabled in production. |

Rebuild/restart the desktop app for the new native support command; frontend hot reload alone does not install native commands.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run test:all` | **691 tests passed**, plus production build, frontend/backend TypeScript checks, Rust compilation, rustfmt and Clippy. |
| Frontend logic/persistence | 125 passed. |
| SQL/Edge integrations | 333 passed, applying all eight real migrations to isolated PGlite databases. |
| Native fixture/file tests | 53 passed; no real credentials or files were opened. |
| Browser workflows | 180 passed: 90 scenarios in both Chromium and WebKit. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 5 passed with desktop features enabled, including deferred/retryable startup initialization. Some overlap with the native suite. |
| `npm run test:stress` | **540 passed**, repeating all browser cases three times with no automatic retries. |
| `npm run test:coverage` | 458 Node tests passed; 89.47% line / 98.00% branch coverage across the modules loaded by that command, not whole-app coverage. |
| `npm audit --audit-level=high` | Zero known npm vulnerabilities reported; Rust dependencies are not covered by this check. |
| Visual/layout review | Reviewed Today and Focus screenshots at 640×500. Automated bounds checks at 640×500, 640×540, 800×600, 1000×760 and 1440×900 include the support link; controls fit, Today/Focus do not scroll, and the timer remains vertically centred. |

The audit adds **19 scenarios / 38 browser tests** in `tests/e2e/beta-readiness.spec.mjs`.

The browser checks use the real interface, localStorage, Web Locks, queue and SQL migrations. They click through email-code sign-in, three-task planning, crown priority, estimates, title editing, links, focus/pause/reasons/completion, tomorrow planning, calendar/stats, AI consent/previews, sign-out/account isolation, offline replay/restarts, rejected writes, two-window coordination, storage exhaustion and support-link errors. Native IPC, session identity, email delivery and provider transport are fixtures. External browser HTTP requests and uncaught page exceptions fail the tests.

## Remaining release gates — do these next

### 1. Verify the hosted beta environment

- Apply only unapplied migrations, in order, following [Supabase setup](../supabase/README.md). Back up existing data; **do not reset a hosted database**. Confirm the desktop points to the intended project.
- Confirm `development_unlimited = false`, production SMTP, signup/rate-limit settings and both email templates containing `{{ .Token }}`. Request and verify a code for a genuinely new user and a returning user; check inbox/spam delivery and expired/incorrect-code recovery.
- Keep AI off unless intentionally offering it. If enabled, verify consent/revocation, a real scheduled review and preview, bounded retries/global caps, the kill switch, and retention Cron in staging. Paid provider behavior was not exercised here.

### 2. Smoke-test the actual distributed app

Use the signed release, not just `npm run desktop`, and a clean test account/device. See [macOS signing](macos-signing.md).

- Install/open, sign in, quit/relaunch, reboot, install an update signed with the same identity, wait through access-token refresh, and sign out/relaunch. Verify Keychain/Credential Manager prompts, restoration, denial recovery and single-instance behavior.
- Click the support address before sign-in and after sign-in. Verify the OS opens the default mail app addressed to `fornelli.dv@gmail.com`; with no mail handler, confirm the fallback message. Test the Windows build separately if Windows users are invited.
- Create three tasks, choose priority, adjust estimates, attach/open a trusted local document, pause with a reason, resume/complete, and plan tomorrow. Verify OS dialogs and missing/cross-device paths.
- Disconnect after loading the planner, make changes, reload, reconnect and confirm all work arrives exactly once. Check sleep/wake and midnight while focusing. Fully offline native startup is not supported.
- On two real devices with one account, race creation/start/pause/completion and confirm conflict recovery preserves already-synced work. PGlite/browser-window races do not test multi-connection hosted lock contention or network partitions.

### 3. Run a deliberately small beta

- Invite 5–10 users first. Give them a short task: sign in, plan a day, pause/resume/complete, close/reopen and send feedback through the support link.
- Explain current limits: online sign-in/startup, unencrypted device cache retained after sign-out, local-only file contents, cloud-stored paths, temporary unsaved Focus notes, and no carry/drop or account-deletion UI.
- Publish a privacy/retention notice and a manual account-deletion request process; test backup restoration and deletion before collecting real personal task data.
- Collect build/OS version, sanitized error codes and reproduction steps, **not tokens, task titles, stop reasons or local file paths**. Track sign-in failures, lost work, timer/reconnect failures and points of confusion.
- Fix authentication, data-loss, account-isolation or repeated-crash reports before expanding. Add the reproduced cases to the automated suite. Prefer this feedback cycle to adding new MVP features immediately.

The automated run did not launch a signed Tauri release, interact with the real Keychain, send an email, open a user's document/mail application, deploy/reset Supabase, or call OpenAI. Hosted SMTP, signing/Gatekeeper trust, Windows WebView2, real IPC/default-app behavior and live cross-device contention remain unverified until the checklist is performed.
