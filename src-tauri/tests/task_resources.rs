use chrono::{Days, NaiveDate};
use pro_lib::{
    application::{Clock, Moment, PlanningService, TaskRepository},
    infrastructure::SqliteTaskRepository,
};

struct TestClock(NaiveDate);
impl Clock for TestClock {
    fn now(&self) -> Moment {
        Moment {
            day: self.0,
            unix_seconds: 1000,
        }
    }
}

#[test]
fn tomorrows_resources_survive_restart_focus_and_removal() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let file = directory.path().join("brief.txt");
    std::fs::write(&file, "Project brief").unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
    let open = |day| {
        PlanningService::new(
            Box::new(SqliteTaskRepository::open(&path).unwrap()),
            Box::new(TestClock(day)),
        )
    };
    let app = open(today);
    let task = app.create_task("Today", today, 30).unwrap();
    app.start_task(task.id()).unwrap();
    app.complete_task(task.id()).unwrap();
    let tomorrow = today + Days::new(1);
    let task = app.create_task("Tomorrow", tomorrow, 30).unwrap();
    let task = app
        .add_resource(
            task.id(),
            "  Brief  ",
            "https://example.com/brief?q=1",
            "link",
        )
        .unwrap();
    let link_id = task.resources[0].id.clone();
    assert_eq!(task.resources[0].label, "Brief");
    let task = app
        .add_resource(task.id(), "brief.txt", file.to_str().unwrap(), "file")
        .unwrap();
    let file_id = task.resources[1].id.clone();
    drop(app);

    let app = open(tomorrow);
    let task = app.start_task(task.id()).unwrap();
    assert_eq!(task.resources.len(), 2);
    assert_eq!(
        app.resource(task.id(), &file_id).unwrap().target,
        file.to_str().unwrap()
    );
    app.pause_task(task.id(), "Break").unwrap();
    app.resume_task(task.id()).unwrap();
    assert_eq!(app.complete_task(task.id()).unwrap().resources.len(), 2);
    app.remove_resource(task.id(), &link_id).unwrap();
    assert!(app.resource(task.id(), &link_id).is_err());
    app.remove_resource(task.id(), &file_id).unwrap();
    assert!(
        file.exists(),
        "Removing a reference must not delete the original"
    );
    drop(app);
    assert!(SqliteTaskRepository::open(&path)
        .unwrap()
        .find(task.id())
        .unwrap()
        .resources
        .is_empty());
}

#[test]
fn rejects_unsafe_links_invalid_files_and_missing_tasks() {
    let day = NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
    let app = PlanningService::new(
        Box::new(SqliteTaskRepository::in_memory().unwrap()),
        Box::new(TestClock(day)),
    );
    let task = app.create_task("Work", day, 30).unwrap();
    for target in [
        "javascript:alert(1)",
        "file:///tmp/brief",
        "https://",
        "example.com",
        "https://user:secret@example.com",
    ] {
        assert!(
            app.add_resource(task.id(), "Brief", target, "link")
                .is_err(),
            "{target}"
        );
    }
    assert!(app
        .add_resource(task.id(), " ", "https://example.com", "link")
        .is_err());
    assert!(app
        .add_resource(task.id(), &"x".repeat(201), "https://example.com", "link")
        .is_err());
    assert!(app
        .add_resource(task.id(), "Missing", "/nonexistent/pro-file", "file")
        .is_err());
    assert!(app
        .add_resource(task.id(), "Relative", "relative.txt", "file")
        .is_err());
    assert!(app
        .add_resource("missing", "Brief", "https://example.com", "link")
        .is_err());
    for _ in 0..50 {
        app.add_resource(task.id(), "Brief", "https://example.com", "link")
            .unwrap();
    }
    assert!(app
        .add_resource(task.id(), "Overflow", "https://example.com", "link")
        .is_err());
}

#[test]
fn migrates_existing_tasks_with_empty_resources() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../migrations/001_initial.sql"))
        .unwrap();
    db.execute_batch(include_str!("../migrations/002_timer_pauses.sql"))
        .unwrap();
    db.execute_batch("PRAGMA user_version = 2;
        INSERT INTO tasks VALUES ('old', 'Existing task', '2026-10-16', 30, 12, 'active', 1000, NULL, 900);").unwrap();
    drop(db);
    let repo = SqliteTaskRepository::open(&path).unwrap();
    let task = repo.find("old").unwrap();
    assert!(task.resources.is_empty());
    assert_eq!(task.actual_seconds(), 12);
}
