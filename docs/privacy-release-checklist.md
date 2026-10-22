# Privacy policy and release checklist

`../PRIVACY.md` is the single source for the policy displayed in the app. It is a GDPR transparency template tailored to the implemented data flows, **not a compliance certificate or a substitute for legal advice**. Do not distribute it with unfinished operator fields. The in-app policy explicitly warns while those fields remain.

## Deferred implementation TODO

- Delete saved AI reviews and their source snapshots when weekly AI is disabled. This is requested behavior, not yet implemented; the policy continues to describe the current behavior.
- Schedule and monitor the AI retention cleanup job; the operator confirms it is not yet scheduled.

The operator has removed unanswered prompts from the policy for now. It remains explicitly marked as a draft; removing prompts does not complete the release review below.

## Complete and review before collecting real user data

- Identify the controller's legal name, address and jurisdiction. Confirm that `fornelli.dv@gmail.com` is an actively monitored privacy contact. Determine whether a DPO and/or EU/UK representative is required; supply the applicable contacts or explicitly state that none is required. Confirm the relevant supervisory authority/contact.
- Record the actual Supabase project region and processing/subprocessor locations, production SMTP provider/entity, support mailbox provider, and, if offered, the OpenAI API contracting entity, project region, retention/training controls and subprocessors. Do not infer all processing is in the EEA just because the database is.
- Put appropriate processor agreements in place; assess any independent-controller processing. Document the actual international transfer map, adequacy/SCC mechanisms, transfer risk assessment and supplementary safeguards. **Do not enable AI until its provider processing and transfer terms have been reviewed.**
- Set justified retention periods for support/privacy correspondence, Auth/security/SMTP logs and backups, including how deletion reaches or expires from backups. Review indefinite account-history retention, old AI snapshots and content-bearing sync receipts against storage limitation. Do not purge receipts without a safe queue-expiry protocol.
- Schedule and monitor `purge_weekly_review_content()` as described in [the backend guide](../supabase/README.md#5-retention-and-cleanup). The policy's operational AI periods are not fulfilled merely by having a cleanup function in the database. Verify actual provider log/backup retention and clean up failed/expired AI requests.
- Review the selected Article 6 legal bases, document any legitimate-interest balancing and applicable legal duties, and establish the handling/legal basis for saved reviews when consent is withdrawn. Privacy-notice acknowledgement must not be represented as consent to all processing.
- Review optional AI consent wording, version/time records, revocation and retention of appropriate evidence. A privacy notice version is **not** the AI consent version. A material change to AI inputs, purposes or providers may require a new AI notice version, backend migration and renewed opt-in; simply bumping the general privacy version is not enough.
- Decide how to handle minors and special-category/third-party information. There is no age verification, parental-consent flow or blanket Article 9 permission. Assess whether a DPIA is required for the actual deployment and users.
- Restrict administrator access, configure provider logs not to collect request bodies/tokens, review security/backup controls, maintain a processing record, and prepare an incident/breach response process. Test actual signed macOS/Windows builds and hosted infrastructure, not only fixture tests.
- Have a qualified privacy professional review the completed notice, rights workflow, retention/transfer evidence and applicable local laws. A standard text alone cannot make the app “GDPR safe”. If the business model or data flows differ from the template, change the notice and implementation accordingly.

## Manual rights, export and deletion workflow

There is no in-app account deletion/export button. The policy routes requests to the existing support address. Before release, assign someone to monitor that inbox and test this workflow with disposable accounts:

1. Record receipt/deadline and acknowledge the request. Verify account ownership proportionately (normally through the account email); never request a sign-in code or unnecessary identity documents. Explain any lawful extension within the first month.
2. For access/portability, use a restricted admin process to assemble the user's relevant Auth data, planner/account settings, tasks, stops, resource metadata, saved reviews/source snapshots and applicable private request/receipt records. Respond in a secure, commonly used format such as JSON/CSV, covering other GDPR access information. Protect third-party data and deliver only to the verified requester. Do not email service-role keys or raw authentication tokens.
3. For erasure, explain the effects and offer the opportunity to sync/export wanted work. Stop optional generation as appropriate and delete the verified Auth user with an authorised admin process. Verify cascades remove `planner_accounts`, tasks, stops, resources, reviews, receipts, `ai_review_requests` and `ai_review_previews` for that user. Check associated support/log/provider copies too; do not assume Auth deletion erases them. No live-data deletion is performed by the app's first-launch flow.
4. Explain any narrow legal exception and its basis/retention, backup expiry, provider retention, and the fact that local app data must be cleared on **every** device. Sign-out alone does not erase local caches; clearing storage can lose unsynced work and uninstalling may leave app data. Do not promise an automatic remote device wipe.
5. Prevent stale backups/restores from permanently reviving erased data; keep only the minimal restricted evidence needed to reapply erasure and demonstrate the request was handled. Validate the process and communicate the outcome within the statutory deadline.

## Implementation and versioning

- `src/privacy-onboarding.ts` gates startup **before** `authenticate()`, credential restoration, queue replay or automatic AI checks. The user can read the full bundled notice without network/account access. “Not now” does not call account IPC.
- An unchecked acknowledgement is required to continue. The only saved record is `{ version, acknowledgedAt }` under `prune:privacy:acknowledgement` in localStorage. It is per device/app installation, not a server-side contract signature or an account-level consent audit trail. It survives sign-out and does not identify an account.
- Optional AI remains a separate account setting and is off by default for new accounts. General acknowledgement never enables AI or changes an existing account preference. Core account/planner processing is not falsely presented as optional consent.
- The Privacy Policy footer button works on onboarding, sign-in/error screens, planner/Profile and during a running timer. The notice is bundled and rendered as text, not fetched remotely or interpreted as HTML.
- A missing, unreadable, malformed or old acknowledgement presents the notice again. A failed durable acknowledgement write does not proceed to authentication. No cache/outbox data is deleted to show a new policy.
- After an applicable notice change, update the `Version:` line and `Last updated:` in `PRIVACY.md` and bump `PRIVACY_POLICY_VERSION` in `src/privacy-state.ts`. Keep dated prior published versions in your release/legal records. The version must change when replacing material unfinished fields before initial public release too; test users must see the completed notice.
- `npm run privacy:check` rejects unfinished fields and mismatched versions. Signed macOS release preflight/build runs it too; ordinary frontend builds remain available for development. Passing this check is only template hygiene, not legal approval. Apply the same check to any future Windows/distribution pipeline.

## Verification

```sh
npm run build
node --experimental-strip-types --test tests/privacy.test.mjs
npx playwright test tests/e2e/privacy.spec.mjs
npm run privacy:check  # Expected to fail until the real operator fields are completed.
```

Browser tests cover first launch before account IPC, reading/closing the notice, unchecked acknowledgement, declining, durable storage and retry/failure, version changes, unchanged existing AI preferences, sign-in/reload/sign-out, availability while focusing, and bounded scrollable policy layout. They do not verify real email delivery, deletion/exports, DPAs, transfers, provider retention, secure OS storage or legal compliance.
