# Adversarial test suite

## Running it

```sh
npm ci
npx playwright install chromium webkit
npm run test:all
npm run test:stress
npm run test:coverage
```

`npm test` runs **all four layers**, not just Rust. `test:all` additionally runs the production frontend build, strict frontend/backend TypeScript checks, desktop Rust compilation, rustfmt and Clippy with warnings denied. `.github/workflows/tests.yml` runs `test:all` on macOS.

Focused commands: `test:unit`, `test:queue`, `test:calendar`, `test:backend`, `test:native`, and `test:e2e`. Browser failures retain a screenshot, trace and HTML report in gitignored `test-results/` and `playwright-report/`. View a report with `npx playwright show-report`.

## Verification results

The latest run passed **778 tests**. See the [beta readiness audit](docs/beta-readiness.md) for user-flow findings and the [privacy release checklist](docs/privacy-release-checklist.md) for the remaining legal/deployment work.

| Layer | Tests | What actually executes |
| --- | ---: | --- |
| Frontend logic / persistence | 134 | TypeScript queue, calendar, stats, privacy acknowledgement/release checks and shared planner/time logic; controlled storage, clocks, transport and lock fixtures |
| Backend / integrations | 333 | Repository SQL migrations in PGlite, RLS/privileges, Edge validation/handler/platform/provider code, queue-to-SQL and complete Edge-to-SQL pipelines |
| Native | 53 | Rust auth/session and HTTP adapter against localhost TCP fixtures; real temporary files and Unix permissions/symlinks; in-memory credentials |
| Browser workflows | 258 | 129 scenarios in **both Chromium and WebKit**, real application UI, localStorage and Web Locks, actual migrated SQL behind fixture native IPC |

The browser stress command repeats each scenario three times (**774 executions**, no automatic retries). The SQL command storm performs **400 seeded actions**, checking invariants after every success/rejection. Independent timer oracles check **100 work/pause segments for each of four seeds**. Separate tests race twelve queue instances, and two real browser windows exercise shared storage and Web Locks.

Previously measured Node coverage with `test:coverage` (not remeasured for the privacy additions): **89.47% lines / 98.00% branches** across the loaded modules. All four weekly-review backend modules have **100% line coverage**; the queue has **98.10% line coverage**. This is **not whole-application coverage**: browser-only entrypoints and Rust are not instrumented by that command, and the shared DOM helpers and calendar renderer are exercised by browser tests rather than the Node coverage run.

The cleanup adds explicit tests for shared day/time calculations, projection/acknowledgement immutability, and batched snapshot replay without changing durable state. Queue storage version 1, retry/locking behavior and server protocols remain unchanged. Three stale browser scenarios (six failures across both engines before this refactor) now assert the existing date heading and Escape-preserved pause dialog behavior; the UI was not changed to satisfy the old expectations.

## Coverage map

### Planning and isolation

- Full task transition matrix: planned, running, paused and completed; priority-first enforcement, three-slot limits, tomorrow gating and one active task even while paused.
- Title/estimate boundaries, Unicode, malformed JSON arguments, invalid dates, numeric overflow and missing fields.
- Rejected commands leave tasks, stops, resources, revisions and receipts unchanged.
- Cross-account denial for every task/resource operation; denied direct INSERT/UPDATE/DELETE for both client roles; internal function permissions and empty security-definer search paths.
- Actual server receipt replay for every queueable mutation; action/argument/timezone/timestamp/revision mismatches; same-second cross-device conflicts.
- Captured overnight action dates in seven timezones, including non-hour offsets; DST gaps/repeated hours, sleep and long-running timers; Gregorian calendar/century exceptions.

### Persistence and failures

- Offline dependent writes, reload/restart recovery, full account/project cache separation, immutable IDs and ordered revisions.
- Commit followed by lost acknowledgement; storage failure before enqueue or during acknowledgement; safe retry after restart.
- Concurrent enqueue during send/dashboard reads; single-flight sends; stopped queues; exponential retries capped at 60 seconds.
- Definitive rejection blocks dependent actions; explicit discard keeps the already-committed prefix; ambiguous failures remain nondiscardable.
- Corrupt/unknown cache values are not overwritten; returned objects cannot mutate saved state; incomplete/mismatched acknowledgements cannot remove the outbox.

### AI and HTTP

- Strict request/source/output schemas; byte and text limits; UTF-8 split across chunks; invented/duplicate evidence, prompt-injection text and resource exclusions.
- Authentication/CORS/method/content-length failures before paid reservations; fixed provider model/prompt/storage policy; sanitized errors and retry headers.
- Quota limits, hourly backoff, immutable cache, lease expiry/rotation, consent changes during generation, operational input cleanup and 52-review history.
- Full handler → authenticated platform adapter → real service-role SQL RPCs → fixture provider → durable SQL review/cache, plus provider failure and mid-flight consent revocation.
- Native malformed/truncated/oversized HTTP bodies, the exact 8 MiB response boundary, rejected redirects and non-JSON Auth errors.

### Privacy notice and first launch

- Unchecked notice acknowledgement before authentication/session restoration, queue replay or AI checks; “Not now” and opening/closing the bundled policy do not access an account.
- Current version/time persist across reload, sign-in and sign-out; old/corrupt/missing records show the notice again. Blocked storage and failed writes stay at a recoverable gate, without changing planner data.
- Notice acknowledgement never enables AI or changes an existing account's AI preference. AI consent remains a separate account setting.
- Full policy is available without a connection or account, during a running timer, and at small window sizes with bounded internal scrolling, keyboard close/focus restoration and literal text rendering.
- The release check rejects unfinished legal fields and version mismatches. It is expected to fail until the actual operator/provider details in `PRIVACY.md` are completed; passing software tests is not evidence of GDPR compliance.

### Native resources and browser UI

- Every supported file extension, dangerous extensions and double extensions, missing/directory/network/control-character paths, executable bits and canonical symlink targets.
- Numeric OTP boundaries, malformed/anonymous session payloads, privileged public-key misconfiguration, credential load/save/delete failures, native refresh rotation with 16 concurrent readers and best-effort remote logout.
- Email-code/resend/error flows, complete daily planning workflow, offline pause/completion and webview reload, rejected-change resolution, account switching and sign-out with pending work.
- Storage exhaustion with draft preservation, focus-refresh draft protection, literal rendering of hostile text, safe resource controls, keyboard/pointer dial interactions, calendar navigation, pause-dialog Escape behavior, overdue timers and stale consent reads.
- Queue-protocol/network failures retain pending work without routine sync banners or manual controls; reconnect automatically retries the same change. Only definitive rejection displays a user-action notice.
- Single-screen Today/Focus layouts at five desktop client sizes (640×500 through 1440×900), all 0–3 task counts, 500-character titles, 50 resources per task, running/paused timers and return navigation. Tests check actual control bounds, not just hidden scrollbars. Resource dialogs contain long lists; Overview remains scrollable.
- Browser tests block nonlocal HTTP requests and fail on uncaught page exceptions.

## Bugs reproduced and fixed

| Finding | Fix / regression coverage |
| --- | --- |
| A stale window's cached `blocked` flag could authorize deleting newer ambiguous work after a different window resolved a conflict. | `src/local-queue.ts` rechecks the freshly loaded rejection under sender/state locks. Multi-instance discard regression. |
| A successful HTTP response with a null, empty, malformed or wrong-task acknowledgement could remove durable queued work. | Queue validates acknowledgements and revision metadata before persistence/removal. Broken acknowledgements remain ambiguous and retryable. |
| Completing a previous-day active task returned `undefined` because the task had already left the dashboard's day lists. | Projection returns the mutated task separately from its filtered dashboard. Mock-clock overnight regression. |
| SQL's three-valued NULL comparison allowed a null AI lease token (or missing consent revision) to pass the completion rejection predicate. This function is service-only, not a public authentication bypass. | Incremental `20261017000400_review_lease_validation.sql` fails closed with explicit null handling / `IS DISTINCT FROM`; real SQL regressions. |
| Stream overflow awaited cancellation indefinitely if the stream's cancellation hook never settled. | Best-effort nonblocking cancellation retains the read/size bound; hostile cancellation regression. |
| Focus/poll refresh could rebuild the planner while typing, deleting an unsubmitted draft. | Refresh defers while an input/textarea/slider is focused; regression in both browser engines. |
| Failed AI-enable saves still triggered generation and replaced the settings error. The server's consent gate already prevented a provider call. | Generation starts only after successful persisted enabling; both-browser regression. |
| Missing/multiple email `@` parts were accepted locally and unnecessarily sent to Auth. | Native email validation rejects empty local/domain parts and extra separators before HTTP; native input matrix. |
| The eight-box sign-in form rejected six-digit local Auth codes and truncated longer hosted codes. | The UI accepts 6–10 digits, adapts boxes on paste/autofill or longer typing, rejects gaps, and resets on resend. Both-browser regressions cover every supported length. |
| Whitespace-only new outcomes and unsupported/credential-bearing URLs could enter the durable outbox, then be rejected by the backend. | Validate before enqueue, retain editable input, and check URL UTF-8 byte limits. Both-browser regressions verify no queued write and successful correction. |
| AI settings errors rendered only in the detached Overview panel when preferences were changed from Profile. | Loading/save failures and retry controls render in the visible settings surface. Both-browser regressions cover initial load failure and rejected consent saves. |
| Global focus suppression left the outcome field and estimate dial without visible keyboard focus. | A global `:focus-visible` outline restores keyboard feedback without adding pointer-click outlines. Both-browser regression. |

The beta audit adds **19 scenarios / 38 browser tests**, including support-link success/failure, availability before sign-in, and layout checks that include the footer. `cargo test --manifest-path src-tauri/Cargo.toml --lib` also passes five tests with desktop features enabled (including the startup initialization test excluded by `test:native`). `npm audit --audit-level=high` reports zero known npm vulnerabilities; this does not audit Rust dependencies.

**Deployment action:** apply all unapplied migrations in order, including the preview, stop-filtering, development-limit and Sunday-schedule migrations. Keep `development_unlimited = false` in production. No migrations were deployed and no remote data was reset by these tests.

## Safety and limits

- No live Supabase credentials, real emails, paid provider calls, keychain access, user-file opening or production writes. Native tests use ephemeral localhost ports and isolated temporary files; browser native IPC is explicitly a fixture.
- PGlite runs genuine Postgres SQL but serializes database statements. Promise-based/queue/window races validate client ordering and constraints, **not multi-connection Postgres lock contention, deadlocks, hosted scalability or cross-device network partitions**.
- Browser tests are not a launched Tauri binary. They do not verify OS IPC permissions, real native dialogs, credential prompts, platform default-app opening, installers/signatures or Windows WebView2 behavior. Actual files are validated but never launched.
- A webview reload with a valid native session is not a fully offline native-app startup. New native-process startup still requires online authentication, as documented in README.
- Hosted SMTP, Supabase gateway/Auth configuration, Deno deployment/runtime, provider semantics and native Mac/Windows release smoke tests remain necessary. The Deno-specific `index.ts` bootstrap is excluded from the portable backend TypeScript check; the handler/platform/provider/domain modules are checked.
- The passing suite is evidence for these cases, not a claim that all possible inputs or races have been exhausted. Run the hosted/manual checklist in `supabase/README.md` before release.
