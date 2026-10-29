use super::legacy::{Finding, Record, Seen, Stage};
use super::legacy_prompts as prompts;
use crate::dispatch::parse_result;
use crate::snapshot::Activity;
use crate::state::StateView;
use chrono::{DateTime, Local};
use serde_json::Value;

// A session may take this long to show up after it was started, or to print its result after it
// goes quiet.
const GRACE_MINUTES: i64 = 2;

fn stamp(text: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.with_timezone(&Local))
}

fn settled(r: &Record, now: DateTime<Local>) -> bool {
    stamp(&r.stage_since).is_some_and(|since| (now - since).num_minutes() >= GRACE_MINUTES)
}

fn reviewed(r: &Record, reviews: &[Value]) -> Option<Seen> {
    let since = stamp(&r.stage_since)?;
    let review = reviews.iter().rev().find(|e| {
        e["role"] == "review"
            && e["of"]["name"] == r.sessions.implement.as_str()
            && e["at"]
                .as_str()
                .and_then(stamp)
                .is_some_and(|at| at > since)
    })?;
    let text = |f: &Value, key: &str| f[key].as_str().unwrap_or_default().to_string();
    let findings = review["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| Finding {
            severity: text(f, "severity"),
            place: text(f, "place"),
            text: text(f, "text"),
        })
        .collect();
    Some(Seen::Reviewed { findings })
}

// What the poll shows about one ticket's current stage, if anything new.
pub fn seen(
    r: &Record,
    view: &StateView,
    screen: Option<&str>,
    reviews: &[Value],
    now: DateTime<Local>,
) -> Option<Seen> {
    let name = match r.stage {
        Stage::Queued if !r.machine.is_empty() => {
            return view
                .machines
                .iter()
                .any(|m| m.name == r.machine && !m.up)
                .then_some(Seen::Offline);
        }
        Stage::Implement | Stage::Fix => &r.sessions.implement,
        Stage::Qa => &r.sessions.qa,
        Stage::Review => return reviewed(r, reviews),
        _ => return None,
    };
    if name.is_empty() {
        return None;
    }
    let screen = screen.unwrap_or_default();
    let Some(session) = view
        .sessions
        .iter()
        .find(|s| s.tmux.as_deref() == Some(name.as_str()))
    else {
        return settled(r, now).then(|| Seen::NoResult(screen.to_string()));
    };
    match session.activity {
        Activity::Active => None,
        Activity::Blocked => Some(Seen::Waiting(screen.to_string())),
        Activity::Idle => match parse_result(screen) {
            Some(outcome) if r.stage == Stage::Fix && outcome.summary == r.outcome => {
                settled(r, now).then(|| Seen::NoResult(screen.to_string()))
            }
            Some(outcome) => Some(Seen::Idle {
                outcome,
                verdict: (r.stage == Stage::Qa)
                    .then(|| prompts::verdict(screen))
                    .flatten(),
            }),
            None => settled(r, now).then(|| Seen::NoResult(screen.to_string())),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::legacy_engine::tests::{at, record};
    use crate::snapshot::Activity;
    use crate::state::{MachineView, SessionView};
    use serde_json::json;

    fn view(sessions: &[(&str, Activity)], up: bool) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: vec![MachineView {
                name: "hp".into(),
                up,
                reason: None,
                last_seen: None,
                local: false,
                health: None,
                accounts: Vec::new(),
                mesh_on: None,
            }],
            folders: vec![],
            sessions: sessions
                .iter()
                .map(|(name, activity)| SessionView {
                    id: name.to_string(),
                    machine: "hp".into(),
                    agent: "claude".into(),
                    pid: 1,
                    folder: "app".into(),
                    ticket: "-".into(),
                    branch: "com-1-fix".into(),
                    activity: *activity,
                    attachable: true,
                    tmux: Some(name.to_string()),
                    stale: false,
                    ports: vec![],
                    pull: None,
                    path: "/r/app".into(),
                    worktree: true,
                    setup: None,
                })
                .collect(),
            ended: vec![],
            host_terminal: crate::config::HostTerminal::None,
            mesh: None,
            server: None,
        }
    }

    const RESULT: &str = "● Done.\n\nYARDBELL RESULT\nstatus: done\nsummary: Fixed the redirect.\nbranch: com-1-fix\n- 12 passed\nEND RESULT\n";

    fn working(stage: Stage) -> Record {
        let mut r = record(stage);
        r.sessions.implement = "hp-app-com-1".into();
        r.sessions.qa = "devbox-app-com-1".into();
        r
    }

    #[test]
    fn an_idle_implementer_with_a_result() {
        let r = working(Stage::Implement);
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        match seen(&r, &v, Some(RESULT), &[], at(1)) {
            Some(Seen::Idle { outcome, verdict }) => {
                assert_eq!(outcome.status, "done");
                assert_eq!(outcome.summary, "Fixed the redirect.");
                assert_eq!(verdict, None);
            }
            other => panic!("{other:?}"),
        }
        let busy = view(&[("hp-app-com-1", Activity::Active)], true);
        assert_eq!(seen(&r, &busy, Some(RESULT), &[], at(1)), None);
    }

    #[test]
    fn a_screen_showing_the_task_gives_nothing() {
        let r = working(Stage::Implement);
        let task = crate::pipeline::legacy_prompts::implement(&r, &Default::default());
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        assert_eq!(seen(&r, &v, Some(&task), &[], at(1)), None);
        assert_eq!(
            seen(&r, &v, Some(&task), &[], at(3)),
            Some(Seen::NoResult(task.clone()))
        );
    }

    #[test]
    fn a_fix_ignores_the_result_it_already_had() {
        let mut r = working(Stage::Fix);
        r.outcome = "Fixed the redirect.".into();
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        assert_eq!(seen(&r, &v, Some(RESULT), &[], at(1)), None);
        let fixed = RESULT.replace("Fixed the redirect.", "Fixed both findings.");
        assert!(matches!(
            seen(&r, &v, Some(&fixed), &[], at(1)),
            Some(Seen::Idle { .. })
        ));
    }

    #[test]
    fn a_blocked_session_is_waiting() {
        let r = working(Stage::Implement);
        let v = view(&[("hp-app-com-1", Activity::Blocked)], true);
        assert_eq!(
            seen(&r, &v, Some("Allow?"), &[], at(1)),
            Some(Seen::Waiting("Allow?".into()))
        );
    }

    #[test]
    fn a_missing_session_waits_two_minutes() {
        let r = working(Stage::Implement);
        let v = view(&[], true);
        assert_eq!(seen(&r, &v, None, &[], at(1)), None);
        assert_eq!(
            seen(&r, &v, None, &[], at(3)),
            Some(Seen::NoResult(String::new()))
        );
        let starting = record(Stage::Implement);
        assert_eq!(seen(&starting, &v, None, &[], at(9)), None);
    }

    #[test]
    fn the_newest_review_for_the_implementer() {
        let mut r = working(Stage::Review);
        r.stage_since = at(10).to_rfc3339();
        let review = |minute: u32, name: &str, text: &str| {
            json!({"role": "review", "of": {"machine": "hp", "name": name}, "at": at(minute).to_rfc3339(),
                   "verdict": "changes", "findings": [{"severity": "high", "place": "a.rs:1", "text": text}]})
        };
        let v = view(&[], true);
        let old = [review(5, "hp-app-com-1", "old")];
        assert_eq!(seen(&r, &v, None, &old, at(11)), None);
        let reviews = [
            review(5, "hp-app-com-1", "old"),
            review(12, "other", "not ours"),
            review(13, "hp-app-com-1", "new"),
        ];
        match seen(&r, &v, None, &reviews, at(14)) {
            Some(Seen::Reviewed { findings }) => {
                assert_eq!(findings.len(), 1);
                assert_eq!(findings[0].text, "new");
                assert_eq!(findings[0].severity, "high");
                assert_eq!(findings[0].place, "a.rs:1");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn qa_reads_its_verdict() {
        let r = working(Stage::Qa);
        let mut v = view(&[("devbox-app-com-1", Activity::Idle)], true);
        v.sessions[0].machine = "devbox".into();
        let screen = RESULT.replace("- 12 passed", "verdict: pass\n- 12 passed");
        assert!(matches!(
            seen(&r, &v, Some(&screen), &[], at(1)),
            Some(Seen::Idle {
                verdict: Some(true),
                ..
            })
        ));
    }

    #[test]
    fn an_offline_machine() {
        let mut r = record(Stage::Queued);
        r.machine = "hp".into();
        assert_eq!(
            seen(&r, &view(&[], false), None, &[], at(1)),
            Some(Seen::Offline)
        );
        assert_eq!(seen(&r, &view(&[], true), None, &[], at(1)), None);
    }
}
