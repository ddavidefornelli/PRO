use chrono::NaiveDate;
use pro_lib::{
    application::{Clock, Moment, PlanningService, TaskRepository},
    infrastructure::SqliteTaskRepository,
};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};

struct TestClock(Arc<AtomicI64>);
impl Clock for TestClock {
    fn now(&self) -> Moment {
        Moment {
            day: NaiveDate::from_ymd_opt(2026, 10, 16).unwrap(),
            unix_seconds: self.0.load(Ordering::SeqCst),
        }
    }
}

#[test]
fn pause_reasons_and_timer_survive_restart_and_exclude_paused_time() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let now = Arc::new(AtomicI64::new(1000));
    let open = || {
        PlanningService::new(
            Box::new(SqliteTaskRepository::open(&path).unwrap()),
            Box::new(TestClock(now.clone())),
        )
    };
    let app = open();
    let task = app
        .create_task("Focus", TestClock(now.clone()).now().day, 30)
        .unwrap();
    assert!(app.pause_task(task.id(), "Break").is_err());
    assert!(app.resume_task(task.id()).is_err());
    app.start_task(task.id()).unwrap();
    assert!(app.pause_task(task.id(), "  ").is_err());
    assert!(app.pause_task(task.id(), &"a".repeat(1001)).is_err());
    now.store(1060, Ordering::SeqCst);
    assert_eq!(
        app.pause_task(task.id(), "  Phone call  ")
            .unwrap()
            .actual_seconds(),
        60
    );
    assert!(app.pause_task(task.id(), "Again").is_err());
    let other = app
        .create_task("Other", TestClock(now.clone()).now().day, 30)
        .unwrap();
    assert!(app.start_task(other.id()).is_err());
    drop(app);

    now.store(2060, Ordering::SeqCst);
    let app = open();
    app.resume_task(task.id()).unwrap();
    assert!(app.resume_task(task.id()).is_err());
    now.store(2090, Ordering::SeqCst);
    app.pause_task(task.id(), "Coffee").unwrap();
    now.store(3090, Ordering::SeqCst);
    assert_eq!(app.complete_task(task.id()).unwrap().actual_seconds(), 90);
    drop(app);

    let db = rusqlite::Connection::open(&path).unwrap();
    let pauses: Vec<(String, i64)> = db
        .prepare("SELECT reason, paused_at FROM timer_pauses ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        pauses,
        vec![("Phone call".into(), 1060), ("Coffee".into(), 2090)]
    );
}

#[test]
fn estimates_are_editable_only_before_start_and_persist() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let app = PlanningService::new(
        Box::new(SqliteTaskRepository::open(&path).unwrap()),
        Box::new(TestClock(Arc::new(AtomicI64::new(1000)))),
    );
    let task = app.create_task("Work", NaiveDate::from_ymd_opt(2026, 10, 16).unwrap(), 30).unwrap();
    assert!(app.change_estimate(task.id(), 0).is_err());
    assert!(app.change_estimate(task.id(), 61).is_err());
    app.change_estimate(task.id(), 45).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let minutes: u32 = db.query_row("SELECT estimated_minutes FROM tasks WHERE id = ?1", [task.id()], |row| row.get(0)).unwrap();
    assert_eq!(minutes, 45);
    app.start_task(task.id()).unwrap();
    assert!(app.change_estimate(task.id(), 20).is_err());
    app.stop_timer(task.id()).unwrap();
    assert!(app.change_estimate(task.id(), 20).is_err());
    app.complete_task(task.id()).unwrap();
    assert!(app.change_estimate(task.id(), 20).is_err());
}

#[test]
fn stopping_before_writing_reason_excludes_time_spent_writing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let now = Arc::new(AtomicI64::new(1000));
    let app = PlanningService::new(
        Box::new(SqliteTaskRepository::open(&path).unwrap()),
        Box::new(TestClock(now.clone())),
    );
    let task = app.create_task("Work", TestClock(now.clone()).now().day, 30).unwrap();
    app.start_task(task.id()).unwrap();
    assert!(app.save_pause_reason(task.id(), "Break").is_err());
    now.store(1060, Ordering::SeqCst);
    assert_eq!(app.stop_timer(task.id()).unwrap().actual_seconds(), 60);
    now.store(1360, Ordering::SeqCst);
    assert!(app.save_pause_reason(task.id(), "  ").is_err());
    app.save_pause_reason(task.id(), "  Phone call  ").unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let pause: (String, i64) = db.query_row(
        "SELECT reason, paused_at FROM timer_pauses WHERE task_id = ?1",
        [task.id()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(pause, ("Phone call".into(), 1060));
    app.resume_task(task.id()).unwrap();
    now.store(1390, Ordering::SeqCst);
    assert_eq!(app.complete_task(task.id()).unwrap().actual_seconds(), 90);
}

#[test]
fn migrates_existing_running_tasks_without_data_loss() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../migrations/001_initial.sql"))
        .unwrap();
    db.execute_batch("PRAGMA user_version = 1;
        INSERT INTO tasks VALUES ('old', 'Existing task', '2026-10-16', 30, 12, 'active', 1000, NULL, 900);").unwrap();
    drop(db);
    let repo = SqliteTaskRepository::open(&path).unwrap();
    assert_eq!(repo.active().unwrap().unwrap().id(), "old");
    assert_eq!(repo.find("old").unwrap().actual_seconds(), 12);
    let app = PlanningService::new(
        Box::new(repo),
        Box::new(TestClock(Arc::new(AtomicI64::new(1060)))),
    );
    assert_eq!(app.pause_task("old", "Break").unwrap().actual_seconds(), 72);
}

#[test]
fn failure_to_save_reason_does_not_stop_timer() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let app = PlanningService::new(
        Box::new(SqliteTaskRepository::open(&path).unwrap()),
        Box::new(TestClock(Arc::new(AtomicI64::new(1000)))),
    );
    let task = app
        .create_task("Work", NaiveDate::from_ymd_opt(2026, 10, 16).unwrap(), 30)
        .unwrap();
    app.start_task(task.id()).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_pause BEFORE INSERT ON timer_pauses BEGIN SELECT RAISE(ABORT, 'Failed'); END;").unwrap();
    assert!(app.pause_task(task.id(), "Break").is_err());
    // Resume must fail because the transaction rolled back and the timer is still running.
    assert!(app.resume_task(task.id()).is_err());
    db.execute_batch("DROP TRIGGER fail_pause;").unwrap();
    app.pause_task(task.id(), "Retry").unwrap();
}
