use super::definition::StepKind;
use super::prompts;
use super::record::{Run, RunState, Seen};
use crate::snapshot::Activity;
use crate::state::StateView;
use chrono::{DateTime, Local};

// A session may take this long to show up after it was started, or to print its result after it
// goes quiet.
const GRACE_MINUTES: i64 = 2;

fn settled(run: &Run, now: DateTime<Local>) -> bool {
    DateTime::parse_from_rfc3339(&run.step_since)
        .is_ok_and(|since| (now - since.with_timezone(&Local)).num_minutes() >= GRACE_MINUTES)
}

// What the poll shows about a run's current step, if anything new.
pub fn seen(
    run: &Run,
    view: &StateView,
    screen: Option<&str>,
    now: DateTime<Local>,
) -> Option<Seen> {
    if run.state == RunState::Queued {
        let machine = run.slot.as_deref()?;
        return view
            .machines
            .iter()
            .any(|m| m.name == machine && !m.up)
            .then_some(Seen::Offline);
    }
    if run.state != RunState::Running {
        return None;
    }
    if !matches!(run.def().step(&run.step)?.kind, StepKind::Agent { .. }) {
        return None;
    }
    let name = run
        .steps
        .get(&run.step)
        .map(|s| s.session.as_str())
        .unwrap_or("");
    if name.is_empty() {
        return None;
    }
    let screen = screen.unwrap_or_default();
    let step = run.step.clone();
    let no_result = || {
        settled(run, now).then(|| Seen::NoResult {
            step: step.clone(),
            screen: screen.to_string(),
        })
    };
    let Some(session) = view
        .sessions
        .iter()
        .find(|s| s.tmux.as_deref() == Some(name))
    else {
        return no_result();
    };
    match session.activity {
        Activity::Active => None,
        Activity::Blocked => Some(Seen::Waiting {
            step: step.clone(),
            screen: screen.to_string(),
        }),
        Activity::Idle => match prompts::outcome(screen, &prompts::marker(run, &step)) {
            Some((outcome, report, details)) => Some(Seen::Ended {
                step: step.clone(),
                outcome,
                report,
                details,
            }),
            None => no_result(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::definition::Outcome;
    use crate::pipeline::engine::tests::{at, run_of};
    use crate::pipeline::record::RunState;
    use crate::snapshot::Activity;
    use crate::state::{MachineView, SessionView};

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
                    pull_why: None,
                    id: name.to_string(),
                    machine: "hp".into(),
                    agent: "claude".into(),
                    pid: 1,
                    folder: "app".into(),
                    ticket: "-".into(),
                    branch: "com-1".into(),
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
            proposals: 0,
        }
    }

    const RESULT: &str =
        "YARDBELL RESULT\nstep: implement-1-r1\nstatus: pass\nsummary: Fixed the redirect.\n- 12 passed\nEND RESULT\n";

    fn running(step: &str) -> Run {
        let mut run = run_of("Implement my tickets");
        run.step = step.into();
        run.state = RunState::Running;
        run.step_since = at(0).to_rfc3339();
        run.state_of("implement").session = "hp-app-com-1".into();
        run.state_of(step).session = "hp-app-com-1".into();
        run.state_of(step).runs = 1;
        run
    }

    #[test]
    fn an_idle_agent_with_a_result() {
        let run = running("implement");
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        match seen(&run, &v, Some(RESULT), at(1)) {
            Some(Seen::Ended {
                step,
                outcome,
                report,
                details,
            }) => {
                assert_eq!(
                    (step.as_str(), outcome, report.as_str()),
                    ("implement", Outcome::Pass, "Fixed the redirect.")
                );
                assert_eq!(details, vec!["12 passed"]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            seen(
                &run,
                &view(&[("hp-app-com-1", Activity::Active)], true),
                Some(RESULT),
                at(1)
            ),
            None
        );
    }

    #[test]
    fn a_screen_showing_the_task_gives_nothing() {
        let run = running("implement");
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        let task = "Implement it.\n\nYARDBELL RESULT\nstatus: pass, fail, or needs you\nEND RESULT";
        assert_eq!(seen(&run, &v, Some(task), at(1)), None);
        assert!(matches!(
            seen(&run, &v, Some(task), at(3)),
            Some(Seen::NoResult { .. })
        ));
    }

    #[test]
    fn a_shared_sessions_earlier_result_is_not_this_steps() {
        let run = running("fix");
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        assert_eq!(seen(&run, &v, Some(RESULT), at(1)), None);
        let fixed = RESULT.replace("implement-1-r1", "fix-1-r1");
        assert!(matches!(
            seen(&run, &v, Some(&fixed), at(1)),
            Some(Seen::Ended { .. })
        ));
    }

    #[test]
    fn a_step_run_again_needs_its_new_result() {
        let mut run = running("fix");
        run.state_of("fix").runs = 2;
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        let first = RESULT.replace("implement-1-r1", "fix-1-r1");
        assert_eq!(seen(&run, &v, Some(&first), at(1)), None);
        let second = RESULT.replace("implement-1-r1", "fix-2-r1");
        assert!(matches!(
            seen(&run, &v, Some(&second), at(1)),
            Some(Seen::Ended { .. })
        ));
    }

    #[test]
    fn the_same_words_twice_still_end_the_step() {
        let mut run = running("fix");
        run.state_of("implement").report = "Fixed the redirect.".into();
        let v = view(&[("hp-app-com-1", Activity::Idle)], true);
        let same = RESULT.replace("implement-1-r1", "fix-1-r1");
        assert!(matches!(
            seen(&run, &v, Some(&same), at(1)),
            Some(Seen::Ended { .. })
        ));
    }

    #[test]
    fn a_blocked_session_is_waiting() {
        let run = running("implement");
        let v = view(&[("hp-app-com-1", Activity::Blocked)], true);
        assert_eq!(
            seen(&run, &v, Some("Allow?"), at(1)),
            Some(Seen::Waiting {
                step: "implement".into(),
                screen: "Allow?".into()
            })
        );
    }

    #[test]
    fn a_missing_session_waits_two_minutes() {
        let run = running("implement");
        assert_eq!(seen(&run, &view(&[], true), None, at(1)), None);
        assert!(matches!(
            seen(&run, &view(&[], true), None, at(3)),
            Some(Seen::NoResult { .. })
        ));
    }

    #[test]
    fn an_offline_machine() {
        let mut run = run_of("Implement my tickets");
        run.state = RunState::Queued;
        run.slot = Some("hp".into());
        assert_eq!(
            seen(&run, &view(&[], false), None, at(1)),
            Some(Seen::Offline)
        );
        assert_eq!(seen(&run, &view(&[], true), None, at(1)), None);
    }
}
