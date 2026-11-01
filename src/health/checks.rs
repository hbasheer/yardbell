use crate::config::HealthChecks;
use crate::pipeline::definition::StepKind;
use crate::pipeline::record::{Run, RunState};
use crate::pulls::{Ci, Key, PullView};
use crate::state::StateView;
use chrono::{DateTime, Duration, Local};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const MEMORY_PERCENT: u64 = 90;
const DETAIL_CHARS: usize = 200;
pub const FAILED_ONCE_HOURS: i64 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Check {
    RunQueued,
    RunWaiting,
    StepQuiet,
    CiPending,
    TriggerFailing,
    MemoryShort,
}

impl Check {
    pub const ALL: [Check; 6] = [
        Check::RunQueued,
        Check::RunWaiting,
        Check::StepQuiet,
        Check::CiPending,
        Check::TriggerFailing,
        Check::MemoryShort,
    ];

    pub fn setting(self, settings: &HealthChecks) -> (bool, u64) {
        match self {
            Check::RunQueued => (settings.run_queued, settings.run_queued_minutes),
            Check::RunWaiting => (settings.run_waiting, settings.run_waiting_minutes),
            Check::StepQuiet => (settings.step_quiet, settings.step_quiet_minutes),
            Check::CiPending => (settings.ci_pending, settings.ci_pending_minutes),
            Check::TriggerFailing => (settings.trigger_failing, settings.trigger_failing_minutes),
            Check::MemoryShort => (settings.memory_short, settings.memory_short_minutes),
        }
    }
}

// Something that would be a problem if it lasts. The ledger decides whether it has lasted.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub key: String,
    pub check: Check,
    pub title: String,
    pub detail: String,
    pub link: String,
    // Left empty when the data does not say; the ledger then counts from when it first saw it.
    pub since: Option<DateTime<Local>>,
    pub not_before: Option<DateTime<Local>>,
    // A different mark means the old problem ended and a new one started.
    pub mark: String,
    // While one of these cannot be read, what is known about this finding stays as it is.
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FailingTrigger {
    pub id: String,
    pub title: String,
    pub problem: String,
    pub link: String,
    // Set when a failure stands until the next scheduled try, not a check that retries by itself.
    // A weekly trigger would otherwise stay a problem for the whole week.
    pub failed_once_at: Option<DateTime<Local>>,
}

pub struct Facts {
    pub runs: Vec<Run>,
    pub step_minutes: u64,
    pub view: StateView,
    pub screens: BTreeMap<String, String>,
    pub pulls: Vec<(Key, PullView)>,
    pub unread_pulls: Vec<Key>,
    pub triggers: Vec<FailingTrigger>,
}

fn time(text: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&Local))
}

fn machine_scope(machine: &str) -> String {
    format!("machine:{machine}")
}

fn pull_scope(key: &Key) -> String {
    format!("pull:{}:{}:{}", key.0, key.1, key.2)
}

fn run_link(run: &Run) -> String {
    crate::pipeline::run::run_link("", run)
}

fn clip(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= DETAIL_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(DETAIL_CHARS).collect();
    cut.push('…');
    cut
}

pub fn run_queued(runs: &[Run]) -> Vec<Finding> {
    runs.iter()
        .filter(|run| run.state == RunState::Queued)
        .map(|run| {
            let machine = run.slot.clone().unwrap_or_default();
            Finding {
                key: format!("run_queued:{}:{}", run.id, run.step),
                check: Check::RunQueued,
                title: format!("{} is still queued", run.subject.label()),
                detail: format!("{}: no free slot on {machine}", run.pipeline_name),
                link: run_link(run),
                since: time(&run.step_since),
                not_before: None,
                mark: String::new(),
                scopes: vec![machine_scope(&machine)],
            }
        })
        .collect()
}

pub fn run_waiting(runs: &[Run]) -> Vec<Finding> {
    runs.iter()
        .filter(|run| run.state == RunState::Waiting)
        .filter_map(|run| {
            let waiting = run.waiting.as_ref()?;
            Some(Finding {
                key: format!("run_waiting:{}:{}:{:?}", run.id, waiting.step, waiting.kind),
                check: Check::RunWaiting,
                title: format!("{} is still waiting for you", run.subject.label()),
                detail: clip(&format!("{}: {}", run.pipeline_name, waiting.reason)),
                link: run_link(run),
                since: None,
                not_before: None,
                mark: String::new(),
                scopes: Vec::new(),
            })
        })
        .collect()
}

// A step's own limit stops it anyway, so this only speaks in the last quarter of its minutes.
pub fn step_quiet(
    runs: &[Run],
    view: &StateView,
    screens: &BTreeMap<String, String>,
    step_minutes: u64,
) -> Vec<Finding> {
    runs.iter()
        .filter(|run| run.state == RunState::Running)
        .filter_map(|run| {
            let step = run.definition.as_ref()?.step(&run.step)?;
            if !matches!(step.kind, StepKind::Agent { .. }) {
                return None;
            }
            let name = run.steps.get(&run.step)?.session.as_str();
            let session = view
                .sessions
                .iter()
                .find(|s| !s.stale && !name.is_empty() && s.tmux.as_deref() == Some(name))?;
            let limit = step.minutes.unwrap_or(step_minutes) as i64;
            Some(Finding {
                key: format!("step_quiet:{}:{}", run.id, run.step),
                check: Check::StepQuiet,
                title: format!("{} looks stuck on {}", step.name, run.subject.label()),
                detail: format!(
                    "Its screen has stopped changing, and it stops at its limit of {limit} minutes"
                ),
                link: run_link(run),
                since: None,
                not_before: Some(time(&run.step_since)? + Duration::seconds(limit * 45)),
                mark: screens.get(&session.id)?.clone(),
                scopes: vec![machine_scope(&session.machine)],
            })
        })
        .collect()
}

pub fn ci_pending(pulls: &[(Key, PullView)]) -> Vec<Finding> {
    let mut urls = HashSet::new();
    pulls
        .iter()
        .filter(|(_, pull)| pull.ci == Ci::Pending && pull.state == "open")
        .filter(|(_, pull)| urls.insert(pull.url.as_str()))
        .map(|(key, pull)| {
            let (kind, sign) = match pull.forge.as_str() {
                "gitlab" => ("merge request", '!'),
                _ => ("pull request", '#'),
            };
            Finding {
                key: format!("ci_pending:{}", pull.url),
                check: Check::CiPending,
                title: format!("CI is still pending on {kind} {sign}{}", pull.number),
                detail: clip(&pull.title),
                link: pull.url.clone(),
                since: None,
                not_before: None,
                mark: pull.head.clone(),
                scopes: vec![machine_scope(&key.0), pull_scope(key)],
            }
        })
        .collect()
}

pub fn trigger_failing(triggers: &[FailingTrigger], now: DateTime<Local>) -> Vec<Finding> {
    triggers
        .iter()
        .filter(|trigger| {
            trigger
                .failed_once_at
                .is_none_or(|at| now - at < Duration::hours(FAILED_ONCE_HOURS))
        })
        .map(|trigger| Finding {
            key: format!("trigger_failing:{}", trigger.id),
            check: Check::TriggerFailing,
            title: trigger.title.clone(),
            detail: clip(&trigger.problem),
            link: trigger.link.clone(),
            since: None,
            not_before: None,
            mark: String::new(),
            scopes: Vec::new(),
        })
        .collect()
}

pub fn memory_short(view: &StateView) -> Vec<Finding> {
    view.machines
        .iter()
        .filter(|m| m.up)
        .filter_map(|m| {
            let percent = m.health?.pressure().filter(|p| *p >= MEMORY_PERCENT)?;
            Some(Finding {
                key: format!("memory_short:{}", m.name),
                check: Check::MemoryShort,
                title: format!("{} has stayed short of memory", m.name),
                detail: format!("Memory is at {percent}%"),
                link: format!("/?machine={}", m.name),
                since: None,
                not_before: None,
                mark: String::new(),
                scopes: vec![machine_scope(&m.name)],
            })
        })
        .collect()
}

pub fn findings(facts: &Facts, settings: &HealthChecks, now: DateTime<Local>) -> Vec<Finding> {
    Check::ALL
        .into_iter()
        .filter(|check| check.setting(settings).0)
        .flat_map(|check| match check {
            Check::RunQueued => run_queued(&facts.runs),
            Check::RunWaiting => run_waiting(&facts.runs),
            Check::StepQuiet => {
                step_quiet(&facts.runs, &facts.view, &facts.screens, facts.step_minutes)
            }
            Check::CiPending => ci_pending(&facts.pulls),
            Check::TriggerFailing => trigger_failing(&facts.triggers, now),
            Check::MemoryShort => memory_short(&facts.view),
        })
        .collect()
}

pub fn unread_scopes(facts: &Facts) -> HashSet<String> {
    facts
        .view
        .machines
        .iter()
        .filter(|m| !m.up)
        .map(|m| machine_scope(&m.name))
        .chain(facts.unread_pulls.iter().map(pull_scope))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostTerminal;
    use crate::pipeline::engine::tests::{at, run_of};
    use crate::pipeline::record::{WaitKind, Waiting};
    use crate::snapshot::{Activity, Health};
    use crate::state::{MachineView, SessionView};

    fn machine(name: &str, up: bool, percent: u64) -> MachineView {
        MachineView {
            name: name.into(),
            up,
            reason: None,
            last_seen: None,
            local: false,
            health: Some(Health {
                mem_total_kb: 1000,
                mem_used_kb: percent * 10,
                agent_kb: 0,
                user_kb: 0,
                limit_kb: 0,
                limit_used_kb: 0,
                load1: 0.0,
                cpus: 4,
                disk_total_kb: 0,
                disk_used_kb: 0,
            }),
            accounts: Vec::new(),
            mesh_on: None,
        }
    }

    fn session(name: &str, stale: bool) -> SessionView {
        SessionView {
            pull_why: None,
            id: format!("hp:{name}"),
            machine: "hp".into(),
            agent: "claude".into(),
            pid: 1,
            folder: "app".into(),
            ticket: "-".into(),
            branch: "com-1".into(),
            activity: Activity::Active,
            attachable: true,
            tmux: Some(name.into()),
            stale,
            ports: vec![],
            pull: None,
            path: "/r/app".into(),
            worktree: true,
            setup: None,
        }
    }

    fn view(machines: Vec<MachineView>, sessions: Vec<SessionView>) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines,
            folders: vec![],
            sessions,
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
            server: None,
            proposals: 0,
        }
    }

    fn run(state: RunState) -> Run {
        let mut run = run_of("Implement my tickets");
        run.state = state;
        run.step = "implement".into();
        run.step_since = at(0).to_rfc3339();
        run.slot = Some("hp".into());
        run
    }

    fn running() -> Run {
        let mut run = run(RunState::Running);
        run.state_of("implement").session = "s1".into();
        run
    }

    fn pull(number: u64, ci: Ci, state: &str, head: &str) -> (Key, PullView) {
        (
            ("hp".into(), "/r/app".into(), format!("b{number}")),
            PullView {
                forge: "github".into(),
                number,
                url: format!("https://github.com/a/b/pull/{number}"),
                title: "Fix it".into(),
                state: state.into(),
                draft: false,
                review: String::new(),
                ci,
                failed: vec![],
                head: head.into(),
            },
        )
    }

    #[test]
    fn a_queued_run_counts_from_when_it_was_queued() {
        let found = run_queued(&[
            run(RunState::Queued),
            run(RunState::Running),
            run(RunState::Done),
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].since, Some(at(0)));
        assert_eq!(found[0].title, "COM-1 Fix the login is still queued");
        assert_eq!(found[0].scopes, ["machine:hp"]);
        assert!(found[0].link.starts_with("/pipeline?p="));
    }

    #[test]
    fn a_waiting_run_is_a_new_problem_at_each_step_and_kind() {
        let mut first = run(RunState::Waiting);
        first.waiting = Some(Waiting {
            kind: WaitKind::NeedsYou,
            step: "implement".into(),
            reason: "Implement needs you".into(),
            screen: String::new(),
            tool_hash: String::new(),
        });
        let mut second = first.clone();
        second.waiting.as_mut().unwrap().kind = WaitKind::TimeLimit;
        let found = run_waiting(&[first.clone(), run(RunState::Queued)]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].since, None);
        assert!(found[0].detail.ends_with("Implement needs you"));
        assert_ne!(found[0].key, run_waiting(&[second])[0].key);
    }

    #[test]
    fn a_quiet_step_speaks_in_the_last_quarter_of_its_minutes() {
        let v = view(vec![machine("hp", true, 10)], vec![session("s1", false)]);
        let screens = BTreeMap::from([("hp:s1".to_string(), "abc".to_string())]);
        let found = step_quiet(&[running()], &v, &screens, 120);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].mark, "abc");
        assert_eq!(found[0].not_before, Some(at(0) + Duration::minutes(90)));
        assert_eq!(found[0].scopes, ["machine:hp"]);
    }

    #[test]
    fn a_step_with_its_own_minutes_uses_them() {
        let mut one = running();
        let def = one.definition.as_mut().unwrap();
        let step = def.steps.iter_mut().find(|s| s.id == "implement").unwrap();
        step.minutes = Some(40);
        let v = view(vec![], vec![session("s1", false)]);
        let screens = BTreeMap::from([("hp:s1".to_string(), "abc".to_string())]);
        let found = step_quiet(&[one], &v, &screens, 120);
        assert_eq!(found[0].not_before, Some(at(0) + Duration::minutes(30)));
    }

    #[test]
    fn no_session_or_no_screen_says_nothing_about_a_step() {
        let screens = BTreeMap::from([("hp:s1".to_string(), "abc".to_string())]);
        let gone = view(vec![], vec![]);
        assert_eq!(step_quiet(&[running()], &gone, &screens, 120), vec![]);
        let stale = view(vec![], vec![session("s1", true)]);
        assert_eq!(step_quiet(&[running()], &stale, &screens, 120), vec![]);
        let live = view(vec![], vec![session("s1", false)]);
        assert_eq!(
            step_quiet(&[running()], &live, &BTreeMap::new(), 120),
            vec![]
        );
        let mut waiting = running();
        waiting.state = RunState::Waiting;
        assert_eq!(step_quiet(&[waiting], &live, &screens, 120), vec![]);
    }

    #[test]
    fn ci_counts_only_an_open_pending_pull_once() {
        let mut twice = pull(1, Ci::Pending, "open", "aaa");
        twice.0 .0 = "pro".into();
        let found = ci_pending(&[
            pull(1, Ci::Pending, "open", "aaa"),
            twice,
            pull(2, Ci::Passing, "open", "bbb"),
            pull(3, Ci::Failing, "open", "ccc"),
            pull(4, Ci::Pending, "merged", "ddd"),
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "CI is still pending on pull request #1");
        assert_eq!(found[0].mark, "aaa");
        assert_eq!(found[0].scopes, ["machine:hp", "pull:hp:/r/app:b1"]);
    }

    #[test]
    fn a_failing_trigger_keeps_its_problem_on_one_line() {
        let found = trigger_failing(
            &[FailingTrigger {
                id: "pipeline:p1".into(),
                title: "The trigger of Review keeps failing".into(),
                problem: format!("the server\nsaid {}", "x".repeat(300)),
                link: "/pipeline?p=p1".into(),
                failed_once_at: None,
            }],
            at(0),
        );
        assert_eq!(found[0].key, "trigger_failing:pipeline:p1");
        assert!(found[0].detail.starts_with("the server said x"));
        assert_eq!(found[0].detail.chars().count(), 201);
    }

    #[test]
    fn one_failed_once_at_stops_counting_after_a_day_and_a_failing_check_does_not() {
        let trigger = |failed_once_at| FailingTrigger {
            id: "trigger:t".into(),
            title: "Trigger t keeps failing".into(),
            problem: "no".into(),
            link: "/settings#triggers".into(),
            failed_once_at,
        };
        let day = Duration::hours(FAILED_ONCE_HOURS);
        let start = [trigger(Some(at(0)))];
        assert_eq!(FAILED_ONCE_HOURS, 24);
        assert_eq!(trigger_failing(&start, at(0)).len(), 1);
        assert_eq!(
            trigger_failing(&start, at(0) + day - Duration::seconds(1)).len(),
            1
        );
        assert_eq!(trigger_failing(&start, at(0) + day), vec![]);
        assert_eq!(trigger_failing(&start, at(0) + day * 7), vec![]);
        assert_eq!(
            trigger_failing(&[trigger(None)], at(0) + day * 7).len(),
            1,
            "a check that keeps failing stays open"
        );
    }

    #[test]
    fn memory_counts_from_ninety_percent_on_a_machine_that_answers() {
        let v = view(
            vec![
                machine("low", true, 89),
                machine("full", true, 90),
                machine("down", false, 99),
            ],
            vec![],
        );
        let found = memory_short(&v);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "memory_short:full");
        assert_eq!(found[0].detail, "Memory is at 90%");
    }

    #[test]
    fn a_switched_off_check_finds_nothing() {
        let facts = Facts {
            runs: vec![run(RunState::Queued)],
            step_minutes: 120,
            view: view(vec![machine("hp", true, 99)], vec![]),
            screens: BTreeMap::new(),
            pulls: vec![pull(1, Ci::Pending, "open", "aaa")],
            unread_pulls: vec![],
            triggers: vec![],
        };
        let on = HealthChecks::default();
        let kinds = |settings: &HealthChecks| -> Vec<Check> {
            findings(&facts, settings, at(0))
                .iter()
                .map(|f| f.check)
                .collect()
        };
        assert_eq!(
            kinds(&on),
            [Check::RunQueued, Check::CiPending, Check::MemoryShort]
        );
        let off = HealthChecks {
            run_queued: false,
            ci_pending: false,
            ..HealthChecks::default()
        };
        assert_eq!(kinds(&off), [Check::MemoryShort]);
    }

    #[test]
    fn a_down_machine_and_an_unread_pull_are_unread_scopes() {
        let (key, _) = pull(1, Ci::Pending, "open", "aaa");
        let facts = Facts {
            runs: vec![],
            step_minutes: 120,
            view: view(
                vec![machine("up", true, 10), machine("down", false, 10)],
                vec![],
            ),
            screens: BTreeMap::new(),
            pulls: vec![],
            unread_pulls: vec![key],
            triggers: vec![],
        };
        assert_eq!(
            unread_scopes(&facts),
            HashSet::from(["machine:down".to_string(), "pull:hp:/r/app:b1".to_string()])
        );
    }
}
