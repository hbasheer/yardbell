use super::definition::{MachineChoice, Outcome, Step, StepKind, END, WAIT};
use super::record::{
    Effect, Entry, Held, HoldKind, Question, Run, RunState, Seen, WaitKind, Waiting,
};
use crate::config::Pipelines as Cfg;
use chrono::{DateTime, Duration, Local};
use std::collections::HashMap;

const OFFLINE_MINUTES: i64 = 30;
const RETRY_MINUTES: [i64; 4] = [1, 2, 4, 8];
const SCREEN_LINES: usize = 10;
const SETTLE_SECONDS: i64 = 120;
const SPACING_SECONDS: i64 = 60;
const HELD_TOO_LONG_MINUTES: i64 = 30;

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
    run.held = None;
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
    run.waiting = None;
    run.slot = None;
    run.held = None;
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
    if matches!(current(&run).map(|s| s.kind), Some(StepKind::Plan { .. })) {
        return (run, vec![Effect::Plan { step: id }]);
    }
    // A step whose agent died may have died of the memory the hold watches, so its second try
    // queues like any other start.
    if run.slot.is_none() {
        run.slot = run.steps.get(&id).map(|s| s.machine.clone());
    }
    run.state = RunState::Queued;
    (run, vec![])
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
        return held_too_long(run, now);
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

// The run stays queued so it starts by itself, but the person hears of it once.
fn held_too_long(mut run: Run, now: &DateTime<Local>) -> (Run, Vec<Effect>) {
    let label = run.subject.label();
    let Some(held) = run.held.as_mut().filter(|h| !h.told) else {
        return (run, vec![]);
    };
    let minutes = elapsed(&held.since, now).unwrap_or_default();
    if minutes < HELD_TOO_LONG_MINUTES {
        return (run, vec![]);
    }
    held.told = true;
    let text = format!(
        "{label} has been held for {}: {}",
        duration(minutes),
        held.reason
    );
    (run, vec![Effect::Notify { text }])
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
            let st = run.state_of(&w.step);
            st.answer = text;
            st.again = true;
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
        Seen::Pinned { step, pin } => {
            let st = run.state_of(&step);
            st.pin = Some(pin);
            st.again = false;
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
            run.held = None;
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
            run.state_of(&at).again = true;
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
            run.held = None;
            run.state = RunState::Running;
            run.step_since = now.to_rfc3339();
            let machine = run.slot.clone().unwrap_or_default();
            let retried = run.retried;
            let st = run.state_of(&id);
            if !retried {
                st.runs += 1;
            }
            st.started = now.to_rfc3339();
            st.machine = machine;
            (run, vec![Effect::Agent { step: id }])
        }
        Seen::Held(hold) if run.state == RunState::Queued => {
            // Only a machine that answers is judged, and held is what keeps a run off a machine
            // that came back, so an old offline note must not stop it later.
            run.offline_since = None;
            let was = run.held.take();
            run.held = hold.map(|(kind, machine, reason)| Held {
                kind,
                machine,
                reason,
                since: was
                    .as_ref()
                    .map_or_else(|| now.to_rfc3339(), |h| h.since.clone()),
                told: was.as_ref().is_some_and(|h| h.told),
            });
            (run, vec![])
        }
        // Nothing started, so this try does not count towards the step's limit.
        Seen::Unchanged { step, reason } => {
            let st = run.state_of(&step);
            st.runs = st.runs.saturating_sub(1);
            wait(run, WaitKind::Unchanged, &step, reason, "")
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
            st.judged = st.pin.clone();
            st.again = false;
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

// What the start gate knows of each machine's memory. The last time over the limit is kept
// between rounds, for the two minutes a machine must then stay under.
#[derive(Debug, Default)]
pub struct MemoryWatch {
    readings: HashMap<String, u64>,
    over_at: HashMap<String, DateTime<Local>>,
}

impl MemoryWatch {
    pub fn read(
        &mut self,
        readings: impl IntoIterator<Item = (String, u64)>,
        runs: &[Run],
        limit: u32,
        now: DateTime<Local>,
    ) {
        self.readings = readings.into_iter().collect();
        if limit == 0 {
            return;
        }
        for (machine, used) in &self.readings {
            if *used >= u64::from(limit) {
                self.over_at.insert(machine.clone(), now);
            }
        }
        // A restart forgets when a machine was last over, so a run held for memory starts the
        // two minutes again rather than slipping through.
        for run in runs.iter().filter(|r| r.state == RunState::Queued) {
            if let Some(h) = &run.held {
                if h.kind != HoldKind::Spacing {
                    self.over_at.entry(h.machine.clone()).or_insert(now);
                }
            }
        }
    }

    // A machine with no reading is not held for memory: it answers, and waiting for a figure
    // that may never come would stop its work for good. The two minutes after a reading over the
    // limit still run out first.
    pub fn hold(
        &self,
        machine: &str,
        limit: u32,
        now: &DateTime<Local>,
    ) -> Option<(HoldKind, String)> {
        if limit == 0 {
            return None;
        }
        if let Some(used) = self
            .readings
            .get(machine)
            .filter(|u| **u >= u64::from(limit))
        {
            let reason = format!(
                "{machine} is short of memory: {used}% is in use and the limit is {limit}%. This step starts once {machine} has stayed under the limit for two minutes."
            );
            return Some((HoldKind::Memory, reason));
        }
        let settling = self
            .over_at
            .get(machine)
            .is_some_and(|at| (*now - *at).num_seconds() < SETTLE_SECONDS);
        settling.then(|| {
            let reason = format!(
                "{machine} is back under its {limit}% memory limit. This step starts once it has stayed there for two minutes."
            );
            (HoldKind::Settling, reason)
        })
    }
}

fn last_starts(runs: &[Run]) -> HashMap<&str, DateTime<Local>> {
    let mut last: HashMap<&str, DateTime<Local>> = HashMap::new();
    for st in runs.iter().flat_map(|r| r.steps.values()) {
        let Ok(at) = DateTime::parse_from_rfc3339(&st.started) else {
            continue;
        };
        let at = at.with_timezone(&Local);
        if !st.machine.is_empty() && last.get(st.machine.as_str()).is_none_or(|l| *l < at) {
            last.insert(st.machine.as_str(), at);
        }
    }
    last
}

#[derive(Debug, Default, PartialEq)]
pub struct Admission {
    pub start: Vec<String>,
    pub held: HashMap<String, (HoldKind, String, String)>,
}

// Which queued runs may start their agent step now, oldest first, as slots on their machines
// allow, and why the rest on a machine that answers are held. A run only short of a slot is not
// held: it is plainly queued.
pub fn admit(
    runs: &[Run],
    cfg: &Cfg,
    up: &dyn Fn(&str) -> bool,
    memory: &MemoryWatch,
    now: &DateTime<Local>,
) -> Admission {
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
    let mut last = last_starts(runs);
    let mut out = Admission::default();
    for r in queued {
        let Some(m) = r.slot.as_deref() else {
            continue;
        };
        if !up(m) {
            continue;
        }
        if let Some((kind, reason)) = memory.hold(m, cfg.memory_limit, now) {
            out.held.insert(r.id.clone(), (kind, m.to_string(), reason));
            continue;
        }
        let used = busy.entry(m).or_default();
        if *used >= cfg.per_machine {
            continue;
        }
        let spaced = cfg.memory_limit > 0
            && last
                .get(m)
                .is_some_and(|at| (*now - *at).num_seconds() < SPACING_SECONDS);
        if spaced {
            let reason = format!(
                "{m} started a step less than a minute ago. Yardbell starts at most one step a minute on each machine."
            );
            out.held
                .insert(r.id.clone(), (HoldKind::Spacing, m.to_string(), reason));
            continue;
        }
        *used += 1;
        last.insert(m, *now);
        out.start.push(r.id.clone());
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
        assert_eq!((did, run.state), (vec![], RunState::Queued));
        assert!(run.retried);
        let (run, did) = step(run, Seen::Admitted, &cfg(), at(5));
        assert_eq!((did, run.state), (agent("implement"), RunState::Running));
        assert_eq!(
            run.steps["implement"].runs, 1,
            "a second try is not a new run"
        );
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
        let none = MemoryWatch::default();
        let starts = |up: &dyn Fn(&str) -> bool| admit(&runs, &cfg(), up, &none, &at(9)).start;
        assert_eq!(starts(&|_| true), vec!["r1", "r4"]);
        assert_eq!(starts(&|m| m == "devbox"), vec!["r4"]);
    }

    fn limited() -> Cfg {
        Cfg {
            memory_limit: 90,
            ..cfg()
        }
    }

    fn queued_on(id: &str, minute: u32, machine: &str) -> Run {
        Run {
            id: id.into(),
            state: RunState::Queued,
            step_since: at(minute).to_rfc3339(),
            slot: Some(machine.into()),
            ..Run::default()
        }
    }

    fn watching(readings: &[(&str, u64)], when: DateTime<Local>) -> MemoryWatch {
        let mut watch = MemoryWatch::default();
        let read = readings.iter().map(|(m, u)| (m.to_string(), *u));
        watch.read(read, &[], limited().memory_limit, when);
        watch
    }

    fn secs(minute: u32, second: u32) -> DateTime<Local> {
        at(minute) + Duration::seconds(i64::from(second))
    }

    #[test]
    fn a_machine_over_the_memory_limit_holds_its_steps_and_only_its_own() {
        let runs = vec![queued_on("r1", 1, "hp"), queued_on("r2", 2, "devbox")];
        let watch = watching(&[("hp", 90), ("devbox", 89)], at(5));
        let out = admit(&runs, &limited(), &|_| true, &watch, &at(5));
        assert_eq!(out.start, vec!["r2"]);
        let (kind, machine, reason) = &out.held["r1"];
        assert_eq!((*kind, machine.as_str()), (HoldKind::Memory, "hp"));
        assert!(reason.contains("hp is short of memory: 90%"), "{reason}");
        assert!(reason.contains("the limit is 90%"), "{reason}");
    }

    #[test]
    fn a_machine_under_the_limit_is_released_only_after_two_minutes() {
        let runs = vec![queued_on("r1", 1, "hp")];
        let mut watch = watching(&[("hp", 95)], at(5));
        let start = |watch: &MemoryWatch, now| admit(&runs, &limited(), &|_| true, watch, &now);
        let under = || [("hp".to_string(), 40)];

        watch.read(under(), &runs, 90, secs(5, 10));
        let out = start(&watch, secs(5, 10));
        assert!(out.start.is_empty());
        assert_eq!(out.held["r1"].0, HoldKind::Settling);
        assert!(start(&watch, secs(6, 59)).start.is_empty());
        assert_eq!(start(&watch, at(7)).start, vec!["r1"]);

        // Going over again starts the two minutes afresh.
        watch.read([("hp".to_string(), 91)], &runs, 90, secs(6, 30));
        watch.read(under(), &runs, 90, secs(6, 40));
        assert!(start(&watch, at(8)).start.is_empty());
        assert_eq!(start(&watch, secs(8, 30)).start, vec!["r1"]);
    }

    #[test]
    fn a_machine_with_no_reading_is_not_held_but_its_two_minutes_still_run() {
        let runs = vec![queued_on("r1", 1, "hp")];
        let start = |watch: &MemoryWatch, now| admit(&runs, &limited(), &|_| true, watch, &now);
        assert_eq!(
            start(&MemoryWatch::default(), at(5)).start,
            vec!["r1"],
            "never read"
        );
        let mut watch = watching(&[("hp", 95)], at(5));
        watch.read([], &runs, 90, secs(5, 10));
        assert_eq!(start(&watch, secs(5, 10)).held["r1"].0, HoldKind::Settling);
        assert_eq!(start(&watch, at(7)).start, vec!["r1"]);
    }

    #[test]
    fn a_restart_does_not_let_a_held_step_slip_through() {
        let mut run = queued_on("r1", 1, "hp");
        run.held = Some(Held {
            kind: HoldKind::Memory,
            machine: "hp".into(),
            reason: "short".into(),
            since: at(1).to_rfc3339(),
            told: false,
        });
        let runs = vec![run];
        let mut fresh = MemoryWatch::default();
        fresh.read([("hp".to_string(), 40)], &runs, 90, at(5));
        let out = admit(&runs, &limited(), &|_| true, &fresh, &at(5));
        assert_eq!(out.held["r1"].0, HoldKind::Settling);
        let later = admit(&runs, &limited(), &|_| true, &fresh, &at(7));
        assert_eq!(later.start, vec!["r1"]);
    }

    #[test]
    fn at_most_one_step_a_minute_starts_on_each_machine() {
        let mut roomy = limited();
        roomy.per_machine = 6;
        let mut started = queued_on("r0", 0, "hp");
        started.state = RunState::Running;
        started.state_of("a").machine = "hp".into();
        started.state_of("a").started = at(5).to_rfc3339();
        let runs = vec![
            started,
            queued_on("r1", 1, "hp"),
            queued_on("r2", 2, "devbox"),
            queued_on("r3", 3, "devbox"),
        ];
        let none = MemoryWatch::default();
        let out = admit(&runs, &roomy, &|_| true, &none, &secs(5, 59));
        assert_eq!(out.start, vec!["r2"], "one a round, on each machine");
        assert_eq!(out.held["r1"].0, HoldKind::Spacing);
        assert_eq!(out.held["r3"].0, HoldKind::Spacing);
        let out = admit(&runs, &roomy, &|_| true, &none, &at(6));
        assert_eq!(out.start, vec!["r1", "r2"]);
    }

    #[test]
    fn a_run_short_of_a_slot_is_plainly_queued() {
        let mut full = queued_on("r0", 0, "hp");
        full.state = RunState::Running;
        let mut slots = limited();
        slots.per_machine = 1;
        let runs = vec![full, queued_on("r1", 1, "hp")];
        let out = admit(&runs, &slots, &|_| true, &MemoryWatch::default(), &at(5));
        assert_eq!(out, Admission::default());
    }

    #[test]
    fn a_machine_that_is_down_is_not_judged() {
        let runs = vec![queued_on("r1", 1, "hp")];
        let watch = watching(&[("hp", 95)], at(5));
        let out = admit(&runs, &limited(), &|_| false, &watch, &at(5));
        assert_eq!(out, Admission::default());
    }

    #[test]
    fn the_off_setting_holds_nothing_and_spaces_nothing() {
        let mut off = cfg();
        off.memory_limit = 0;
        off.per_machine = 6;
        let mut started = queued_on("r0", 0, "hp");
        started.state = RunState::Running;
        started.state_of("a").machine = "hp".into();
        started.state_of("a").started = at(5).to_rfc3339();
        let runs = vec![started, queued_on("r1", 1, "hp"), queued_on("r2", 2, "hp")];
        let mut watch = MemoryWatch::default();
        watch.read([("hp".to_string(), 99)], &runs, 0, at(5));
        let out = admit(&runs, &off, &|_| true, &watch, &at(5));
        assert_eq!(out.start, vec!["r1", "r2"]);
        assert!(out.held.is_empty());
    }

    fn held_seen(kind: HoldKind) -> Seen {
        Seen::Held(Some((kind, "hp".into(), "hp is short of memory".into())))
    }

    #[test]
    fn a_held_run_keeps_its_since_and_tells_the_person_once() {
        let run = queued_on("r1", 1, "hp");
        let (run, _) = step(run, held_seen(HoldKind::Memory), &cfg(), at(1));
        let (run, _) = step(run, held_seen(HoldKind::Settling), &cfg(), at(20));
        assert_eq!(run.held.as_ref().unwrap().since, at(1).to_rfc3339());
        let (run, did) = step(run, Seen::Tick, &cfg(), at(30));
        assert_eq!(did, vec![]);
        let (run, did) = step(run, Seen::Tick, &cfg(), at(31));
        match &did[..] {
            [Effect::Notify { text }] => {
                assert!(text.contains("held for 30 min"), "{text}");
                assert!(text.contains("hp is short of memory"), "{text}");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(run.state, RunState::Queued, "it still starts by itself");
        assert!(run.held.as_ref().unwrap().told);
        let (run, did) = step(run, Seen::Tick, &cfg(), at(40));
        assert_eq!(did, vec![]);
        let (run, _) = step(run, held_seen(HoldKind::Memory), &cfg(), at(41));
        assert!(run.held.as_ref().unwrap().told, "not told a second time");
        let (run, _) = step(run, Seen::Admitted, &cfg(), at(42));
        assert_eq!((run.state, run.held), (RunState::Running, None));
    }

    #[test]
    fn being_judged_clears_an_old_offline_note() {
        let mut run = queued_on("r1", 1, "hp");
        run.offline_since = Some(at(1).to_rfc3339());
        let (run, _) = step(run, held_seen(HoldKind::Memory), &cfg(), at(5));
        assert_eq!(run.offline_since, None);
        let (run, _) = step(run, Seen::Tick, &cfg(), at(40));
        assert_eq!(run.state, RunState::Queued);
    }

    #[test]
    fn a_saved_run_with_no_hold_still_loads() {
        let run: Run = serde_json::from_str(r#"{"id":"r1","state":"queued"}"#).unwrap();
        assert_eq!(run.held, None);
    }

    #[test]
    fn a_second_try_queues_on_its_machine_so_the_gate_sees_it() {
        let mut run = at_step("Implement my tickets", "implement");
        run.slot = None;
        let (run, _) = step(
            run,
            Seen::Started {
                step: "implement".into(),
                result: Err("no room".into()),
            },
            &cfg(),
            at(5),
        );
        assert_eq!(
            (run.state, run.slot.as_deref()),
            (RunState::Queued, Some("hp"))
        );
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
