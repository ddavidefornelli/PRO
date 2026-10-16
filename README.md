# PRO

A local-first daily planning desktop app built with **Rust, Tauri 2, and SQLite**, following [SPEC.md](SPEC.md).

## Getting started

Install:
- Node.js 22.12+ (or a current LTS) and npm.
- The current stable Rust toolchain through [rustup](https://rustup.rs/).
- [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode Command Line Tools on macOS, WebView2/build tools on Windows, or WebKitGTK/system libraries on Linux.

```sh
npm ci
npm run desktop
```

`npm run dev` serves only the frontend. Database commands require the Tauri desktop runtime; the browser displays an explanatory message rather than substituting fake persistence.

```sh
npm run build              # TypeScript checks + production frontend
npm test                   # Domain/service/SQLite tests, without desktop dependencies
npm run check              # Frontend build + full desktop Rust compile check
npm run tauri -- build     # Build the desktop executable (installer bundling disabled)
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Foundation included

- Today: create and immediately save up to three outcome-based tasks with duration estimates.
- Focus: start one task at a time and complete it, recording actual elapsed time.
- Tomorrow: planning unlocks once today's nonempty plan is complete.
- Habit tracker: 52 weeks of daily completions, grouped by the actual completion date.
- SQLite initialization, transactional versioned migrations, parameterized queries, and database-level constraints.
- Persistent timer recovery, typed IPC, accessible native form controls, keyboard navigation, and light/dark styling.

AI, white noise, editing/dropping/carrying unfinished tasks, pause/resume, and installer distribution are **not implemented yet**. No task data leaves the device and no AI service is contacted.

## Architecture and OOP approach

Rust uses structs, methods, traits, and composition rather than class inheritance. The foundation uses encapsulated entities, interface-based persistence, dependency injection, and separate responsibilities:

```text
src/
  api.ts                       Typed PlanningClient; the only frontend IPC adapter
  main.ts                      PlanningApplication view/controller
  styles.css
src-tauri/
  src/domain/                  Task entity, validated state transitions, errors
  src/application/             PlanningService, TaskRepository and Clock interfaces
  src/infrastructure/          SQLite repository and migration runner
  src/desktop.rs               Tauri command adapters and dependency composition
  migrations/001_initial.sql   Initial schema and constraints
  tests/planning.rs            Use-case and real SQLite integration tests
```

**Dependency flow:** UI → Tauri commands → application service → repository interface → SQLite adapter. Task state transitions belong to the domain, planning policy to the service, and SQL to the repository. The UI does not execute SQL. The desktop composition root injects the SQLite repository and system clock; tests inject an isolated repository and controlled clock.

The service holds a mutex over each complete use case so concurrent commands in the app cannot interleave validation and writes. SQLite also independently enforces at most three tasks per date and one active task globally. Status, start timestamp, actual duration, and completion date update atomically. Task fields are public only within the Rust crate for persistence mapping, not exposed for mutation to external callers or the UI.

## Storage and migrations

The database is `pro.sqlite3` inside Tauri's OS-specific application-data directory for `com.pro.desktop`. On macOS this is normally:

```text
~/Library/Application Support/com.pro.desktop/pro.sqlite3
```

The app creates the directory on startup. SQLite is bundled with the Rust dependency, so users do not need to install SQLite. WAL journaling, a five-second busy timeout, full synchronous writes, and foreign-key enforcement are configured on every connection. Do not delete this directory unless you intend to erase your tasks. For a manual backup, quit the app before copying its data directory (including any SQLite sidecar files).

`PRAGMA user_version` records the schema version. On a new database, migration 001 and its version bump run in a single immediate transaction. Existing databases at version 1 are left intact. Newer, unsupported schemas fail startup rather than being downgraded. Add future migrations with sequential version handling in `infrastructure/sqlite.rs`; never rewrite a migration already shipped to users.

## Time semantics

Planning dates use the device's local date, determined in Rust. Timer start timestamps are persisted Unix seconds, not browser interval counters. Displayed duration is recomputed from the timestamp, and completing a task saves the elapsed duration atomically. Sleep and time with the app closed count as focus time. An active task from a previous date remains available in Focus and blocks another active session until completed. Completion activity belongs to the local date on which the task is finished, not its original planning date.

Manual system-clock changes can affect duration; negative elapsed times are clamped to zero. Pause accounting, forgotten-timer corrections, and timezone travel policy are future work. The frontend periodically reloads state and refreshes when its window regains focus to handle date rollover and wake from sleep.

## Tests

Integration tests cover input validation, permitted planning dates, the daily limit, tomorrow gating, lifecycle transitions, single-active-task enforcement, timer recovery across database reopen/sleep/midnight, clock rollback, completion history, concurrent creates, and SQLite constraint enforcement independently of the service. Desktop launch and visual interaction still require a manual smoke test on each supported operating system.
