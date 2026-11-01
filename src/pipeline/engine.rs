use super::checks::{self, Read, Verdict};
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
    let text = if kind == WaitKind::NoResult {
        format!("{}: {reason}", run.subject.label())
    } else if kind.answerable() {
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
        tool_hash: String::new(),
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
    run.next_try = None;
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
        StepKind::Checks { .. } => Effect::Checks { step: id.into() },
        StepKind::Update { .. } => Effect::Linear { step: id.into() },
        StepKind::Report => Effect::Report { step: id.into() },
        StepKind::Call { .. } => Effect::Call { step: id.into() },
        StepKind::Tool { .. } => Effect::Tool { step: id.into() },
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
            (run, vec![Effect::StopSessions])
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
fn again(mut run: Run, screen: &str, now: &DateTime<Local>) -> (Run, Vec<Effect>) {
    let id = run.step.clone();
    if run.retried {
        let reason = format!("{} ended without a result", name_of(&run, &id));
        return wait(run, WaitKind::NoResult, &id, reason, screen);
    }
    run.retried = true;
    run.step_since = now.to_rfc3339();
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
    let watching = current(&run).is_some_and(|s| matches!(s.kind, StepKind::Checks { .. }));
    if let Some(at) = run.next_try.clone() {
        if DateTime::parse_from_rfc3339(&at).is_ok_and(|at| *now >= at) {
            run.next_try = None;
            let effect = if watching {
                Effect::Checks { step: id }
            } else {
                Effect::Plan { step: id }
            };
            return (run, vec![effect]);
        }
    }
    let Some(step) = current(&run) else {
        return (run, vec![]);
    };
    if !watching && !matches!(step.kind, StepKind::Agent { .. } | StepKind::Plan { .. }) {
        return (run, vec![]);
    }
    let limit = step.minutes.unwrap_or(cfg.minutes) as i64;
    match elapsed(&run.step_since, now).filter(|m| *m > limit) {
        Some(m) if watching => {
            let waited = duration(m);
            let reason = match run.steps.get(&id).map(|s| s.watch.status.as_str()) {
                Some(status) if !status.is_empty() => {
                    format!("{} waited {waited}: {status}", step.name)
                }
                _ => format!("{} waited {waited}", step.name),
            };
            wait(run, WaitKind::TimeLimit, &id, reason, "")
        }
        Some(m) => {
            let reason = format!("{} has run for {}", step.name, duration(m));
            wait(run, WaitKind::TimeLimit, &id, reason, "")
        }
        // A restart between a read and what came of it leaves nothing due, so the wait asks again.
        None if watching && run.next_try.is_none() => (run, vec![Effect::Checks { step: id }]),
        None => (run, vec![]),
    }
}

// A person who answers a stopped wait starts its count again, or the next commit would stop it.
fn count_again(run: &mut Run, step: &str) {
    let watches = run
        .def()
        .step(step)
        .is_some_and(|s| matches!(s.kind, StepKind::Checks { .. }));
    if watches {
        run.state_of(step).watch = checks::Watch::default();
    }
}

// The report opens with the reason, which the run page already shows above this text.
fn under_reason<'a>(report: &'a str, reason: &str) -> &'a str {
    report
        .strip_prefix(reason)
        .map_or(report, |rest| rest.trim_start_matches('.').trim_start())
}

fn waits_on_an_unsettled_check(run: &Run) -> bool {
    run.waiting
        .as_ref()
        .is_some_and(|w| w.kind == WaitKind::CiUnsettled)
}

// The person has been told, and a re-run needs nothing from them, so the wait keeps reading until
// its time limit, and then only they can move it on.
fn tick_unsettled(mut run: Run, cfg: &Cfg, now: &DateTime<Local>) -> (Run, Vec<Effect>) {
    let Some(step) = current(&run) else {
        return (run, vec![]);
    };
    let limit = step.minutes.unwrap_or(cfg.minutes) as i64;
    if let Some(m) = elapsed(&run.step_since, now).filter(|m| *m > limit) {
        run.next_try = None;
        if let Some(w) = run.waiting.as_mut() {
            w.kind = WaitKind::TimeLimit;
            w.reason = format!("{} waited {}: {}", step.name, duration(m), w.reason);
        }
        return (run, vec![]);
    }
    let due = match &run.next_try {
        Some(at) => DateTime::parse_from_rfc3339(at).is_ok_and(|at| *now >= at),
        None => true,
    };
    if !due {
        return (run, vec![]);
    }
    run.next_try = None;
    (run, vec![Effect::Checks { step: step.id }])
}

fn checks_read(
    mut run: Run,
    read: Read,
    every_seconds: u64,
    now: &DateTime<Local>,
) -> (Run, Vec<Effect>) {
    let id = run.step.clone();
    let Some(StepKind::Checks { require_approval }) = current(&run).map(|s| s.kind) else {
        return (run, vec![]);
    };
    let next_read = (*now + Duration::seconds(every_seconds as i64)).to_rfc3339();
    let open = waits_on_an_unsettled_check(&run);
    if open && !matches!(read, Read::Found(_)) {
        run.next_try = Some(next_read);
        return (run, vec![]);
    }
    let verdict = match read {
        Read::Found(pull) => {
            if run.pull.is_none() {
                run.pull = Some(super::record::PullRef {
                    url: pull.url.clone(),
                    number: pull.number,
                });
            }
            checks::judge(&mut run.state_of(&id).watch, &pull, require_approval, now)
        }
        Read::NoPull => {
            Verdict::Hold("No pull or merge request is open for this branch yet".into())
        }
        Read::Problem(e) => Verdict::Hold(e),
        Read::Blocked(reason) => Verdict::Stop {
            reason,
            report: String::new(),
        },
    };
    if open && !matches!(verdict, Verdict::Unsettled { .. }) {
        run.waiting = None;
        run.state = RunState::Running;
        run.step_since = now.to_rfc3339();
    }
    match verdict {
        Verdict::Hold(status) => {
            run.state_of(&id).watch.status = status;
            run.next_try = Some(next_read);
            (run, vec![])
        }
        Verdict::Unsettled { reason, report } if open => {
            run.state_of(&id).report.clone_from(&report);
            let screen = tail(under_reason(&report, &reason), SCREEN_LINES);
            if let Some(w) = run.waiting.as_mut() {
                w.reason = reason;
                w.screen = screen;
            }
            run.next_try = Some(next_read);
            (run, vec![])
        }
        Verdict::Unsettled { reason, report } => {
            run.state_of(&id).report.clone_from(&report);
            let screen = under_reason(&report, &reason).to_string();
            let (mut run, effects) = wait(run, WaitKind::CiUnsettled, &id, reason, &screen);
            run.next_try = Some(next_read);
            (run, effects)
        }
        Verdict::Pass(report) => {
            run.state_of(&id).report = report;
            follow(run, Outcome::Pass, now)
        }
        Verdict::Fail(report) => {
            run.state_of(&id).report = report;
            follow(run, Outcome::Fail, now)
        }
        Verdict::Stop { reason, report } => {
            if !report.is_empty() {
                run.state_of(&id).report = report.clone();
            }
            wait(run, WaitKind::Stopped, &id, reason, &report)
        }
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
            run.step_since = now.to_rfc3339();
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
    // Teardown runs after a run has ended, so its answer comes to a run that is no longer active.
    let seen = match seen {
        Seen::TornDown(problem) => {
            run.teardown_problem = problem.unwrap_or_default();
            return (run, vec![]);
        }
        // Comes ahead of its session, which a run dropped meanwhile still stops and tears down.
        Seen::WorktreeMade { step, path, repo } => {
            let st = run.state_of(&step);
            st.made = path;
            st.repo = repo;
            return (run, vec![]);
        }
        other => other,
    };
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
        Seen::AcceptTool if waiting => {
            let Some(w) = run.waiting.take() else {
                return (run, vec![]);
            };
            if let Some(def) = run.definition.as_mut() {
                let saved = def.steps.iter_mut().find(|s| s.id == w.step);
                if let Some(Step {
                    kind: StepKind::Tool { schema_hash, .. },
                    ..
                }) = saved
                {
                    schema_hash.clone_from(&w.tool_hash);
                }
            }
            enter(run, &w.step, now, true)
        }
        Seen::Retry if waiting => {
            let at = run.waiting.take().map_or(id, |w| w.step);
            count_again(&mut run, &at);
            enter(run, &at, now, true)
        }
        Seen::Continue(outcome) if waiting => {
            if let Some(w) = run.waiting.take() {
                count_again(&mut run, &w.step);
                run.step = w.step;
            }
            follow(run, outcome, now)
        }
        Seen::Answer(text) if waiting => answer(run, text, now),
        Seen::Tick if waits_on_an_unsettled_check(&run) => tick_unsettled(run, cfg, now),
        Seen::ChecksRead {
            step,
            read,
            every_seconds,
        } if step == id && waits_on_an_unsettled_check(&run) => {
            checks_read(run, read, every_seconds, now)
        }
        _ if waiting => (run, vec![]),
        Seen::Tick => tick(run, cfg, now),
        Seen::Offline if run.state == RunState::Queued => {
            run.offline_since.get_or_insert_with(|| now.to_rfc3339());
            (run, vec![])
        }
        Seen::Admitted if run.state == RunState::Queued => {
            run.offline_since = None;
            run.state = RunState::Running;
            run.step_since = now.to_rfc3339();
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
        Seen::ToolChanged {
            hash,
            reason,
            shown,
        } => {
            let (mut run, effects) = wait(run, WaitKind::ToolChanged, &id, reason, &shown);
            if let Some(w) = run.waiting.as_mut() {
                w.tool_hash = hash;
            }
            (run, effects)
        }
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
        Seen::Planned(Err(e)) => again(run, &e, now),
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
        Seen::Started { result: Err(e), .. } => again(run, &e, now),
        Seen::NoResult { screen, .. } => again(run, &screen, now),
        Seen::Sent(Err(e)) => again(run, &e, now),
        Seen::PersonStopped(name) if run.steps.get(&id).is_some_and(|s| s.session == name) => wait(
            run,
            WaitKind::Stopped,
            &id,
            "You stopped the session".into(),
            "",
        ),
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
        // A fix pushed again goes to the pull or merge request the first push opened.
        Seen::Pushed(Ok(())) if run.pull.is_some() => follow(run, Outcome::Pass, now),
        Seen::Pushed(Ok(())) => (run, vec![Effect::OpenPull { step: id }]),
        Seen::Pushed(Err(e)) => wait(run, WaitKind::Push, &id, e, ""),
        Seen::Opened(opened) => {
            match opened {
                Ok(pull) => run.pull = Some(pull),
                Err(e) => run.notes.push(format!("The draft was not opened: {e}")),
            }
            follow(run, Outcome::Pass, now)
        }
        Seen::ChecksRead {
            step,
            read,
            every_seconds,
        } if step == id => checks_read(run, read, every_seconds, now),
        Seen::Linear(Ok(())) => follow(run, Outcome::Pass, now),
        Seen::Linear(Err(e)) => {
            run.notes.push(format!("Linear: {e}"));
            follow(run, Outcome::Fail, now)
        }
        Seen::Called(result) | Seen::ToolDone(result) => {
            let (outcome, report) = match result {
                Ok(report) => (Outcome::Pass, report),
                Err(e) => (Outcome::Fail, e),
            };
            run.state_of(&id).report = report;
            follow(run, outcome, now)
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
                    source: String::new(),
                    item_id: "u-1".into(),
                    id: "COM-1".into(),
                    title: "Fix the login".into(),
                    url: "https://linear.app/acme/issue/COM-1".into(),
                    description: String::new(),
                    fields: Default::default(),
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
        let (run, did) = start(run_of("Implement my tickets"), at(0));
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
                (
                    Seen::Reported(Ok("All good.".into())),
                    vec![Effect::StopSessions],
                    "",
                    Done,
                ),
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
    fn accepting_a_changed_tool_saves_the_new_hash_and_runs_it_again() {
        let mut run = run_of("Implement my tickets");
        run.definition.as_mut().unwrap().steps.push(
            serde_json::from_value(serde_json::json!({
                "id": "tool", "name": "T", "kind": "tool", "server": "s", "tool": "x", "schema_hash": "h1",
                "next": { "pass": "qa", "fail": "report", "needs_you": "wait" },
            }))
            .unwrap(),
        );
        run.step = "tool".into();
        let seen = Seen::ToolChanged {
            hash: "h2".into(),
            reason: "x changed".into(),
            shown: "now".into(),
        };
        let (run, effects) = step(run, seen, &cfg(), at(5));
        let (kind, at_step, reason) = waiting(&run);
        assert_eq!(kind, WaitKind::ToolChanged);
        assert_eq!(at_step, "tool");
        assert!(reason.contains("x changed"));
        assert_eq!(effects.len(), 1, "one notification");
        let (run, effects) = step(run, Seen::AcceptTool, &cfg(), at(6));
        assert_eq!(
            effects,
            vec![Effect::Tool {
                step: "tool".into()
            }]
        );
        let saved = run.def().step("tool").unwrap().kind.clone();
        assert!(matches!(saved, StepKind::Tool { schema_hash, .. } if schema_hash == "h2"));
    }

    fn with_call(run: &mut Run) {
        let def = run.definition.as_mut().unwrap();
        def.steps.push(
            serde_json::from_value(serde_json::json!({
                "id": "update", "name": "Update Trello", "kind": "call",
                "connector": "trello", "call": "move", "params": { "value": "L2" },
                "next": { "pass": "qa", "fail": "report", "needs_you": "wait" },
            }))
            .unwrap(),
        );
        run.step = "update".into();
        run.state = RunState::Running;
    }

    #[test]
    fn a_call_step_passes_with_its_report() {
        let mut run = run_of("Implement my tickets");
        with_call(&mut run);
        let (run, _) = step(run, Seen::Called(Ok("moved".into())), &cfg(), at(5));
        assert_eq!(run.steps["update"].report, "moved");
        assert_eq!(run.steps["update"].outcome, Some(Outcome::Pass));
        assert_eq!(run.step, "qa");
    }

    #[test]
    fn a_failed_call_goes_down_the_fail_line() {
        let mut run = run_of("Implement my tickets");
        with_call(&mut run);
        let (run, _) = step(run, Seen::Called(Err("answered 401".into())), &cfg(), at(5));
        assert_eq!(run.steps["update"].report, "answered 401");
        assert_eq!(run.steps["update"].outcome, Some(Outcome::Fail));
        assert_eq!(run.step, "report");
    }

    #[test]
    fn entering_a_call_step_calls() {
        let mut run = run_of("Implement my tickets");
        with_call(&mut run);
        run.state_of("implement").outcome = None;
        let (_, did) = enter(run, "update", &at(5), false);
        assert_eq!(
            did,
            vec![Effect::Call {
                step: "update".into()
            }]
        );
    }

    #[test]
    fn a_loop_stops_at_its_run_limit() {
        let mut run = at_step("Implement my tickets", "review");
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
        let run = at_step("Implement my tickets", "implement");
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
    fn no_result_does_not_say_it_needs_an_answer() {
        let mut run = at_step("Implement my tickets", "fix");
        run.retried = true;
        let (_, did) = step(
            run,
            Seen::NoResult {
                step: "fix".into(),
                screen: String::new(),
            },
            &cfg(),
            at(9),
        );
        match &did[..] {
            [Effect::Notify { text }] => {
                assert!(!text.contains("needs your answer"), "{text}");
                assert!(text.contains("without a result"), "{text}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_second_try_gets_its_own_grace() {
        let run = at_step("Implement my tickets", "fix");
        let (run, _) = step(
            run,
            Seen::NoResult {
                step: "fix".into(),
                screen: String::new(),
            },
            &cfg(),
            at(9),
        );
        assert_eq!(run.step_since, at(9).to_rfc3339());
    }

    #[test]
    fn a_person_stopping_the_session_makes_the_step_wait() {
        let mut run = at_step("Implement my tickets", "fix");
        run.state_of("fix").session = "hp-main".into();
        let (same, did) = step(
            run.clone(),
            Seen::PersonStopped("hp-old".into()),
            &cfg(),
            at(5),
        );
        assert_eq!((same.state, did), (RunState::Running, vec![]));
        let (run, _) = step(run, Seen::PersonStopped("hp-main".into()), &cfg(), at(5));
        assert_eq!(
            waiting(&run),
            (
                WaitKind::Stopped,
                "fix".into(),
                "You stopped the session".into()
            )
        );
    }

    #[test]
    fn stop_line_waits_with_the_outcome() {
        let run = at_step("Implement my tickets", "implement");
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
        let run = at_step("Implement my tickets", "implement");
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
        let mut run = at_step("Implement my tickets", "review");
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
        let run = at_step("Implement my tickets", "implement");
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
        let run = at_step("Implement my tickets", "implement");
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
        let (run, _) = start(run_of("Implement my tickets"), at(0));
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
        let run = at_step("Implement my tickets", "implement");
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
    fn the_time_limit_counts_from_when_a_step_starts_working() {
        let mut run = at_step("Implement my tickets", "implement");
        run.state = RunState::Queued;
        let later = at(0) + chrono::Duration::minutes(150);
        let (run, _) = step(run, Seen::Admitted, &cfg(), later);
        let (mut run, _) = step(
            run,
            Seen::Tick,
            &cfg(),
            later + chrono::Duration::minutes(5),
        );
        assert_eq!(run.state, RunState::Running, "{:?}", run.waiting);
        run.state = RunState::Waiting;
        run.waiting = Some(crate::pipeline::record::Waiting {
            kind: WaitKind::Asking,
            step: "implement".into(),
            reason: "The agent is asking something".into(),
            screen: String::new(),
            tool_hash: String::new(),
        });
        let next_day = later + chrono::Duration::hours(20);
        let (run, _) = step(run, Seen::Answer("yes".into()), &cfg(), next_day);
        let (run, _) = step(
            run,
            Seen::Tick,
            &cfg(),
            next_day + chrono::Duration::minutes(5),
        );
        assert_eq!(run.state, RunState::Running, "{:?}", run.waiting);
    }

    #[test]
    fn a_finished_run_stops_every_session() {
        let run = at_step("Review my merge requests", "report");
        let (run, did) = step(run, ended("report", Outcome::Pass), &cfg(), at(9));
        assert_eq!(run.state, RunState::Done);
        assert_eq!(did, vec![Effect::StopSessions]);
    }

    #[test]
    fn time_limit_waits() {
        let mut run = at_step("Implement my tickets", "implement");
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
        let mut run = run_of("Implement my tickets");
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
        let run = at_step("Implement my tickets", "implement");
        let (run, did) = step(run, Seen::Drop, &cfg(), at(5));
        assert_eq!(
            (run.state, did),
            (RunState::Dropped, vec![Effect::StopSessions])
        );
    }
}
