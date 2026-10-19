# App specification

## Purpose
A fast, reliable desktop app that removes daily planning friction and helps you focus on meaningful progress.

## Daily workflow
1. Plan up to **three important tasks**.
2. Set an estimated duration and choose the most important task yourself.
3. Choose a task and start working. The timer and optional white noise start together.
4. Finish the task and record the time spent.
5. When today is done, plan tomorrow’s tasks and repeat.

## Tasks
Each task contains:
- A clear outcome.
- Estimated duration and accumulated recorded focus time (timer-running seconds, excluding paused breaks). Completed tasks display both; zero recorded time is treated as missing timing evidence.
- Status: planned, active, or completed.

Unfinished tasks can be carried forward, rewritten, or dropped.

## AI
- Optional, consent-based weekly reflection, posted in Overview once per week.
- Summarizes the latest Sunday-due week from Monday through the generation snapshot, identifies the main reported reasons for stopping work, compares estimates with whole-task recorded focus time for tasks completed that week, and suggests a few practical improvements for next week. Activity logged later on Sunday is not included.
- Timing differences are calculated in code. Whole-task time may span weeks and is not a weekly work-time total. Unfinished tasks have no final duration; duration alone does not establish efficiency or causes.
- Tasks provide context only: no task-value scoring, coping labels, or “moving the boat” suggestions.
- Grounds interpretations in the recorded reasons, acknowledges missing information, and respects legitimate rest and interruptions.
- Never changes tasks or timers. Failures leave core features and past reviews available.
- Becomes due Sunday at 4:00 p.m. in the device's local timezone while the app is open, or catches up with the latest due week on the next launch.
- Overview also offers “Review this week so far”: an on-demand Monday-through-today preview, separate from scheduled reports, shown for the current app session only. Requires consent and shared budget availability; limited to three attempts per UTC day, at least ten minutes apart. Failures count.

## Interface
Four planner views: **Today, Focus, Tomorrow (only if today's tasks are finished), Overview (daily completion grid and saved weekly AI reflections)**.

A top-right **Profile** icon opens a single stats page showing completion totals, active days, streaks, recent activity, today's task focus time and the completion calendar. The account email is right-aligned beside the page heading. A red **Sign out** button sits at the bottom of the stats page; there are no Stats/Logout tabs or separate logout page. Keep copy minimal. Profile access follows the running focus timer's navigation lock; pause first. Pending-change confirmation and cache retention are preserved.

A support footer, including on sign-in/error screens, reads “Any problems with the app? Contact me at: fornelli.dv@gmail.com”. The address is a `mailto:` link opened through the default email application in the desktop runtime, without requiring sign-in.

Minimal, professional, keyboard-friendly. Today and Focus fit within one desktop window without page scrolling, including a full three-task plan. Long resource collections open in a bounded dialog instead of stretching the page; Overview may scroll. During focus, show only the current task, timer, and essential controls.

## Technology
- **Rust + Tauri** for the desktop application.
- **Supabase Auth** with email one-time-code sign-in.
- **Supabase Postgres** for authoritative account state, protected by per-user row-level security and transactional server-side commands.
- A persistent webview localStorage snapshot/outbox for immediate planner updates and ordered background sync, isolated by project and immutable user ID.
- Native OS credential storage for refresh tokens; no SQLite database. Local planner data is unencrypted; tokens never enter the cache.
- Attachments remain local file paths; filenames and paths sync through the account, file contents do not upload.

## Reliability
- Planner actions save to a durable local outbox before appearing successful, then sync automatically. Storage failures are surfaced without applying the action.
- Ordered replay uses stable IDs and transactional server receipts to deduplicate ambiguous network retries. Pending actions survive restarts and sign-out; only the same account/project can replay them.
- Network failures retry with bounded backoff. Definitive validation/conflict failures stop replay and preserve pending work until the user explicitly discards the rejected action and its dependents.
- Timer state survives restarts and handles sleep. Local pause/completion is immediate; other devices see it after sync. Queued timer events use captured action timestamps/timezones, bounded to 30 days in the past and two minutes in the future; nonqueued operations use server time.
- Per-account database transactions enforce planning limits and one authoritative active timer across devices. Optimistic local state may be rejected after a cross-device conflict.
- Sign-in (including startup authentication), AI and file operations require internet. File operations require pending planner changes to sync first. The cache covers the last fetched planning days/active task and local changes, not all history.
- No SQLite fallback or old-data import. Existing local databases are left untouched. Clearing app storage can lose unsynced actions; sign-out retains the local cache.
- AI failure never interrupts local planner commands. Supabase outages delay cloud sync.
- Sending task data to an AI service requires account-level consent; provider credentials stay server-side.
- Resource paths may be unavailable or refer to different files on another device and must be validated before opening.

## First version excludes
Full offline-first startup/history, collaboration, external calendar integration, file uploads, and complex project management. Accounts and cloud persistence are included. White noise, carrying/dropping tasks, account-deletion UI, and secure installer distribution remain future work.
