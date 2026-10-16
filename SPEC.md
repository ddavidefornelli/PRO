# App specification

## Purpose
A fast, reliable desktop app that removes daily planning friction and helps you focus on meaningful progress.

## Daily workflow
1. Plan up to **three important tasks**.
2. AI reviews their importance, distinguishes progress from maintenance, and estimates duration.
3. Choose a task and start working. The timer and optional white noise start together.
4. Finish the task and record the time spent.
5. When today is done, plan tomorrow’s tasks and repeat.

## Tasks
Each task contains:
- A clear outcome.
- Estimated duration and actual time spent.
- Status: planned, active, or completed.

Unfinished tasks can be carried forward, rewritten, or dropped.

## AI
- Uses your stated goals to evaluate tasks.
- Suggests clearer or smaller tasks when needed.
- Uses past completion times to improve estimates.
- Never changes tasks without approval.

## Interface
Three views: **Today, Focus, Tomorrow(only if today's tasks are finished), Habit Tracker (a git hub like diagram that displays how many tasks where done per day)**.

Minimal, professional, keyboard-friendly. During focus, show only the current task, timer, and essential controls.

## Technology
- **Rust + Tauri** for the desktop application.
- **SQLite** for local storage.

## Reliability
- Tasks save automatically.
- Tasks, timer, and white noise work offline.
- Timer state survives restarts and handles sleep.
- AI failure never interrupts core features.
- Sending task data to an AI service requires consent.

## First version excludes
Accounts, cloud sync, collaboration, calendars, and complex project management.
