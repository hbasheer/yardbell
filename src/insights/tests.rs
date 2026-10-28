use super::*;
use crate::snapshot::{Activity, Session};
use chrono::TimeZone;

fn at(min: i64, sec: i64) -> DateTime<Local> {
    Local.with_ymd_and_hms(2026, 10, 28, 10, 0, 0).unwrap()
        + chrono::Duration::seconds(min * 60 + sec)
}

fn session(name: &str, activity: Activity) -> Session {
    Session {
        machine: "hp".into(),
        agent: "claude".into(),
        pid: 42,
        cwd: "/r/app".into(),
        folder: "app".into(),
        branch: "fix-login".into(),
        ticket: "-".into(),
        tmux: Some(name.into()),
        activity,
    }
}

fn snap(sessions: Vec<Session>, screens: &[(&str, &str)]) -> Snapshot {
    let mut snap = Snapshot {
        sessions,
        ..Snapshot::default()
    };
    for (id, screen) in screens {
        snap.runs.insert(id.to_string(), runs::runs(screen));
    }
    snap
}

fn kinds(rec: &Record) -> Vec<Kind> {
    rec.marks.iter().map(|m| m.kind).collect()
}

#[test]
fn records_each_change_of_state_and_the_end() {
    let dir = tempfile::tempdir().unwrap();
    let insights = Insights::load(dir.path().join("insights.json"));
    insights.observe("hp", &snap(vec![], &[]), at(0, 0));
    for (min, activity) in [
        (1, Activity::Active),
        (2, Activity::Active),
        (20, Activity::Blocked),
        (25, Activity::Active),
        (40, Activity::Idle),
    ] {
        insights.observe(
            "hp",
            &snap(vec![session("hp-app", activity)], &[]),
            at(min, 0),
        );
    }
    insights.observe("hp", &snap(vec![], &[]), at(50, 0));
    insights.observe("pro", &snap(vec![], &[]), at(51, 0));
    let rec = insights.record("hp", "hp-app").unwrap();
    assert_eq!(
        kinds(&rec),
        [
            Kind::Started,
            Kind::Active,
            Kind::Blocked,
            Kind::Active,
            Kind::Idle,
            Kind::Ended
        ],
        "a session that appears after the first check started then, and repeats are not marks"
    );
    let t = rec.timeline(at(60, 0));
    assert!(t.started);
    assert_eq!(t.since, at(1, 0).to_rfc3339());
    assert_eq!(t.ended, Some(at(50, 0).to_rfc3339()));
    let periods: Vec<(&str, i64)> = t.periods.iter().map(|p| (p.state, p.seconds)).collect();
    assert_eq!(
        periods,
        [
            ("working", 19 * 60),
            ("waiting", 5 * 60),
            ("working", 15 * 60),
            ("idle", 10 * 60)
        ]
    );
    assert_eq!(
        t.totals,
        Totals {
            working: 34 * 60,
            waiting: 5 * 60,
            idle: 10 * 60
        }
    );
}

#[test]
fn a_session_running_at_the_first_check_is_seen_and_a_reused_name_starts_over() {
    let dir = tempfile::tempdir().unwrap();
    let insights = Insights::load(dir.path().join("insights.json"));
    let live = || snap(vec![session("hp-app", Activity::Idle)], &[]);
    insights.observe("hp", &live(), at(0, 0));
    let rec = insights.record("hp", "hp-app").unwrap();
    assert_eq!(kinds(&rec), [Kind::Seen, Kind::Idle]);
    assert!(!rec.timeline(at(1, 0)).started);
    insights.observe("hp", &snap(vec![], &[]), at(5, 0));
    insights.observe("hp", &live(), at(9, 0));
    let rec = insights.record("hp", "hp-app").unwrap();
    assert_eq!(kinds(&rec), [Kind::Started, Kind::Idle]);
    assert_eq!(rec.marks[0].at, at(9, 0).to_rfc3339());
}

#[test]
fn tool_and_test_runs_are_recorded_once_while_they_stay_on_screen() {
    let dir = tempfile::tempdir().unwrap();
    let insights = Insights::load(dir.path().join("insights.json"));
    let id = "hp:hp-app";
    let one = "⏺ Bash(cargo test)\n  ⎿  running 3 tests\n";
    let two = "⏺ Bash(cargo test)\ntest result: FAILED. 2 passed; 1 failed; 0 ignored\n";
    let three = "test result: FAILED. 2 passed; 1 failed; 0 ignored\n⏺ Update(src/lib.rs)\n";
    insights.observe("hp", &snap(vec![], &[]), at(0, 0));
    for (min, screen) in [(1, one), (2, two), (3, three), (4, three)] {
        let s = snap(vec![session("hp-app", Activity::Active)], &[(id, screen)]);
        insights.observe("hp", &s, at(min, 0));
    }
    let t = insights.record("hp", "hp-app").unwrap().timeline(at(5, 0));
    let runs: Vec<(&str, Option<bool>, String)> = t
        .runs
        .iter()
        .map(|m| (m.text.as_str(), m.ok, m.at.clone()))
        .collect();
    assert_eq!(
        runs,
        [
            ("Bash: cargo test", None, at(1, 0).to_rfc3339()),
            (
                "test result: FAILED. 2 passed; 1 failed",
                Some(false),
                at(2, 0).to_rfc3339()
            ),
            ("Update: src/lib.rs", None, at(3, 0).to_rfc3339()),
        ]
    );
    assert_eq!(t.runs[0].kind, Kind::Test);
    assert_eq!(t.runs[2].kind, Kind::Tool);
}

#[test]
fn timelines_carry_on_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("insights.json");
    let id = "hp:hp-app";
    let screen = "⏺ Bash(npm test)\n";
    {
        let insights = Insights::load(file.clone());
        insights.observe("hp", &snap(vec![], &[]), at(0, 0));
        let s = snap(vec![session("hp-app", Activity::Active)], &[(id, screen)]);
        insights.observe("hp", &s, at(1, 0));
    }
    let insights = Insights::load(file.clone());
    let s = snap(vec![session("hp-app", Activity::Blocked)], &[(id, screen)]);
    insights.observe("hp", &s, at(10, 0));
    let rec = insights.record("hp", "hp-app").unwrap();
    assert_eq!(
        kinds(&rec),
        [Kind::Started, Kind::Active, Kind::Test, Kind::Blocked],
        "the same session keeps its start, and a run still on screen is not recorded again"
    );
    let saved: BTreeMap<String, Record> =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved[id], rec);
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "screens can show secrets");
}

#[test]
fn marks_and_sessions_are_capped_keeping_the_first_mark() {
    let dir = tempfile::tempdir().unwrap();
    let insights = Insights::load(dir.path().join("insights.json"));
    insights.observe("hp", &snap(vec![], &[]), at(0, 0));
    for i in 0..(MAX_MARKS as i64 + 50) {
        let activity = if i % 2 == 0 {
            Activity::Active
        } else {
            Activity::Idle
        };
        insights.observe(
            "hp",
            &snap(vec![session("hp-app", activity)], &[]),
            at(i, 0),
        );
    }
    let rec = insights.record("hp", "hp-app").unwrap();
    assert_eq!(rec.marks.len(), MAX_MARKS);
    assert_eq!(rec.marks[0].kind, Kind::Started);
    assert_eq!(rec.marks[0].at, at(0, 0).to_rfc3339());
    assert_eq!(rec.dropped, 51);
    assert_eq!(rec.timeline(at(999, 0)).dropped, 51);

    for i in 0..(MAX_SESSIONS + 5) {
        let name = format!("hp-s{i}");
        let live = snap(vec![session(&name, Activity::Idle)], &[]);
        insights.observe("hp", &live, at(1000 + i as i64, 0));
    }
    let records = insights.lock();
    assert_eq!(records.len(), MAX_SESSIONS);
    assert!(records.contains_key(&format!("hp:hp-s{}", MAX_SESSIONS + 4)));
    assert!(!records.contains_key("hp:hp-app"), "the oldest go first");
}

#[test]
fn short_blips_fold_into_the_stretch_around_them() {
    let dir = tempfile::tempdir().unwrap();
    let insights = Insights::load(dir.path().join("insights.json"));
    insights.observe("hp", &snap(vec![], &[]), at(0, 0));
    for (min, sec, activity) in [
        (1, 0, Activity::Active),
        (5, 0, Activity::Idle),
        (5, 5, Activity::Active),
        (9, 0, Activity::Idle),
    ] {
        let s = snap(vec![session("hp-app", activity)], &[]);
        insights.observe("hp", &s, at(min, sec));
    }
    let t = insights.record("hp", "hp-app").unwrap().timeline(at(10, 0));
    let periods: Vec<(&str, i64, bool)> = t
        .periods
        .iter()
        .map(|p| (p.state, p.seconds, p.to.is_some()))
        .collect();
    assert_eq!(periods, [("working", 8 * 60, true), ("idle", 60, false)]);
}

#[test]
fn the_suggestion_names_the_session_its_task_and_what_happened() {
    let dir = tempfile::tempdir().unwrap();
    let insights = Insights::load(dir.path().join("insights.json"));
    insights.observe("hp", &snap(vec![], &[]), at(0, 0));
    let id = "hp:hp-app";
    let failing = "test result: FAILED. 0 passed; 1 failed\n";
    for (min, activity) in [(1, Activity::Active), (30, Activity::Blocked)] {
        let s = snap(vec![session("hp-app", activity)], &[(id, failing)]);
        insights.observe("hp", &s, at(min, 0));
    }
    let t = insights.record("hp", "hp-app").unwrap().timeline(at(32, 0));
    let text = suggest_message(&Ask {
        machine: "hp",
        name: "hp-app",
        live: true,
        task: "Fix the login redirect",
        from: Some(("Fix a bug", 3)),
        timeline: Some(&t),
    });
    for part in [
        "the session hp-app on hp",
        "read_session, with lines 2000",
        "It started with this task:\n\nFix the login redirect",
        "my saved task \"Fix a bug\", version 3",
        "work for 29 minutes, wait for an answer 1 time (2 minutes in all)",
        "with 1 failing test run",
        "```prompt",
    ] {
        assert!(text.contains(part), "{part:?} missing from:\n{text}");
    }
    let ended = suggest_message(&Ask {
        machine: "hp",
        name: "hp-app",
        live: false,
        task: "",
        from: None,
        timeline: None,
    });
    assert!(ended.contains("It has ended"));
    assert!(ended.contains("does not know the task"));
    assert!(!ended.contains("saved task"));
}
