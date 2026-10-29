use super::definition::{MachineChoice, Outcome, Step, StepKind, END, WAIT};
use super::record::{Effect, Entry, Question, Run, RunState, Seen, WaitKind, Waiting};
use crate::config::Pipelines as Cfg;
use chrono::{DateTime, Duration, Local};
use std::collections::HashMap;

const OFFLINE_MINUTES: i64 = 30;
const RETRY_MINUTES: [i64; 4] = [1, 2, 4, 8];
const SCREEN_LINES: usize = 10;

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.trim_end().lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn elapsed(since: &str, now: &DateTime<Local>) -> Option<i64> {
    let since = DateTime::parse_from_rfc3339(since).ok()?;
    Some((*now - since.with_timezone(&Local)).num_minutes())
}

fn duration(minutes: i64) -> String {
    if minutes < 60 {
        format!("{minutes} min")
    } else {
        format!("{} h", minutes / 60)
    }
}

fn current(run: &Run) -> Option<Step> {
    run.def().step(&run.step).cloned()
}

fn name_of(run: &Run, id: &str) -> String {
    run.def()
        .step(id)
        .map_or_else(|| id.to_string(), |s| s.name.clone())
}

fn wait(
    mut run: Run,
    kind: WaitKind,
    step: &str,
    reason: String,
    screen: &str,
) -> (Run, Vec<Effect>) {
    let text = if kind.answerable() {
        format!("{} needs your answer", run.subject.label())
    } else {
        format!("{} stopped: {reason}", run.subject.label())
    };
    run.state = RunState::Waiting;
    run.step = step.to_string();
    run.slot = None;
    run.waiting = Some(Waiting {
        kind,
        step: step.to_string(),
        reason,
        screen: tail(screen, SCREEN_LINES),
    });
    (run, vec![Effect::Notify { text }])
}

fn machine_for(run: &Run, step: &Step) -> String {
    match &step.kind {
        StepKind::Agent { machine, .. } => match machine {
            MachineChoice::Name(m) => m.clone(),
            MachineChoice::SameAs(other) => run
                .steps
                .get(other)
                .map(|s| s.machine.clone())
                .unwrap_or_default(),
            MachineChoice::Pick(_) => run.place.machine.clone(),
        },
        _ => String::new(),
    }
}

// Enters a step: an agent step waits for a slot on its machine, a built-in step runs at once.
fn enter(mut run: Run, id: &str, now: &DateTime<Local>, past_limit: bool) -> (Run, Vec<Effect>) {
    let Some(step) = run.def().step(id).cloned() else {
        let reason = format!("the step {id} does not exist in this version");
        return wait(run, WaitKind::Stopped, id, reason, "");
    };
    let runs = run.steps.get(id).map_or(0, |s| s.runs);
    if runs >= step.max_runs && !past_limit {
        let times = if runs == 1 { "time" } else { "times" };
        let reason = format!("{} ran {runs} {times}", step.name);
        return wait(run, WaitKind::RunLimit, id, reason, "");
    }
    run.step = id.to_string();
    run.step_since = now.to_rfc3339();
    run.retried = false;
    run.waiting = None;
    run.slot = None;
    run.history.push(Entry {
        step: id.to_string(),
        outcome: None,
        at: now.to_rfc3339(),
        note: String::new(),
    });
    let effect = match &step.kind {
        StepKind::Agent { .. } => {
            run.state = RunState::Queued;
            run.slot = Some(machine_for(&run, &step));
            return (run, vec![]);
        }
        StepKind::Wait { message } => {
            let reason = if message.trim().is_empty() {
                format!("{} waits for you to continue", step.name)
            } else {
                message.clone()
            };
            return wait(run, WaitKind::WaitStep, id, reason, "");
        }
        StepKind::Plan { .. } => Effect::Plan { step: id.into() },
        StepKind::Push => Effect::Push { step: id.into() },
        StepKind::Linear { .. } => Effect::Linear { step: id.into() },
        StepKind::Report => Effect::Report { step: id.into() },
    };
    let st = run.state_of(id);
    st.runs += 1;
    st.started = now.to_rfc3339();
    run.state = RunState::Running;
    (run, vec![effect])
}

// Follows the line for an outcome from the current step.
fn follow(mut run: Run, outcome: Outcome, now: &DateTime<Local>) -> (Run, Vec<Effect>) {
    let from = run.step.clone();
    let Some(step) = current(&run) else {
        let reason = format!("{from} does not exist");
        return wait(run, WaitKind::Stopped, &from, reason, "");
    };
    let st = run.state_of(&from);
    st.outcome = Some(outcome);
    st.ended = now.to_rfc3339();
    if let Some(last) = run.history.iter_mut().rev().find(|e| e.step == from) {
        last.outcome = Some(outcome);
    }
    let report = run
        .steps
        .get(&from)
        .map(|s| s.report.clone())
        .unwrap_or_default();
    match step.next.of(outcome) {
        END => {
            run.state = RunState::Done;
            run.step = String::new();
            run.slot = None;
            run.waiting = None;
            (run, vec![])
        }
        WAIT if outcome == Outcome::NeedsYou => {
            let reason = format!("{} needs you", step.name);
            wait(run, WaitKind::NeedsYou, &from, reason, &report)
        }
        WAIT => {
            let reason = format!("{} {}", step.name, outcome.word());
            wait(run, WaitKind::Stopped, &from, reason, &report)
        }
        to => {
            let to = to.to_string();
            enter(run, &to, now, false)
        }
    }
}

// A step that ended without a usable result runs once more before the run waits.
fn again(mut run: Run, screen: &str) -> (Run, Vec<Effect>) {
    let id = run.step.clone();
    if run.retried {
        let reason = format!("{} ended without a result", name_of(&run, &id));
        return wait(run, WaitKind::NoResult, &id, reason, screen);
    }
    run.retried = true;
    let effect = match current(&run).map(|s| s.kind) {
        Some(StepKind::Plan { .. }) => Effect::Plan { step: id },
        _ => Effect::Agent { step: id },
    };
    (run, vec![effect])
}

fn tick(mut run: Run, cfg: &Cfg, now: &DateTime<Local>) -> (Run, Vec<Effect>) {
    let id = run.step.clone();
    if run.state == RunState::Queued {
        let offline = run
            .offline_since
            .as_deref()
            .and_then(|since| elapsed(since, now))
            .is_some_and(|m| m >= OFFLINE_MINUTES);
        if offline {
            let machine = run.slot.clone().unwrap_or_default();
            return wait(
                run,
                WaitKind::Offline,
                &id,
                format!("{machine} is offline"),
                "",
            );
        }
        return (run, vec![]);
    }
    if run.state != RunState::Running {
        return (run, vec![]);
    }
    if let Some(at) = run.next_try.clone() {
        if elapsed(&at, now).is_some_and(|m| m >= 0) {
            run.next_try = None;
            return (run, vec![Effect::Plan { step: id }]);
        }
    }
    let Some(step) = current(&run) else {
        return (run, vec![]);
    };
    if !matches!(step.kind, StepKind::Agent { .. } | StepKind::Plan { .. }) {
        return (run, vec![]);
    }
    let limit = step.minutes.unwrap_or(cfg.minutes) as i64;
    match elapsed(&run.step_since, now).filter(|m| *m > limit) {
        Some(m) => {
            let reason = format!("{} has run for {}", step.name, duration(m));
            wait(run, WaitKind::TimeLimit, &id, reason, "")
        }
        None => (run, vec![]),
    }
}

fn answer(mut run: Run, text: String, now: &DateTime<Local>) -> (Run, Vec<Effect>) {
    let Some(w) = run.waiting.clone().filter(|w| w.kind.answerable()) else {
        return (run, vec![]);
    };
    match w.kind {
        WaitKind::Questions => {
            for q in run.questions.iter_mut().filter(|q| q.answer.is_empty()) {
                q.answer = text.clone();
                q.at = now.to_rfc3339();
            }
            enter(run, &w.step, now, true)
        }
        WaitKind::Asking => {
            run.waiting = None;
            run.state = RunState::Running;
            let machine = run.steps.get(&w.step).map(|s| s.machine.clone());
            run.slot = machine;
            (run, vec![Effect::Answer { step: w.step, text }])
        }
        _ => {
            run.state_of(&w.step).answer = text;
            enter(run, &w.step, now, true)
        }
    }
}

pub fn start(run: Run, now: DateTime<Local>) -> (Run, Vec<Effect>) {
    let first = run.def().start.clone();
    enter(run, &first, &now, false)
}

pub fn step(mut run: Run, seen: Seen, cfg: &Cfg, now: DateTime<Local>) -> (Run, Vec<Effect>) {
    let now = &now;
    if !run.state.active() {
        return (run, vec![]);
    }
    let waiting = run.state == RunState::Waiting;
    let id = run.step.clone();
    match seen {
        Seen::Drop => {
            run.state = RunState::Dropped;
            run.slot = None;
            (run, vec![Effect::StopSessions])
        }
        Seen::Retry if waiting => {
            let at = run.waiting.take().map_or(id, |w| w.step);
            enter(run, &at, now, true)
        }
        Seen::Continue(outcome) if waiting => {
            if let Some(w) = run.waiting.take() {
                run.step = w.step;
            }
            follow(run, outcome, now)
        }
        Seen::Answer(text) if waiting => answer(run, text, now),
        _ if waiting => (run, vec![]),
        Seen::Tick => tick(run, cfg, now),
        Seen::Offline if run.state == RunState::Queued => {
            run.offline_since.get_or_insert_with(|| now.to_rfc3339());
            (run, vec![])
        }
        Seen::Admitted if run.state == RunState::Queued => {
            run.offline_since = None;
            run.state = RunState::Running;
            let machine = run.slot.clone().unwrap_or_default();
            let st = run.state_of(&id);
            st.runs += 1;
            st.started = now.to_rfc3339();
            st.machine = machine;
            (run, vec![Effect::Agent { step: id }])
        }
        Seen::Closed(_) => {
            let reason = format!("{} was closed in Linear", run.subject.label());
            wait(run, WaitKind::Closed, &id, reason, "")
        }
        Seen::Refused(reason) => wait(run, WaitKind::Refused, &id, reason, ""),
        Seen::Planned(Ok(plan)) if !plan.questions.is_empty() => {
            let at = now.to_rfc3339();
            run.questions
                .extend(plan.questions.iter().map(|q| Question {
                    asked: q.clone(),
                    answer: String::new(),
                    at: at.clone(),
                }));
            let n = plan.questions.len();
            let word = if n == 1 { "question" } else { "questions" };
            let reason = format!("{} has {n} {word}", name_of(&run, &id));
            wait(run, WaitKind::Questions, &id, reason, "")
        }
        Seen::Planned(Ok(plan)) => {
            run.place.machine = plan.machine;
            run.place.folder = plan.folder;
            run.place.branch = plan.branch;
            run.tries = 0;
            run.state_of(&id).report = plan.reason;
            follow(run, Outcome::Pass, now)
        }
        Seen::Planned(Err(e)) if e.starts_with("Linear") => {
            run.tries += 1;
            let at = (run.tries as usize - 1).min(RETRY_MINUTES.len() - 1);
            run.next_try = Some((*now + Duration::minutes(RETRY_MINUTES[at])).to_rfc3339());
            (run, vec![])
        }
        Seen::Planned(Err(e)) => again(run, &e),
        Seen::Started {
            step,
            result: Ok((session, machine, path)),
        } => {
            let st = run.state_of(&step);
            st.session = session;
            st.machine = machine;
            st.path = path;
            (run, vec![])
        }
        Seen::Started { result: Err(e), .. } => again(run, &e),
        Seen::NoResult { screen, .. } => again(run, &screen),
        Seen::Sent(Err(e)) => again(run, &e),
        Seen::Waiting { step, screen } => wait(
            run,
            WaitKind::Asking,
            &step,
            "The agent is asking something".into(),
            &screen,
        ),
        Seen::Ended {
            step,
            outcome,
            report,
            details,
        } => {
            let st = run.state_of(&step);
            st.report = report;
            st.details = details;
            run.step = step;
            follow(run, outcome, now)
        }
        Seen::Pushed(Ok(())) => (run, vec![Effect::OpenPull { step: id }]),
        Seen::Pushed(Err(e)) => wait(run, WaitKind::Push, &id, e, ""),
        Seen::Opened(opened) => {
            match opened {
                Ok(pull) => run.pull = Some(pull),
                Err(e) => run.notes.push(format!("The draft was not opened: {e}")),
            }
            follow(run, Outcome::Pass, now)
        }
        Seen::Linear(Ok(())) => follow(run, Outcome::Pass, now),
        Seen::Linear(Err(e)) => {
            run.notes.push(format!("Linear: {e}"));
            follow(run, Outcome::Fail, now)
        }
        Seen::Reported(written) => {
            match written {
                Ok(text) => run.report = text,
                Err(e) => run.notes.push(format!("No report was written: {e}")),
            }
            follow(run, Outcome::Pass, now)
        }
        _ => (run, vec![]),
    }
}

// Which queued runs may start their agent step now, oldest first, as slots on their machines
// allow.
pub fn admit(runs: &[Run], cfg: &Cfg, up: &dyn Fn(&str) -> bool) -> Vec<String> {
    let since = |r: &Run| DateTime::parse_from_rfc3339(&r.step_since).ok();
    let mut busy: HashMap<&str, u32> = HashMap::new();
    for r in runs.iter().filter(|r| r.state == RunState::Running) {
        if let Some(m) = &r.slot {
            *busy.entry(m.as_str()).or_default() += 1;
        }
    }
    let mut queued: Vec<&Run> = runs
        .iter()
        .filter(|r| r.state == RunState::Queued)
        .collect();
    queued.sort_by_key(|r| since(r));
    let mut out = Vec::new();
    for r in queued {
        let Some(m) = r.slot.as_deref() else {
            continue;
        };
        let used = busy.entry(m).or_default();
        if up(m) && *used < cfg.per_machine {
            *used += 1;
            out.push(r.id.clone());
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pipeline::record::{Plan, PullRef, RunState, Subject, TicketRef, WaitKind};
    use chrono::TimeZone;

    pub(crate) fn cfg() -> Cfg {
        Cfg::default()
    }

    pub(crate) fn at(minute: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 29, 9, minute, 0).unwrap()
    }

    pub(crate) fn run_of(template: &str) -> Run {
        let def = crate::pipeline::templates::all()
            .into_iter()
            .find(|d| d.name == template)
            .unwrap();
        Run {
            id: "r1".into(),
            pipeline: def.id.clone(),
            pipeline_name: def.name.clone(),
            definition: Some(def),
            subject: Subject {
                ticket: Some(TicketRef {
                    linear_id: "u-1".into(),
                    id: "COM-1".into(),
                    title: "Fix the login".into(),
                    url: "https://linear.app/acme/issue/COM-1".into(),
                }),
                pr: None,
            },
            started: at(0).to_rfc3339(),
            step_since: at(0).to_rfc3339(),
            ..Run::default()
        }
    }

    fn plan() -> Plan {
        Plan {
            machine: "hp".into(),
            folder: "acme/app".into(),
            branch: "com-1-fix-the-login".into(),
            reason: "hp has acme/app".into(),
            questions: vec![],
        }
    }

    fn ended(step: &str, outcome: Outcome) -> Seen {
        Seen::Ended {
            step: step.into(),
            outcome,
            report: format!("{step} {}", outcome.word()),
            details: vec![],
        }
    }

    fn agent(step: &str) -> Vec<Effect> {
        vec![Effect::Agent { step: step.into() }]
    }

    // Feeds each seen in turn and checks the effects and where the run is after each.
    fn walk(mut run: Run, steps: Vec<(Seen, Vec<Effect>, &str, RunState)>) -> Run {
        for (seen, effects, at_step, state) in steps {
            let label = format!("{seen:?}");
            let (next, did) = step(run, seen, &cfg(), at(5));
            assert_eq!(did, effects, "effects after {label}");
            assert_eq!(
                (next.step.as_str(), next.state),
                (at_step, state),
                "after {label}"
            );
            run = next;
        }
        run
    }

    #[test]
    fn the_implement_template_walks_to_done() {
        let (run, did) = start(run_of("Implement my Linear tickets"), at(0));
        assert_eq!(
            did,
            vec![Effect::Plan {
                step: "plan".into()
            }]
        );
        use RunState::*;
        let run = walk(
            run,
            vec![
                (Seen::Planned(Ok(plan())), vec![], "implement", Queued),
                (Seen::Admitted, agent("implement"), "implement", Running),
                (
                    Seen::Started {
                        step: "implement".into(),
                        result: Ok(("hp-1".into(), "hp".into(), "/r/w".into())),
                    },
                    vec![],
                    "implement",
                    Running,
                ),
                (ended("implement", Outcome::Pass), vec![], "review", Queued),
                (Seen::Admitted, agent("review"), "review", Running),
                (ended("review", Outcome::Fail), vec![], "fix", Queued),
                (Seen::Admitted, agent("fix"), "fix", Running),
                (ended("fix", Outcome::Pass), vec![], "review", Queued),
                (Seen::Admitted, agent("review"), "review", Running),
                (ended("review", Outcome::Pass), vec![], "qa", Queued),
                (Seen::Admitted, agent("qa"), "qa", Running),
                (
                    ended("qa", Outcome::Pass),
                    vec![Effect::Push {
                        step: "push".into(),
                    }],
                    "push",
                    Running,
                ),
                (
                    Seen::Pushed(Ok(())),
                    vec![Effect::OpenPull {
                        step: "push".into(),
                    }],
                    "push",
                    Running,
                ),
                (
                    Seen::Opened(Ok(PullRef {
                        url: "u".into(),
                        number: 12,
                    })),
                    vec![Effect::Linear {
                        step: "linear-move".into(),
                    }],
                    "linear-move",
                    Running,
                ),
                (
                    Seen::Linear(Ok(())),
                    vec![Effect::Report {
                        step: "report".into(),
                    }],
                    "report",
                    Running,
                ),
                (Seen::Reported(Ok("All good.".into())), vec![], "", Done),
            ],
        );
        assert_eq!(run.place.machine, "hp");
        assert_eq!(run.steps["implement"].session, "hp-1");
        assert_eq!(run.steps["review"].runs, 2);
        assert_eq!(run.steps["qa"].machine, "devbox");
        assert_eq!(run.pull.as_ref().unwrap().number, 12);
        assert_eq!(run.report, "All good.");
    }

    #[test]
    fn the_review_template_reports_a_fail() {
        let (run, _) = start(run_of("Review my merge requests"), at(0));
        use RunState::*;
        let run = walk(
            run,
            vec![
                (Seen::Planned(Ok(plan())), vec![], "understand", Queued),
                (Seen::Admitted, agent("understand"), "understand", Running),
                (
                    ended("understand", Outcome::Pass),
                    vec![],
                    "root-cause",
                    Queued,
                ),
                (Seen::Admitted, agent("root-cause"), "root-cause", Running),
                (
                    ended("root-cause", Outcome::Fail),
                    vec![Effect::Report {
                        step: "report".into(),
                    }],
                    "report",
                    Running,
                ),
            ],
        );
        assert_eq!(run.steps["root-cause"].outcome, Some(Outcome::Fail));
        assert_eq!(run.steps["root-cause"].report, "root-cause failed");
    }

    fn at_step(template: &str, id: &str) -> Run {
        let mut run = run_of(template);
        run.place.machine = "hp".into();
        run.step = id.into();
        run.state = RunState::Running;
        run.slot = Some("hp".into());
        run.state_of(id).runs = 1;
        run.state_of(id).machine = "hp".into();
        run
    }

    fn waiting(run: &Run) -> (WaitKind, String, String) {
        assert_eq!(run.state, RunState::Waiting);
        let w = run.waiting.as_ref().unwrap();
        (w.kind, w.step.clone(), w.reason.clone())
    }

    #[test]
    fn a_loop_stops_at_its_run_limit() {
        let mut run = at_step("Implement my Linear tickets", "review");
        run.state_of("fix").runs = 2;
        let (run, did) = step(run, ended("review", Outcome::Fail), &cfg(), at(5));
        assert_eq!(
            waiting(&run),
            (WaitKind::RunLimit, "fix".into(), "Fix ran 2 times".into())
        );
        assert!(matches!(&did[..], [Effect::Notify { text }] if text.contains("COM-1")));
    }

    #[test]
    fn needs_you_waits_with_the_report() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, _) = step(
            run,
            Seen::Ended {
                step: "implement".into(),
                outcome: Outcome::NeedsYou,
                report: "Which page?".into(),
                details: vec![],
            },
            &cfg(),
            at(5),
        );
        let (kind, step_id, _) = waiting(&run);
        assert_eq!((kind, step_id.as_str()), (WaitKind::NeedsYou, "implement"));
        assert_eq!(run.waiting.clone().unwrap().screen, "Which page?");
        assert_eq!(run.slot, None, "a waiting run gives its machine slot back");
    }

    #[test]
    fn stop_line_waits_with_the_outcome() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, _) = step(run, ended("implement", Outcome::Fail), &cfg(), at(5));
        assert_eq!(
            waiting(&run),
            (
                WaitKind::Stopped,
                "implement".into(),
                "Implement failed".into()
            )
        );
    }

    #[test]
    fn continue_on_pass_and_fail_follow_their_lines() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, _) = step(run, ended("implement", Outcome::Fail), &cfg(), at(5));
        let (on_pass, _) = step(run.clone(), Seen::Continue(Outcome::Pass), &cfg(), at(6));
        assert_eq!(
            (on_pass.step.as_str(), on_pass.state),
            ("review", RunState::Queued)
        );
        let (on_fail, _) = step(run, Seen::Continue(Outcome::Fail), &cfg(), at(6));
        assert_eq!(
            on_fail.state,
            RunState::Waiting,
            "implement's fail line goes to wait"
        );
    }

    #[test]
    fn retry_runs_the_step_again_past_its_limit_once() {
        let mut run = at_step("Implement my Linear tickets", "review");
        run.state_of("fix").runs = 2;
        let (run, _) = step(run, ended("review", Outcome::Fail), &cfg(), at(5));
        let (run, _) = step(run, Seen::Retry, &cfg(), at(6));
        assert_eq!((run.step.as_str(), run.state), ("fix", RunState::Queued));
        let (run, did) = step(run, Seen::Admitted, &cfg(), at(6));
        assert_eq!(did, agent("fix"));
        assert_eq!(run.steps["fix"].runs, 3);
    }

    #[test]
    fn an_answer_reenters_the_step_with_it() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, _) = step(
            run,
            Seen::Ended {
                step: "implement".into(),
                outcome: Outcome::NeedsYou,
                report: "Which page?".into(),
                details: vec![],
            },
            &cfg(),
            at(5),
        );
        let (run, _) = step(run, Seen::Answer("The account page".into()), &cfg(), at(6));
        assert_eq!(
            (run.step.as_str(), run.state),
            ("implement", RunState::Queued)
        );
        assert_eq!(run.steps["implement"].answer, "The account page");
    }

    #[test]
    fn an_answer_to_a_waiting_session_is_typed() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, _) = step(
            run,
            Seen::Waiting {
                step: "implement".into(),
                screen: "Allow edit?".into(),
            },
            &cfg(),
            at(5),
        );
        assert_eq!(waiting(&run).0, WaitKind::Asking);
        let (run, did) = step(run, Seen::Answer("1".into()), &cfg(), at(6));
        assert_eq!(
            did,
            vec![Effect::Answer {
                step: "implement".into(),
                text: "1".into()
            }]
        );
        assert_eq!(run.state, RunState::Running);
    }

    #[test]
    fn plan_questions_wait_and_an_answer_plans_again() {
        let (run, _) = start(run_of("Implement my Linear tickets"), at(0));
        let mut asks = plan();
        asks.questions = vec!["Which page?".into()];
        let (run, _) = step(run, Seen::Planned(Ok(asks)), &cfg(), at(1));
        assert_eq!(
            waiting(&run),
            (
                WaitKind::Questions,
                "plan".into(),
                "Plan has 1 question".into()
            )
        );
        let (run, did) = step(run, Seen::Answer("The account page".into()), &cfg(), at(2));
        assert_eq!(
            did,
            vec![Effect::Plan {
                step: "plan".into()
            }]
        );
        assert_eq!(run.questions[0].answer, "The account page");
    }

    #[test]
    fn no_result_runs_once_more_then_waits() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, did) = step(
            run,
            Seen::NoResult {
                step: "implement".into(),
                screen: "crashed".into(),
            },
            &cfg(),
            at(5),
        );
        assert_eq!((did, run.state), (agent("implement"), RunState::Running));
        let screen: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let (run, _) = step(
            run,
            Seen::NoResult {
                step: "implement".into(),
                screen,
            },
            &cfg(),
            at(6),
        );
        assert_eq!(waiting(&run).0, WaitKind::NoResult);
        assert!(run.waiting.unwrap().screen.starts_with("line 11"));
    }

    #[test]
    fn time_limit_waits() {
        let mut run = at_step("Implement my Linear tickets", "implement");
        run.step_since = at(0).to_rfc3339();
        let (run, _) = step(
            run,
            Seen::Tick,
            &cfg(),
            at(0) + chrono::Duration::minutes(125),
        );
        assert_eq!(
            waiting(&run),
            (
                WaitKind::TimeLimit,
                "implement".into(),
                "Implement has run for 2 h".into()
            )
        );
    }

    #[test]
    fn admit_respects_slots_per_machine() {
        let queued = |id: &str, minute: u32, machine: &str| Run {
            id: id.into(),
            state: RunState::Queued,
            step_since: at(minute).to_rfc3339(),
            slot: Some(machine.into()),
            ..Run::default()
        };
        let mut busy = queued("r0", 0, "hp");
        busy.state = RunState::Running;
        let runs = vec![
            queued("r3", 3, "hp"),
            queued("r1", 1, "hp"),
            queued("r2", 2, "hp"),
            busy,
            queued("r4", 4, "devbox"),
        ];
        assert_eq!(admit(&runs, &cfg(), &|_| true), vec!["r1", "r4"]);
        assert_eq!(admit(&runs, &cfg(), &|m| m == "devbox"), vec!["r4"]);
    }

    #[test]
    fn a_wait_step_continues_on_pass() {
        let mut run = run_of("Implement my Linear tickets");
        let def = run.definition.as_mut().unwrap();
        let look = Step {
            kind: StepKind::Wait {
                message: "Look before pushing".into(),
            },
            id: "look".into(),
            name: "Look".into(),
            ..def.step("push").unwrap().clone()
        };
        let mut look = look;
        look.next.pass = "push".into();
        def.steps.push(look);
        def.steps
            .iter_mut()
            .find(|s| s.id == "qa")
            .unwrap()
            .next
            .pass = "look".into();
        run.step = "qa".into();
        run.state = RunState::Running;
        let (run, _) = step(run, ended("qa", Outcome::Pass), &cfg(), at(5));
        assert_eq!(
            waiting(&run),
            (
                WaitKind::WaitStep,
                "look".into(),
                "Look before pushing".into()
            )
        );
        let (run, did) = step(run, Seen::Continue(Outcome::Pass), &cfg(), at(6));
        assert_eq!(
            (run.step.as_str(), did),
            (
                "push",
                vec![Effect::Push {
                    step: "push".into()
                }]
            )
        );
    }

    #[test]
    fn drop_stops_the_sessions() {
        let run = at_step("Implement my Linear tickets", "implement");
        let (run, did) = step(run, Seen::Drop, &cfg(), at(5));
        assert_eq!(
            (run.state, did),
            (RunState::Dropped, vec![Effect::StopSessions])
        );
    }
}
