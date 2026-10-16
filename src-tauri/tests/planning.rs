use chrono::{Days, NaiveDate};
use pro_lib::{
    application::{Clock, Moment, PlanningService, TaskRepository},
    domain::{Task, TaskStatus},
    infrastructure::SqliteTaskRepository,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct TestClock(Arc<Mutex<Moment>>);
impl TestClock {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Moment {
            day: NaiveDate::from_ymd_opt(2026, 10, 16).unwrap(),
            unix_seconds: 1_000_000,
        })))
    }
    fn advance(&self, seconds: i64) {
        self.0.lock().unwrap().unix_seconds += seconds;
    }
    fn next_day(&self) {
        let mut now = self.0.lock().unwrap();
        now.day = now.day + Days::new(1);
        now.unix_seconds += 86400;
    }
}
impl Clock for TestClock {
    fn now(&self) -> Moment {
        *self.0.lock().unwrap()
    }
}
fn service(clock: &TestClock) -> PlanningService {
    PlanningService::new(
        Box::new(SqliteTaskRepository::in_memory().unwrap()),
        Box::new(clock.clone()),
    )
}

#[test]
fn priority_task_must_be_completed_before_other_tasks() {
    let clock = TestClock::new();
    let app = service(&clock);
    let day = clock.now().day;
    let first = app.create_task("First", day, 20).unwrap();
    let second = app.create_task("Second", day, 20).unwrap();
    let third = app.create_task("Third", day, 20).unwrap();
    assert!(first.is_priority);
    assert!(app.start_task(second.id()).is_err());
    assert!(app.prioritize_task(second.id()).unwrap().is_priority);
    assert!(app.start_task(first.id()).is_err());
    app.start_task(second.id()).unwrap();
    assert!(app.prioritize_task(first.id()).is_err());
    app.pause_task(second.id(), "Break").unwrap();
    assert!(app.start_task(first.id()).is_err());
    app.resume_task(second.id()).unwrap();
    app.complete_task(second.id()).unwrap();
    assert!(app.prioritize_task(first.id()).is_err());
    app.start_task(third.id()).unwrap();
    app.complete_task(third.id()).unwrap();
    app.start_task(first.id()).unwrap();
}

#[test]
fn validates_outcomes_estimates_and_planning_dates() {
    let clock = TestClock::new();
    let app = service(&clock);
    let day = clock.now().day;
    assert!(app.create_task("  ", day, 30).is_err());
    assert!(app.create_task(&"x".repeat(501), day, 30).is_err());
    assert!(app.create_task("Outcome", day, 0).is_err());
    assert!(app.create_task("Outcome", day, 61).is_err());
    assert!(app.create_task("Outcome", day, 1441).is_err());
    assert!(app.create_task("Outcome", day - Days::new(1), 30).is_err());
    assert!(app.create_task("Outcome", day + Days::new(2), 30).is_err());
    let task = app.create_task("  Ship proposal  ", day, 30).unwrap();
    assert_eq!(task.outcome(), "Ship proposal");
    assert!(app.create_task("Full hour", day, 60).is_ok());
}

#[test]
fn limits_daily_plan_and_requires_today_to_be_finished() {
    let clock = TestClock::new();
    let app = service(&clock);
    let day = clock.now().day;
    assert!(app.create_task("Tomorrow", day + Days::new(1), 30).is_err());
    let tasks: Vec<_> = (0..3)
        .map(|i| app.create_task(&format!("Outcome {i}"), day, 30).unwrap())
        .collect();
    assert!(app.create_task("Fourth", day, 30).is_err());
    for task in tasks {
        app.start_task(task.id()).unwrap();
        app.complete_task(task.id()).unwrap();
    }
    let tomorrow = app.create_task("Tomorrow", day + Days::new(1), 30).unwrap();
    assert!(app.start_task(tomorrow.id()).is_err());
}

#[test]
fn enforces_lifecycle_and_single_active_task() {
    let clock = TestClock::new();
    let app = service(&clock);
    let first = app.create_task("First", clock.now().day, 30).unwrap();
    let second = app.create_task("Second", clock.now().day, 30).unwrap();
    assert!(app.complete_task(first.id()).is_err());
    assert!(app.start_task("missing").is_err());
    app.start_task(first.id()).unwrap();
    assert!(app.start_task(first.id()).is_err());
    assert!(app.start_task(second.id()).is_err());
    clock.advance(125);
    let completed = app.complete_task(first.id()).unwrap();
    assert_eq!(completed.status(), TaskStatus::Completed);
    assert_eq!(completed.actual_seconds(), 125);
    assert!(app.complete_task(first.id()).is_err());
    assert!(app.start_task(first.id()).is_err());
    app.start_task(second.id()).unwrap();
}

#[test]
fn restart_preserves_active_timer_and_counts_sleep_and_midnight() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pro.sqlite3");
    let clock = TestClock::new();
    let id;
    {
        let app = PlanningService::new(
            Box::new(SqliteTaskRepository::open(&path).unwrap()),
            Box::new(clock.clone()),
        );
        let task = app.create_task("Deep work", clock.now().day, 30).unwrap();
        id = task.id().to_owned();
        app.start_task(&id).unwrap();
    }
    clock.next_day();
    clock.advance(60);
    let repository = SqliteTaskRepository::open(&path).unwrap();
    assert_eq!(repository.active().unwrap().unwrap().id(), id);
    let app = PlanningService::new(Box::new(repository), Box::new(clock.clone()));
    let completed = app.complete_task(&id).unwrap();
    assert_eq!(completed.actual_seconds(), 86460);
    drop(app);
    let repository = SqliteTaskRepository::open(&path).unwrap();
    assert!(repository.active().unwrap().is_none());
    assert_eq!(
        repository.find(&id).unwrap().status(),
        TaskStatus::Completed
    );
    let counts = repository
        .completions(clock.now().day, clock.now().day)
        .unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].count, 1);
    assert_eq!(counts[0].day, clock.now().day);
}

#[test]
fn clock_rollback_never_produces_negative_time() {
    let clock = TestClock::new();
    let app = service(&clock);
    let task = app.create_task("Work", clock.now().day, 30).unwrap();
    app.start_task(task.id()).unwrap();
    clock.advance(-300);
    assert_eq!(app.complete_task(task.id()).unwrap().actual_seconds(), 0);
}

#[test]
fn sqlite_guards_limits_even_when_service_is_bypassed() {
    let mut repo = SqliteTaskRepository::in_memory().unwrap();
    let day = TestClock::new().now().day;
    let mut first = Task::new("One", day, 30, 0).unwrap();
    let mut second = Task::new("Two", day, 30, 0).unwrap();
    repo.insert(&first).unwrap();
    repo.insert(&second).unwrap();
    repo.insert(&Task::new("Three", day, 30, 0).unwrap())
        .unwrap();
    assert!(repo
        .insert(&Task::new("Four", day, 30, 0).unwrap())
        .is_err());
    first.start(1).unwrap();
    second.start(1).unwrap();
    repo.update(&first).unwrap();
    assert!(repo.update(&second).is_err());
    assert_eq!(
        repo.find(second.id()).unwrap().status(),
        TaskStatus::Planned
    );
}

#[test]
fn concurrent_creates_never_exceed_three() {
    let clock = TestClock::new();
    let app = Arc::new(service(&clock));
    let day = clock.now().day;
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let app = app.clone();
            std::thread::spawn(move || app.create_task(&format!("Task {i}"), day, 30).is_ok())
        })
        .collect();
    let successes = threads
        .into_iter()
        .filter_map(|thread| thread.join().ok())
        .filter(|ok| *ok)
        .count();
    assert_eq!(successes, 3);
}
