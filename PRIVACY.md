# prune Privacy Policy

Version: privacy-v3

Status: Published.

Last updated: 19 October 2026

This notice explains how personal data is processed when you use prune, a desktop planner. It follows the transparency structure of Articles 13 and 14 of the EU General Data Protection Regulation (GDPR). It is not a request to consent to all processing, a waiver of your rights, or a guarantee of regulatory compliance.

## 1. Who is responsible for your data?

The data controller is Davide Fornelli, established in Italy, operating prune. In this notice, “we”, “us” and “our” mean that controller.

Privacy requests, account deletion and support: fornelli.dv@gmail.com. Please use the subject “prune privacy request” and, where possible, write from the email associated with your account. Do not send your sign-in code, passwords or unnecessary identity documents.

## 2. What data do we process, and where does it come from?

- Account and authentication data: the email you provide, your account identifier, sign-in/session records and authentication tokens. Supabase handles email-code authentication; the desktop keeps the refresh token in macOS Keychain or Windows Credential Manager and the access token in native process memory, not webview localStorage.
- Planner data you enter and activity derived from it: task titles, priorities, estimates, planned and completion dates, task status, timer timestamps and recorded focus time, written stop reasons, and completion statistics. The device supplies an IANA timezone for scheduling and local dates. This is not GPS or precise-location collection.
- Resource metadata: labels, filenames, URLs and absolute local file paths you attach to tasks. This metadata syncs to Supabase and may contain personal or confidential information. Attached file contents are not uploaded by prune, and prune does not scan your other files.
- Local app data: an account/project-specific unencrypted planner snapshot and pending-action queue in webview localStorage, plus the privacy-notice version and acknowledgement time. The queue and server sync receipts can contain task text, reasons, resource metadata and mutation results. Sign-out does not erase the planner cache or pending actions.
- Optional AI data: if you separately enable weekly AI, selected task titles, task identifiers, dates, status, estimates, recorded task time, stop identifiers and written stop reasons are sent to OpenAI. Saved weekly reports include the generated reflection and a source-activity snapshot. Resource links, paths, filenames and file contents are excluded from AI input; sensitive information typed directly into a title or reason is not automatically removed.
- Support data: your email address, message and any attachments or diagnostics you choose to send when contacting us. Do not send sensitive task content unless necessary to resolve your request.
- Operational metadata: hosting, authentication and email providers may process IP addresses, request timestamps, technical request/device metadata, delivery records and security logs. These are distinct from planner content.

We receive data from you, your interactions with prune, your device's selected timezone/file metadata, and our authentication and infrastructure providers. We do not obtain planner data from data brokers. The Focus notes scratchpad stays in the current view's memory; prune does not save, sync or send it to AI, and it is lost when that task/view state is discarded or the app is reloaded.

Avoid entering special-category data (for example health, political or religious information), criminal-offence information, secrets, or other people's personal data into tasks or stop reasons. The optional AI consent is not permission to process every possible category of sensitive information. Only attach or enter information you are entitled to use.

## 3. Why do we process data, and on what legal basis?

- Providing the service you request — GDPR Article 6(1)(b), performance of a contract or steps at your request before entering it: creating and authenticating your account, delivering sign-in codes, storing and syncing your planner, running timers, associating resources, displaying your history/statistics, recording notice acknowledgement and resolving service requests. Account email and the relevant planner data are necessary for these features; if you do not provide them, those features cannot be supplied. You choose what to enter in optional text and resource fields.
- Optional weekly AI reflections — Article 6(1)(a), consent: only after you choose “Enable weekly AI reviews” in the separate AI settings. AI is off by default for new accounts. Refusing or withdrawing AI consent does not prevent you from using tasks, timers or cloud sync. See section 4.
- Security, abuse prevention, reliable delivery and handling disputes — Article 6(1)(f), legitimate interests, where applicable: protecting accounts and infrastructure, preventing duplicate sync operations, investigating faults and responding to non-contractual enquiries or legal claims. We must limit this processing to what is necessary, balance it against your rights, and document that assessment. You may object on grounds relating to your situation.
- Legal duties — Article 6(1)(c), only where a specific applicable law requires processing or disclosure, such as responding to a binding lawful request. This is not a general justification to retain all data indefinitely. We will identify the applicable obligation when relying on it, unless legally prohibited.

Acknowledging this notice is not consent to optional AI, advertising or unrelated uses. We do not sell personal data, use advertising trackers, or include third-party behavioural analytics in the app as currently implemented. No advertising or marketing consent is requested by the first-launch screen.

## 4. Optional AI and your choices

Enabling weekly AI is a separate, affirmative account setting. The server records the AI notice version and opt-in time and checks the account setting before allowing generation. Weekly reviews run when due while a signed-in client is open, or catch up on the next launch. The consent also covers a current-week preview if that feature is made available; previews are not added to saved review history.

Open Profile and choose “Disable weekly AI” to withdraw consent at any time. Withdrawal prevents new generation reservations and prevents in-flight results being saved if the consent revision has changed. It does not recall data already transmitted to OpenAI, erase previous reviews automatically, or affect the lawfulness of processing before withdrawal. Requests already sent and provider security/retention obligations may continue to apply. You can request erasure of existing reviews and source snapshots using the privacy contact above; their continued retention after withdrawal must be assessed when handling that request.

The OpenAI API is called with store: false. This is not a promise of zero retention, no international transfers, or a particular provider training policy. The operator must verify the applicable API agreement, project controls and provider retention before enabling hosted AI.

AI reflections can be inaccurate. They do not score task value, edit tasks or timers, or make decisions producing legal or similarly significant effects on you. You decide whether to act on a suggestion.

## 5. Who receives personal data?

- Supabase: account authentication, hosted database, server functions and associated infrastructure, including applicable subprocessors. The operator reports using a hosted Supabase project on the Free plan with its database in Ireland.
- Transactional email provider: Brevo, used to deliver sign-in codes through Supabase. It processes the recipient address, delivery content and delivery/security metadata.
- OpenAI: selected activity for optional AI reflections, only after opt-in, including relevant API infrastructure and subprocessors.
- Support email: messages you send to fornelli.dv@gmail.com and our replies.
- Authorised operator personnel or professional advisers, only where necessary for support, security, service administration or legal duties, subject to appropriate confidentiality and access controls.
- Public authorities or other recipients only where required by applicable law or necessary to establish, exercise or defend legal claims, with the applicable legal basis and safeguards.

The operator must have appropriate data-processing terms with processors and assess any processing for which a provider acts as an independent controller. We do not share your planner with other users. If you choose to open a resource URL or contact support, your browser/email application and the destination service process that interaction under their own policies. prune does not upload an attached file merely because you open it locally.

## 6. International transfers

Provider processing, support access and subprocessors may be located outside the European Economic Area or your country. Selecting an EU database region alone does not guarantee that all authentication, support, email or AI processing stays in the EEA.

Before making a restricted transfer, the operator must confirm an applicable lawful mechanism, such as a relevant adequacy decision or European Commission Standard Contractual Clauses, assess the destination and apply supplementary measures where required. An acknowledgement or AI toggle is not blanket consent to unrestricted international transfers.

## 7. How long is data kept?

- Cloud account and planner history, stop reasons, resource metadata, saved weekly reviews and their source snapshots: while you maintain your account, until account deletion or a justified earlier administrative deletion. No automatic inactive-account expiry is currently configured. You may request erasure at any time, subject to the limited legal exceptions below. Only the latest 52 saved reviews are displayed, but older reports may remain in the database.
- Server sync receipts: kept with the account until deletion to prevent duplicate replay of pending actions, and may contain earlier request data and results. Removing a resource or changing text in the current planner does not necessarily remove older values from these receipts. We must assess and action an erasure request across these copies, not only the currently visible row.
- Local planner snapshot and pending actions: persist on each device until its app storage is cleared. Sign-out retains them. Clearing local storage can permanently lose unsynced work. Account deletion does not remotely wipe every device's cache; arrange removal of local copies on all your devices. Uninstalling may not clear all OS/webview app data.
- Local privacy acknowledgement: the current notice version and acknowledgement time remain in this app installation's localStorage until replaced by a later acknowledgement or app storage is cleared. This is a device-local notice record, not an account consent register.
- Session credentials: the desktop deletes its saved refresh token on sign-out; an issued access token may remain valid until expiry.
- Operational AI content: successful operational retry output is cached for seven days; temporary source activity is cleared on completion/failure or by cleanup after an expired lease. Per-account request/quota metadata is removed after 90 days. Aggregate daily usage counters are removed after 90 days and monthly counters after one year. These periods require the retention cleanup job to run successfully and do not delete durable saved reviews.
- Deletion from the active database does not immediately erase provider backups. Restoring a backup must not permanently undo an erasure request.
- OpenAI processing and security retention: store: false does not override provider retention requirements.

We may retain only the data necessary for a specific legal obligation or legal claim for the applicable period, restricting its use accordingly. Data that is genuinely anonymised and no longer reasonably identifies anyone may be retained separately. Pseudonymous identifiers alone do not make data anonymous.

## 8. Your GDPR rights and how to use them

Subject to the applicable legal conditions, you can request access and a copy of your personal data; correction of inaccurate data; erasure; restriction of processing; and portability of data you provided that we process automatically on consent or contract grounds, in a structured, commonly used, machine-readable format. You may object to processing based on legitimate interests and withdraw AI consent as described above. If we introduce direct marketing, you have an unconditional right to object to it.

Email fornelli.dv@gmail.com to request access, an export, correction or deletion of your account/data. There is currently no in-app account-deletion or export button. We may need proportionate information to verify account ownership and clarify your request, but will not ask you to send a sign-in code or unnecessary identity documents. We must communicate the action taken without undue delay and normally within one month of receipt; any lawful extension of up to two further months for complexity or volume must be explained within the first month. Requests are normally free; statutory exceptions are limited.

Account deletion removes the Auth account and associated active-database planner rows, reviews, source snapshots, sync receipts and private AI request records through cascading deletion. Aggregate non-account usage counters can remain. Backup, provider-log and device-local copies follow section 7. Sync or export any work you want to keep before requesting deletion. We will explain any data we cannot lawfully erase and the reason/retention period.

You may complain to a supervisory authority, particularly in the EEA country of your habitual residence, place of work or the alleged infringement, without contacting us first. The European Data Protection Board also publishes a directory of EEA authorities. You may seek a judicial remedy where available.

## 9. Security and device privacy

The app uses HTTPS for production cloud connections, operating-system credential storage for refresh tokens, and per-account database access controls. These measures reduce risk but do not make any service completely secure. The webview planner cache/outbox is unencrypted app data, not protected by the credential store, and may be accessible to someone with access to your device or backups. Use a protected device account and disk encryption; do not use a shared device for confidential planning without considering these risks.

Our application code is designed not to log credentials or raw AI activity in error messages. Infrastructure logging, administrator access, backup controls and incident response must also be configured appropriately by the operator. If a personal-data breach occurs, the operator must assess and meet any applicable authority and affected-person notification duties.

## 10. Local storage, children and changes to this notice

The app uses localStorage for the planner snapshot, durable sync queue and this notice's acknowledgement, and the native credential store for the session. These support the service you request; they are not advertising cookies. We do not ask for a blanket cookie consent or optional tracking consent when no such tracking is present. Platform/provider storage and any future tracking must be assessed separately under applicable law.

prune is intended for people aged 16 and over, not directed at children. No age-verification or parental-consent flow is currently implemented. If you believe a child has supplied personal data contrary to applicable requirements, contact us so we can assess and delete it where appropriate.

We will update this notice when processing changes and show a new acknowledgement screen when the notice version changes. A changed notice does not silently expand existing AI consent; materially new optional purposes or data uses require a separate lawful basis and renewed consent where necessary. The acknowledgement only records that this notice was presented on this device, not an agreement to surrender your data-protection rights.
