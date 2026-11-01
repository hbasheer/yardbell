pub mod checks;

use crate::config::{Config, HealthChecks};
use crate::phone::Push;
use crate::pipeline::definition::Definition;
use crate::pipeline::triggers::Kept;
use crate::web::AppState;
use checks::{Check, Facts, FailingTrigger, Finding};
use chrono::{DateTime, Duration, Local};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::task::JoinHandle;

const ROUND: std::time::Duration = std::time::Duration::from_secs(30);
// A problem that goes away for less than this is the same problem when it returns.
const CLEAR_AFTER_MINUTES: i64 = 5;
const PUSHES_PER_ROUND: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Problem {
    pub check: Check,
    pub key: String,
    pub title: String,
    pub detail: String,
    pub link: String,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Entry {
    check: Check,
    title: String,
    detail: String,
    link: String,
    since: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    not_before: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    mark: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    notified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    absent_since: Option<String>,
}

impl Entry {
    fn new(f: &Finding, now: DateTime<Local>) -> Entry {
        Entry {
            check: f.check,
            title: f.title.clone(),
            detail: f.detail.clone(),
            link: f.link.clone(),
            since: f.since.unwrap_or(now).to_rfc3339(),
            not_before: f.not_before.map(|at| at.to_rfc3339()),
            mark: f.mark.clone(),
            scopes: f.scopes.clone(),
            notified: false,
            absent_since: None,
        }
    }

    fn seen(&mut self, f: &Finding, now: DateTime<Local>) {
        let fresh = Entry::new(f, now);
        let restarted = self.mark != fresh.mark;
        let since = match (f.since, restarted) {
            (None, false) => std::mem::take(&mut self.since),
            _ => fresh.since.clone(),
        };
        let notified = self.notified && !restarted;
        *self = Entry {
            since,
            notified,
            ..fresh
        };
    }

    fn lasted(&self, minutes: u64, now: DateTime<Local>) -> bool {
        let reached = |text: &str, wait: i64| {
            time(text).is_some_and(|at| now - at >= Duration::minutes(wait))
        };
        reached(&self.since, minutes as i64)
            && self.not_before.as_deref().is_none_or(|at| reached(at, 0))
    }

    fn problem(&self, key: &str) -> Problem {
        Problem {
            check: self.check,
            key: key.to_string(),
            title: self.title.clone(),
            detail: self.detail.clone(),
            link: self.link.clone(),
            since: self.since.clone(),
        }
    }
}

fn time(text: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&Local))
}

#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub open: Vec<Problem>,
    pub fresh: Vec<Problem>,
}

fn advance(
    entries: &mut BTreeMap<String, Entry>,
    findings: &[Finding],
    unread: &HashSet<String>,
    settings: &HealthChecks,
    now: DateTime<Local>,
) -> Outcome {
    entries.retain(|_, entry| entry.check.setting(settings).0);
    let found: HashSet<&str> = findings.iter().map(|f| f.key.as_str()).collect();
    for f in findings {
        entries
            .entry(f.key.clone())
            .and_modify(|entry| entry.seen(f, now))
            .or_insert_with(|| Entry::new(f, now));
    }
    let is_unread = |entry: &Entry| entry.scopes.iter().any(|scope| unread.contains(scope));
    entries.retain(|key, entry| {
        if found.contains(key.as_str()) || is_unread(entry) {
            return true;
        }
        let absent = entry
            .absent_since
            .get_or_insert_with(|| now.to_rfc3339())
            .clone();
        time(&absent).is_some_and(|at| now - at < Duration::minutes(CLEAR_AFTER_MINUTES))
    });
    let mut outcome = Outcome::default();
    for (key, entry) in entries.iter_mut() {
        let (_, minutes) = entry.check.setting(settings);
        if !found.contains(key.as_str()) || !entry.lasted(minutes, now) {
            continue;
        }
        let problem = entry.problem(key);
        if !entry.notified {
            entry.notified = true;
            outcome.fresh.push(problem.clone());
        }
        outcome.open.push(problem);
    }
    outcome
}

fn lasted_text(since: &str, now: DateTime<Local>) -> String {
    let minutes = time(since).map_or(0, |at| (now - at).num_minutes().max(0));
    if minutes < 60 {
        format!("{minutes} min")
    } else {
        format!("{} h", minutes / 60)
    }
}

fn click_for(link: &str, base: Option<&str>) -> Option<String> {
    if link.starts_with("http://") || link.starts_with("https://") {
        return Some(link.to_string());
    }
    base.map(|base| format!("{base}{link}"))
}

pub fn pushes(fresh: &[Problem], base: Option<&str>, now: DateTime<Local>) -> Vec<Push> {
    let tags = vec!["warning".to_string()];
    if fresh.len() > PUSHES_PER_ROUND {
        return vec![Push {
            title: "Yardbell health checks".into(),
            message: format!("{} new problems, see the dashboard", fresh.len()),
            tags,
            priority: 3,
            click: click_for("/", base),
        }];
    }
    fresh
        .iter()
        .map(|problem| Push {
            title: problem.title.clone(),
            message: format!("{} ({})", problem.detail, lasted_text(&problem.since, now)),
            tags: tags.clone(),
            priority: 3,
            click: click_for(&problem.link, base),
        })
        .collect()
}

pub struct Ledger {
    file: PathBuf,
    written: Vec<u8>,
    entries: BTreeMap<String, Entry>,
}

fn read_entries(file: &Path) -> Result<BTreeMap<String, Entry>, String> {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.to_string()),
    }
}

impl Ledger {
    pub fn load(file: PathBuf) -> Ledger {
        let entries = read_entries(&file).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "could not read {}; health checks start afresh", file.display());
            BTreeMap::new()
        });
        Ledger {
            file,
            written: Vec::new(),
            entries,
        }
    }

    fn save(&mut self) {
        let bytes = serde_json::to_vec_pretty(&self.entries).unwrap_or_default();
        if self.written == bytes {
            return;
        }
        let tmp = self.file.with_extension("tmp");
        let done = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, &bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        match done {
            Ok(()) => self.written = bytes,
            Err(e) => tracing::warn!(error = %e, "could not save {}", self.file.display()),
        }
    }

    pub fn round(
        &mut self,
        facts: &Facts,
        settings: &HealthChecks,
        now: DateTime<Local>,
    ) -> Outcome {
        let outcome = advance(
            &mut self.entries,
            &checks::findings(facts, settings, now),
            &checks::unread_scopes(facts),
            settings,
            now,
        );
        self.save();
        outcome
    }

    pub fn tick(&mut self, app: &AppState, cfg: &Config, now: DateTime<Local>) {
        let outcome = self.round(&facts_of(app, cfg), &cfg.health_checks, now);
        let base = crate::phone::base_url(cfg);
        app.phone
            .inbox
            .add(&pushes(&outcome.fresh, base.as_deref(), now));
        app.state.set_problems(outcome.open);
    }

    pub fn start_loop(mut self, app: Arc<AppState>) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut every = tokio::time::interval(ROUND);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                match app.config() {
                    Ok(cfg) => self.tick(&app, &cfg, Local::now()),
                    Err(_) => tracing::debug!("health checks not run, the config cannot be read"),
                }
            }
        })
    }
}

fn pipeline_failing(def: &Definition, kept: Kept) -> Option<FailingTrigger> {
    if kept.problem.is_empty() {
        return None;
    }
    let failed_once_at = match kept.problem_at.as_str() {
        "" => None,
        at => Some(time(at)?),
    };
    Some(FailingTrigger {
        id: format!("pipeline:{}", def.id),
        title: format!("The trigger of {} keeps failing", def.name),
        problem: kept.problem,
        link: format!("/pipeline?p={}", def.id),
        failed_once_at,
    })
}

fn pipeline_triggers(app: &AppState) -> Vec<FailingTrigger> {
    app.pipelines
        .library()
        .list()
        .iter()
        .filter(|def| def.enabled)
        .filter_map(|def| pipeline_failing(def, app.pipelines.watch().kept(&def.id)))
        .collect()
}

fn facts_of(app: &AppState, cfg: &Config) -> Facts {
    let view = app.state.view(cfg, app.ports.as_ref(), "localhost");
    let mut triggers = app.triggers.failing(cfg);
    triggers.extend(pipeline_triggers(app));
    Facts {
        runs: app.pipelines.runs(),
        step_minutes: cfg.pipelines.minutes,
        screens: app.state.screens(),
        pulls: app
            .state
            .pulls()
            .into_iter()
            .filter(|(key, pull)| !app.pipelines.waits_on_pull(&pull.url, &key.0, &key.1))
            .collect(),
        unread_pulls: app.state.unread_pulls(),
        triggers,
        view,
    }
}

// What doctor says: the checks that are on, and what they last found.
pub fn doctor_lines(cfg: &Config, state_dir: &Path) -> Vec<(bool, String)> {
    let settings = &cfg.health_checks;
    let on = Check::ALL
        .iter()
        .filter(|check| check.setting(settings).0)
        .count();
    let file = state_dir.join("health.json");
    let entries = match read_entries(&file) {
        Ok(entries) => entries,
        Err(e) => {
            return vec![(
                false,
                format!(
                    "health checks: {} cannot be read: {e}. Yardbell starts it afresh",
                    file.display()
                ),
            )]
        }
    };
    let mut lines = vec![(
        true,
        format!("health checks: {on} of {} on", Check::ALL.len()),
    )];
    lines.extend(
        entries
            .values()
            .filter(|entry| {
                entry.notified && entry.absent_since.is_none() && entry.check.setting(settings).0
            })
            .map(|entry| (false, format!("{}: {}", entry.title, entry.detail))),
    );
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostTerminal;
    use crate::pipeline::engine::tests::at;
    use crate::state::StateView;

    fn finding(key: &str, check: Check) -> Finding {
        Finding {
            key: key.into(),
            check,
            title: format!("{key} title"),
            detail: "detail".into(),
            link: "/pipeline".into(),
            since: None,
            not_before: None,
            mark: String::new(),
            scopes: Vec::new(),
        }
    }

    fn settings() -> HealthChecks {
        HealthChecks {
            run_waiting_minutes: 10,
            ..HealthChecks::default()
        }
    }

    struct Book {
        entries: BTreeMap<String, Entry>,
        settings: HealthChecks,
        unread: HashSet<String>,
    }

    impl Book {
        fn new() -> Book {
            Book {
                entries: BTreeMap::new(),
                settings: settings(),
                unread: HashSet::new(),
            }
        }

        fn at(&mut self, minute: i64, findings: &[Finding]) -> Outcome {
            advance(
                &mut self.entries,
                findings,
                &self.unread,
                &self.settings,
                at(0) + Duration::minutes(minute),
            )
        }

        fn fresh(&mut self, minute: i64, findings: &[Finding]) -> Vec<String> {
            self.at(minute, findings)
                .fresh
                .into_iter()
                .map(|p| p.key)
                .collect()
        }
    }

    fn waiting() -> Finding {
        finding("w", Check::RunWaiting)
    }

    #[test]
    fn nothing_opens_before_the_threshold_and_it_notifies_once() {
        let mut book = Book::new();
        let w = [waiting()];
        assert_eq!(book.at(0, &w), Outcome::default());
        assert_eq!(book.at(9, &w), Outcome::default());
        let opened = book.at(10, &w);
        assert_eq!(opened.fresh.len(), 1);
        assert_eq!(opened.open, opened.fresh);
        let later = book.at(11, &w);
        assert_eq!(later.fresh, vec![]);
        assert_eq!(later.open.len(), 1);
        assert_eq!(book.fresh(500, &w), Vec::<String>::new());
    }

    #[test]
    fn it_notifies_again_only_after_it_clears_and_comes_back() {
        let mut book = Book::new();
        let w = [waiting()];
        book.at(0, &w);
        assert_eq!(book.fresh(10, &w), ["w"]);

        assert_eq!(book.at(11, &[]), Outcome::default());
        assert_eq!(book.fresh(14, &w), Vec::<String>::new(), "still the same");
        assert_eq!(book.at(14, &w).open.len(), 1);

        book.at(15, &[]);
        book.at(19, &[]);
        assert!(book.entries.contains_key("w"));
        book.at(20, &[]);
        assert!(!book.entries.contains_key("w"));

        assert_eq!(book.fresh(21, &w), Vec::<String>::new());
        assert_eq!(book.fresh(30, &w), Vec::<String>::new());
        assert_eq!(book.fresh(31, &w), ["w"]);
    }

    #[test]
    fn a_problem_that_is_gone_stops_showing_at_once() {
        let mut book = Book::new();
        let w = [waiting()];
        book.at(0, &w);
        assert_eq!(book.at(10, &w).open.len(), 1);
        assert_eq!(book.at(11, &[]).open, vec![]);
    }

    #[test]
    fn a_time_from_the_data_can_open_at_first_sight() {
        let mut book = Book::new();
        let w = Finding {
            since: Some(at(0)),
            ..waiting()
        };
        assert_eq!(book.fresh(10, std::slice::from_ref(&w)), ["w"]);
        assert_eq!(book.at(11, &[w]).open[0].since, at(0).to_rfc3339());
    }

    #[test]
    fn a_new_mark_starts_over() {
        let mut book = Book::new();
        let marked = |mark: &str| Finding {
            mark: mark.into(),
            ..waiting()
        };
        book.at(0, &[marked("a")]);
        assert_eq!(book.fresh(10, &[marked("a")]), ["w"]);
        assert_eq!(book.at(11, &[marked("b")]).open, vec![]);
        assert_eq!(book.fresh(20, &[marked("b")]), Vec::<String>::new());
        assert_eq!(book.fresh(21, &[marked("b")]), ["w"]);
    }

    #[test]
    fn not_before_holds_a_problem_back() {
        let mut book = Book::new();
        let w = Finding {
            not_before: Some(at(0) + Duration::minutes(30)),
            ..waiting()
        };
        book.at(0, std::slice::from_ref(&w));
        assert_eq!(
            book.fresh(29, std::slice::from_ref(&w)),
            Vec::<String>::new()
        );
        assert_eq!(book.fresh(30, &[w]), ["w"]);
    }

    #[test]
    fn what_cannot_be_read_is_neither_cleared_nor_shown() {
        let mut book = Book::new();
        let w = Finding {
            scopes: vec!["machine:hp".into()],
            ..waiting()
        };
        book.at(0, std::slice::from_ref(&w));
        assert_eq!(book.fresh(10, std::slice::from_ref(&w)), ["w"]);
        book.unread.insert("machine:hp".into());
        assert_eq!(book.at(11, &[]).open, vec![]);
        book.at(100, &[]);
        assert!(book.entries.contains_key("w"));
        book.unread.clear();
        assert_eq!(book.fresh(101, &[w]), Vec::<String>::new());
    }

    #[test]
    fn switching_a_check_off_forgets_it() {
        let mut book = Book::new();
        let w = [waiting()];
        book.at(0, &w);
        assert_eq!(book.fresh(10, &w), ["w"]);
        book.settings.run_waiting = false;
        assert_eq!(book.at(11, &[]), Outcome::default());
        assert!(book.entries.is_empty());
    }

    #[test]
    fn a_higher_threshold_hides_it_without_notifying_again() {
        let mut book = Book::new();
        let w = [waiting()];
        book.at(0, &w);
        assert_eq!(book.fresh(10, &w), ["w"]);
        book.settings.run_waiting_minutes = 20;
        assert_eq!(book.at(11, &w), Outcome::default());
        let back = book.at(20, &w);
        assert_eq!(back.fresh, vec![]);
        assert_eq!(back.open.len(), 1);
    }

    fn quiet_facts() -> Facts {
        Facts {
            runs: vec![],
            step_minutes: 120,
            view: StateView {
                agents: vec![],
                default_agent: "claude".into(),
                machines: vec![],
                folders: vec![],
                sessions: vec![],
                ended: vec![],
                host_terminal: HostTerminal::None,
                mesh: None,
                server: None,
                proposals: 0,
            },
            screens: BTreeMap::new(),
            pulls: vec![],
            unread_pulls: vec![],
            triggers: vec![FailingTrigger {
                id: "t".into(),
                title: "Trigger t keeps failing".into(),
                problem: "no".into(),
                link: "/settings#triggers".into(),
                failed_once_at: None,
            }],
        }
    }

    #[test]
    fn a_restart_remembers_what_was_already_told() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state").join("health.json");
        let settings = HealthChecks::default();
        let facts = quiet_facts();
        let minute = |m: i64| at(0) + Duration::minutes(m);

        let mut first = Ledger::load(file.clone());
        assert_eq!(first.round(&facts, &settings, minute(0)).open, vec![]);
        assert_eq!(first.round(&facts, &settings, minute(60)).fresh.len(), 1);

        let mut second = Ledger::load(file.clone());
        let again = second.round(&facts, &settings, minute(61));
        assert_eq!(again.fresh, vec![]);
        assert_eq!(again.open.len(), 1);

        let none = Facts {
            triggers: vec![],
            ..quiet_facts()
        };
        second.round(&none, &settings, minute(62));
        let mut third = Ledger::load(file.clone());
        third.round(&none, &settings, minute(67));
        assert!(third.entries.is_empty());

        let mut fourth = Ledger::load(file);
        fourth.round(&facts, &settings, minute(68));
        assert_eq!(fourth.round(&facts, &settings, minute(128)).fresh.len(), 1);
    }

    fn failed_once_at_facts(at_time: DateTime<Local>) -> Facts {
        let mut facts = quiet_facts();
        facts.triggers[0].failed_once_at = Some(at_time);
        facts
    }

    #[test]
    fn a_failed_once_at_notifies_once_then_never_reopens_after_a_day() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let settings = HealthChecks::default();
        let facts = failed_once_at_facts(at(0));
        let hour = |h: i64, m: i64| at(0) + Duration::hours(h) + Duration::minutes(m);

        let mut ledger = Ledger::load(file.clone());
        assert_eq!(ledger.round(&facts, &settings, at(0)).open, vec![]);
        assert_eq!(ledger.round(&facts, &settings, hour(1, 0)).fresh.len(), 1);
        let late = ledger.round(&facts, &settings, hour(23, 59));
        assert_eq!((late.open.len(), late.fresh.len()), (1, 0));

        assert_eq!(
            ledger.round(&facts, &settings, hour(24, 0)),
            Outcome::default(),
            "it stops showing at once"
        );

        let mut restarted = Ledger::load(file.clone());
        assert_eq!(
            restarted.round(&facts, &settings, hour(24, 3)),
            Outcome::default()
        );
        assert_eq!(
            restarted.round(&facts, &settings, hour(24, 5)),
            Outcome::default()
        );
        assert!(restarted.entries.is_empty(), "the 5 minute rule closed it");

        let mut again = Ledger::load(file);
        assert!(again.entries.is_empty(), "health.json holds nothing of it");
        for h in [25, 26, 200] {
            assert_eq!(
                again.round(&facts, &settings, hour(h, 0)),
                Outcome::default(),
                "the same failed start at hour {h}"
            );
        }
        assert!(again.entries.is_empty());
    }

    #[test]
    fn a_restart_after_the_day_ends_tells_nothing_about_that_start() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let settings = HealthChecks::default();
        let facts = failed_once_at_facts(at(0));
        let mut ledger = Ledger::load(file.clone());
        ledger.round(&facts, &settings, at(0));
        ledger.round(&facts, &settings, at(0) + Duration::hours(1));
        let mut back = Ledger::load(file);
        let after = at(0) + Duration::hours(30);
        assert_eq!(back.round(&facts, &settings, after), Outcome::default());
        assert_eq!(
            back.round(&facts, &settings, after + Duration::minutes(5)),
            Outcome::default()
        );
        assert!(back.entries.is_empty());
    }

    #[test]
    fn a_new_failed_once_at_after_the_day_is_a_new_problem() {
        let dir = tempfile::tempdir().unwrap();
        let settings = HealthChecks::default();
        let mut ledger = Ledger::load(dir.path().join("health.json"));
        let week = at(0) + Duration::days(7);
        let first = failed_once_at_facts(at(0));
        ledger.round(&first, &settings, at(0));
        assert_eq!(
            ledger
                .round(&first, &settings, at(0) + Duration::hours(1))
                .fresh
                .len(),
            1
        );
        ledger.round(&first, &settings, at(0) + Duration::hours(24));
        ledger.round(&first, &settings, at(0) + Duration::hours(25));
        let next = failed_once_at_facts(week);
        ledger.round(&next, &settings, week);
        assert_eq!(
            ledger
                .round(&next, &settings, week + Duration::hours(1))
                .fresh
                .len(),
            1
        );
    }

    fn read_facts(kept: Kept) -> Facts {
        let def = crate::pipeline::templates::all().remove(0);
        let triggers = pipeline_failing(&def, kept).into_iter().collect();
        Facts {
            triggers,
            ..quiet_facts()
        }
    }

    fn failed_read(at_time: DateTime<Local>) -> Kept {
        Kept {
            problem: "the server said no".into(),
            problem_at: at_time.to_rfc3339(),
            ..Kept::default()
        }
    }

    #[test]
    fn one_failed_scheduled_read_tells_once_and_never_reopens_after_a_day() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let settings = HealthChecks::default();
        let facts = read_facts(failed_read(at(0)));
        let hour = |h: i64, m: i64| at(0) + Duration::hours(h) + Duration::minutes(m);

        let mut ledger = Ledger::load(file.clone());
        ledger.round(&facts, &settings, at(0));
        assert_eq!(ledger.round(&facts, &settings, hour(1, 0)).fresh.len(), 1);
        let late = ledger.round(&facts, &settings, hour(23, 59));
        assert_eq!((late.open.len(), late.fresh.len()), (1, 0));
        assert_eq!(
            ledger.round(&facts, &settings, hour(24, 0)),
            Outcome::default()
        );

        let mut restarted = Ledger::load(file.clone());
        assert_eq!(
            restarted.round(&facts, &settings, hour(24, 5)),
            Outcome::default()
        );
        assert!(restarted.entries.is_empty());
        let mut again = Ledger::load(file);
        for h in [25, 26, 167] {
            assert_eq!(
                again.round(&facts, &settings, hour(h, 0)),
                Outcome::default(),
                "the same read at hour {h}"
            );
        }
    }

    #[test]
    fn the_next_scheduled_read_failing_is_a_new_problem() {
        let dir = tempfile::tempdir().unwrap();
        let settings = HealthChecks::default();
        let mut ledger = Ledger::load(dir.path().join("health.json"));
        let first = read_facts(failed_read(at(0)));
        ledger.round(&first, &settings, at(0));
        let told = ledger.round(&first, &settings, at(0) + Duration::hours(1));
        assert_eq!(told.fresh.len(), 1);
        ledger.round(&first, &settings, at(0) + Duration::hours(24));
        ledger.round(&first, &settings, at(0) + Duration::hours(25));

        let week = at(0) + Duration::days(7);
        let next = read_facts(failed_read(week));
        assert_eq!(ledger.round(&next, &settings, week), Outcome::default());
        let told = ledger.round(&next, &settings, week + Duration::hours(1));
        assert_eq!(told.fresh.len(), 1);
    }

    #[test]
    fn an_hourly_schedule_stays_open_while_it_keeps_failing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let settings = HealthChecks::default();
        let mut ledger = Ledger::load(file.clone());
        let mut told = 0;
        let mut last = at(0);
        for h in 0..=72 {
            last = at(0) + Duration::hours(h);
            let outcome = ledger.round(&read_facts(failed_read(last)), &settings, last);
            told += outcome.fresh.len();
            assert_eq!(outcome.open.len(), usize::from(h >= 1), "hour {h}");
        }
        assert_eq!(told, 1, "three days of failures tell once");

        let stopped = read_facts(failed_read(last));
        let mut restarted = Ledger::load(file);
        let day = last + Duration::hours(23);
        assert_eq!(restarted.round(&stopped, &settings, day).open.len(), 1);
        let after = last + Duration::hours(24);
        assert_eq!(
            restarted.round(&stopped, &settings, after),
            Outcome::default()
        );
    }

    #[test]
    fn a_daily_schedule_that_keeps_failing_is_one_problem() {
        let dir = tempfile::tempdir().unwrap();
        let settings = HealthChecks::default();
        let mut ledger = Ledger::load(dir.path().join("health.json"));
        let mut told = 0;
        for day in 0..5 {
            let read = at(0) + Duration::days(day) + Duration::seconds(10 * day);
            let facts = read_facts(failed_read(read));
            told += ledger.round(&facts, &settings, read).fresh.len();
            told += ledger
                .round(&facts, &settings, read + Duration::hours(1))
                .fresh
                .len();
            let end = read + Duration::hours(24);
            told += ledger.round(&facts, &settings, end).fresh.len();
        }
        assert_eq!(told, 1);
    }

    #[test]
    fn a_good_read_clears_it_at_once_and_a_retrying_trigger_has_no_end() {
        let dir = tempfile::tempdir().unwrap();
        let settings = HealthChecks::default();
        let mut ledger = Ledger::load(dir.path().join("health.json"));
        let failing = read_facts(failed_read(at(0)));
        ledger.round(&failing, &settings, at(0));
        assert_eq!(
            ledger
                .round(&failing, &settings, at(0) + Duration::hours(1))
                .open
                .len(),
            1
        );
        let cleared = read_facts(Kept::default());
        assert_eq!(
            ledger.round(&cleared, &settings, at(0) + Duration::minutes(61)),
            Outcome::default()
        );

        let retrying = read_facts(Kept {
            problem: "no".into(),
            ..Kept::default()
        });
        let mut other = Ledger::load(dir.path().join("other.json"));
        other.round(&retrying, &settings, at(0));
        assert_eq!(
            other
                .round(&retrying, &settings, at(0) + Duration::hours(1))
                .fresh
                .len(),
            1
        );
        let week = other.round(&retrying, &settings, at(0) + Duration::days(7));
        assert_eq!((week.open.len(), week.fresh.len()), (1, 0));
    }

    #[test]
    fn a_failing_check_stays_open_past_the_day_and_tells_once() {
        let dir = tempfile::tempdir().unwrap();
        let settings = HealthChecks::default();
        let facts = quiet_facts();
        let mut ledger = Ledger::load(dir.path().join("health.json"));
        ledger.round(&facts, &settings, at(0));
        assert_eq!(
            ledger
                .round(&facts, &settings, at(0) + Duration::hours(1))
                .fresh
                .len(),
            1
        );
        let week = ledger.round(&facts, &settings, at(0) + Duration::days(7));
        assert_eq!((week.open.len(), week.fresh.len()), (1, 0));
    }

    #[test]
    fn a_restart_counts_the_time_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let settings = HealthChecks::default();
        let facts = quiet_facts();
        Ledger::load(file.clone()).round(&facts, &settings, at(0));
        let mut after = Ledger::load(file);
        let told = after.round(&facts, &settings, at(0) + Duration::minutes(60));
        assert_eq!(told.fresh.len(), 1);
    }

    #[test]
    fn an_unreadable_file_starts_afresh_and_doctor_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        std::fs::write(&file, "not json").unwrap();
        assert!(Ledger::load(file).entries.is_empty());
        let cfg = crate::config::Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        let lines = doctor_lines(&cfg, dir.path());
        assert_eq!(lines.len(), 1);
        assert!(!lines[0].0);
        assert!(lines[0].1.contains("cannot be read"), "{}", lines[0].1);
    }

    #[test]
    fn doctor_names_what_was_told_and_is_still_open() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let settings = HealthChecks::default();
        let facts = quiet_facts();
        let mut ledger = Ledger::load(file);
        ledger.round(&facts, &settings, at(0));
        let cfg = crate::config::Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        assert_eq!(
            doctor_lines(&cfg, dir.path()),
            [(true, "health checks: 6 of 6 on".to_string())]
        );
        ledger.round(&facts, &settings, at(0) + Duration::minutes(60));
        assert_eq!(
            doctor_lines(&cfg, dir.path())[1],
            (false, "Trigger t keeps failing: no".to_string())
        );
    }

    fn problem(key: &str, link: &str) -> Problem {
        Problem {
            check: Check::CiPending,
            key: key.into(),
            title: format!("{key} title"),
            detail: "Fix it".into(),
            link: link.into(),
            since: at(0).to_rfc3339(),
        }
    }

    #[test]
    fn a_push_says_how_long_and_links_to_the_problem() {
        let base = Some("http://100.64.0.10:4000");
        let pushed = pushes(
            &[problem("a", "/pipeline?p=x")],
            base,
            at(0) + Duration::minutes(150),
        );
        assert_eq!(
            pushed,
            [Push {
                title: "a title".into(),
                message: "Fix it (2 h)".into(),
                tags: vec!["warning".into()],
                priority: 3,
                click: Some("http://100.64.0.10:4000/pipeline?p=x".into()),
            }]
        );
        let outside = "https://github.com/a/b/pull/1";
        let pushed = pushes(&[problem("a", outside)], None, at(45));
        assert_eq!(pushed[0].click.as_deref(), Some(outside));
        assert_eq!(pushed[0].message, "Fix it (45 min)");
        assert_eq!(pushes(&[problem("a", "/x")], None, at(1))[0].click, None);
    }

    #[test]
    fn many_at_once_become_one_push() {
        let many: Vec<Problem> = (0..4).map(|i| problem(&i.to_string(), "/x")).collect();
        let pushed = pushes(&many, Some("http://b"), at(5));
        assert_eq!(pushed.len(), 1);
        assert_eq!(pushed[0].message, "4 new problems, see the dashboard");
        assert_eq!(pushed[0].click.as_deref(), Some("http://b/"));
        assert_eq!(pushes(&many[..3], Some("http://b"), at(5)).len(), 3);
    }
}
