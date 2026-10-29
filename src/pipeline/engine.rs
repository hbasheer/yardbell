use super::prompts;
use super::record::{
    Effect, Entry, Finding, ParkKind, Parked, Question, Record, Seen, Stage, Triage,
};
use crate::config::Pipeline as Cfg;
use crate::dispatch::GroupOutcome;
use chrono::{DateTime, Duration, Local};
use std::collections::HashMap;

pub const TRIAGE_AT_ONCE: usize = 2;
const OFFLINE_MINUTES: i64 = 30;
const RETRY_MINUTES: [i64; 4] = [1, 2, 4, 8];
const FAILED_LINES: usize = 10;
const SCREEN_LINES: usize = 12;

fn to(mut r: Record, stage: Stage, note: &str, now: &DateTime<Local>) -> Record {
    r.stage = stage;
    r.stage_since = now.to_rfc3339();
    r.retried = false;
    r.history.push(Entry {
        stage,
        at: now.to_rfc3339(),
        note: note.to_string(),
    });
    r
}

fn open(findings: &[Finding]) -> Vec<Finding> {
    findings
        .iter()
        .filter(|f| matches!(f.severity.as_str(), "high" | "medium"))
        .cloned()
        .collect()
}

fn report(outcome: &GroupOutcome) -> String {
    std::iter::once(outcome.summary.clone())
        .chain(outcome.details.iter().map(|d| format!("- {d}")))
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn after_pull(cfg: &Cfg) -> Effect {
    if cfg.linear_state.is_empty() {
        Effect::Summarise
    } else {
        Effect::MoveLinear
    }
}

fn done_words(r: &Record) -> String {
    match &r.pull {
        Some(p) => format!("{} is done: draft #{} is open", r.id, p.number),
        None => format!("{} is done", r.id),
    }
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.trim_end().lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn park(
    mut r: Record,
    kind: ParkKind,
    reason: String,
    screen: String,
    now: &DateTime<Local>,
) -> (Record, Vec<Effect>) {
    let words = if kind.answerable() {
        format!("{} needs your answer", r.id)
    } else {
        format!("{} stopped: {reason}", r.id)
    };
    r.parked = Some(Parked {
        kind,
        reason: reason.clone(),
        from: r.stage,
        screen: tail(&screen, SCREEN_LINES),
    });
    (
        to(r, Stage::Parked, &reason, now),
        vec![Effect::Notify(words)],
    )
}

fn fail(mut r: Record, text: &str, now: &DateTime<Local>) -> (Record, Vec<Effect>) {
    r.failed_at = Some(r.stage);
    r.failed = tail(text, FAILED_LINES);
    let words = format!("{} failed in {}", r.id, r.stage.word());
    (to(r, Stage::Failed, "", now), vec![Effect::Notify(words)])
}

// A stage that ended without a usable result runs once more before the ticket fails.
fn again(mut r: Record, text: &str, cfg: &Cfg, now: &DateTime<Local>) -> (Record, Vec<Effect>) {
    if r.retried {
        return fail(r, text, now);
    }
    r.retried = true;
    let effects = effect_for(&r, r.stage, cfg);
    (r, effects)
}

fn effect_for(r: &Record, stage: Stage, cfg: &Cfg) -> Vec<Effect> {
    let done = |step: &str| r.finished.iter().any(|f| f == step);
    match stage {
        Stage::Triage => vec![Effect::Triage],
        Stage::Implement => vec![Effect::Implement],
        Stage::Review => vec![Effect::Review],
        Stage::Fix => vec![Effect::Send(r.sent.clone())],
        Stage::Qa => vec![Effect::MoveToTest],
        Stage::Finish if !done("push") => vec![Effect::Push],
        Stage::Finish if !done("pull") => vec![Effect::OpenPull],
        Stage::Finish if !done("linear") => vec![after_pull(cfg)],
        Stage::Finish => vec![Effect::Summarise],
        _ => vec![],
    }
}

fn asks(o: &GroupOutcome) -> bool {
    o.summary.trim_end().ends_with('?')
        || o.details
            .last()
            .is_some_and(|d| d.trim_end().ends_with('?'))
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

fn send(
    mut r: Record,
    fix_for: Stage,
    text: String,
    note: &str,
    now: &DateTime<Local>,
) -> (Record, Vec<Effect>) {
    r.fix_for = Some(fix_for);
    r.sent = text.clone();
    (to(r, Stage::Fix, note, now), vec![Effect::Send(text)])
}

fn answer(mut r: Record, text: String, now: &DateTime<Local>) -> (Record, Vec<Effect>) {
    let Some(p) = r.parked.clone().filter(|p| p.kind.answerable()) else {
        return (r, vec![]);
    };
    r.parked = None;
    match p.kind {
        ParkKind::Questions => {
            for q in r.questions.iter_mut().filter(|q| q.answer.is_empty()) {
                q.answer = text.clone();
                q.at = now.to_rfc3339();
            }
            (to(r, Stage::Triage, "answered", now), vec![Effect::Triage])
        }
        ParkKind::Asked => (to(r, p.from, "answered", now), vec![Effect::Answer(text)]),
        ParkKind::Findings => {
            let what = format!(
                "The findings still open:\n{}",
                r.findings
                    .iter()
                    .map(|f| format!("- {f}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            let sent = prompts::fix_with(&text, &what);
            send(r, Stage::Review, sent, "answered", now)
        }
        _ => {
            let what = format!("QA's report:\n{}", r.qa_report);
            let sent = prompts::fix_with(&text, &what);
            send(r, Stage::Qa, sent, "answered", now)
        }
    }
}

fn retry(mut r: Record, cfg: &Cfg, now: &DateTime<Local>) -> (Record, Vec<Effect>) {
    if r.stage == Stage::Failed {
        let Some(stage) = r.failed_at.take() else {
            return (r, vec![]);
        };
        r.failed.clear();
        let effects = effect_for(&r, stage, cfg);
        return (to(r, stage, "retried", now), effects);
    }
    let Some(p) = r.parked.take() else {
        return (r, vec![]);
    };
    if p.kind == ParkKind::Offline {
        r.machine.clear();
        r.folder.clear();
        r.branch.clear();
        r.waiting = None;
        return (
            to(r, Stage::Queued, "retried: triage picks again", now),
            vec![],
        );
    }
    let session_runs = matches!(p.kind, ParkKind::Asked | ParkKind::TooLong)
        && matches!(
            p.from,
            Stage::Implement | Stage::Review | Stage::Fix | Stage::Qa
        );
    let effects = if session_runs {
        vec![]
    } else {
        effect_for(&r, p.from, cfg)
    };
    (to(r, p.from, "retried", now), effects)
}

fn tick(mut r: Record, cfg: &Cfg, now: &DateTime<Local>) -> (Record, Vec<Effect>) {
    if r.stage == Stage::Triage {
        if let Some(at) = &r.next_try {
            if elapsed(at, now).is_some_and(|m| m >= 0) {
                r.next_try = None;
                return (r, vec![Effect::Triage]);
            }
        }
    }
    if r.stage == Stage::Queued {
        if let Some(since) = &r.waiting {
            if elapsed(since, now).is_some_and(|m| m >= OFFLINE_MINUTES) {
                let reason = format!("{} is offline", r.machine);
                return park(r, ParkKind::Offline, reason, String::new(), now);
            }
        }
        return (r, vec![]);
    }
    if matches!(
        r.stage,
        Stage::Triage | Stage::Implement | Stage::Review | Stage::Fix | Stage::Qa
    ) {
        if let Some(m) = elapsed(&r.stage_since, now).filter(|m| *m > cfg.stage_minutes as i64) {
            let reason = format!("{} has run for {}", r.stage.word(), duration(m));
            return park(r, ParkKind::TooLong, reason, String::new(), now);
        }
    }
    (r, vec![])
}

pub fn step(mut r: Record, seen: Seen, cfg: &Cfg, now: DateTime<Local>) -> (Record, Vec<Effect>) {
    let now = &now;
    let working = matches!(
        r.stage,
        Stage::Implement | Stage::Review | Stage::Fix | Stage::Qa
    );
    match (r.stage, seen) {
        (Stage::Done | Stage::Dropped, _) => (r, vec![]),
        (_, Seen::Drop) => (to(r, Stage::Dropped, "", now), vec![Effect::StopSessions]),
        (_, Seen::Retry) => retry(r, cfg, now),
        (Stage::Parked, Seen::Answer(text)) => answer(r, text, now),
        (Stage::Parked | Stage::Failed, _) => (r, vec![]),
        (_, Seen::Tick) => tick(r, cfg, now),
        (_, Seen::Closed(_)) => {
            let reason = format!("{} was closed in Linear", r.id);
            park(r, ParkKind::Closed, reason, String::new(), now)
        }
        (_, Seen::Refused(reason)) => park(r, ParkKind::Refused, reason, String::new(), now),
        (Stage::Queued, Seen::Offline) if !r.machine.is_empty() => {
            r.waiting.get_or_insert_with(|| now.to_rfc3339());
            (r, vec![])
        }
        (Stage::Queued, Seen::Admitted) if r.machine.is_empty() => {
            (to(r, Stage::Triage, "", now), vec![Effect::Triage])
        }
        (Stage::Queued, Seen::Admitted) => {
            r.waiting = None;
            let note = format!("on {}", r.machine);
            (to(r, Stage::Implement, &note, now), vec![Effect::Implement])
        }
        (Stage::Triage, Seen::Triaged(Ok(t))) if !t.questions.is_empty() => {
            let at = now.to_rfc3339();
            r.questions.extend(t.questions.iter().map(|q| Question {
                asked: q.clone(),
                answer: String::new(),
                at: at.clone(),
            }));
            let reason = format!(
                "Triage has {} {}",
                t.questions.len(),
                if t.questions.len() == 1 {
                    "question"
                } else {
                    "questions"
                }
            );
            park(r, ParkKind::Questions, reason, String::new(), now)
        }
        (Stage::Triage, Seen::Triaged(Ok(t))) => {
            let Triage {
                machine,
                folder,
                branch,
                reason,
                ..
            } = t;
            r.machine = machine;
            r.folder = folder;
            r.branch = branch;
            r.reason = reason.clone();
            r.tries = 0;
            (to(r, Stage::Queued, &reason, now), vec![])
        }
        (Stage::Triage, Seen::Triaged(Err(e))) if e.starts_with("Linear") => {
            r.tries += 1;
            let wait = RETRY_MINUTES[(r.tries as usize - 1).min(RETRY_MINUTES.len() - 1)];
            r.next_try = Some((*now + Duration::minutes(wait)).to_rfc3339());
            (r, vec![])
        }
        (Stage::Triage, Seen::Triaged(Err(e))) => again(r, &e, cfg, now),
        (stage, Seen::Started(Ok(name))) => {
            match stage {
                Stage::Implement => r.sessions.implement = name,
                Stage::Review => r.sessions.review = name,
                Stage::Qa => r.sessions.qa = name,
                _ => {}
            }
            (r, vec![])
        }
        (_, Seen::Started(Err(e))) if working => again(r, &e, cfg, now),
        (_, Seen::NoResult(screen)) if working => again(r, &screen, cfg, now),
        (_, Seen::Sent(Err(e))) if working => again(r, &e, cfg, now),
        (_, Seen::Waiting(screen)) if working => park(
            r,
            ParkKind::Asked,
            "The agent is asking something".into(),
            screen,
            now,
        ),
        (Stage::Implement | Stage::Fix | Stage::Qa, Seen::Idle { outcome, verdict })
            if outcome.status == "failed" && verdict.is_none() =>
        {
            if asks(&outcome) {
                return park(
                    r,
                    ParkKind::Asked,
                    "The agent is asking something".into(),
                    report(&outcome),
                    now,
                );
            }
            again(r, &report(&outcome), cfg, now)
        }
        (Stage::Implement, Seen::Idle { outcome, .. }) => {
            r.outcome = outcome.summary.clone();
            (to(r, Stage::Review, "", now), vec![Effect::Review])
        }
        (Stage::Fix, Seen::Idle { outcome, .. }) => {
            r.outcome = outcome.summary.clone();
            if r.fix_for == Some(Stage::Qa) {
                (to(r, Stage::Qa, "", now), vec![Effect::MoveToTest])
            } else {
                (to(r, Stage::Review, "", now), vec![Effect::Review])
            }
        }
        (Stage::Review, Seen::Reviewed { findings }) => {
            let open = open(&findings);
            if open.is_empty() {
                return (to(r, Stage::Qa, "", now), vec![Effect::MoveToTest]);
            }
            r.findings = open
                .iter()
                .map(|f| format!("{} {}", f.place, f.text).trim().to_string())
                .collect();
            if r.round >= cfg.review_rounds {
                let reason = format!(
                    "Review still found {} after {} {}",
                    count(open.len(), "problem", "problems"),
                    r.round,
                    if r.round == 1 { "round" } else { "rounds" }
                );
                return park(r, ParkKind::Findings, reason, String::new(), now);
            }
            r.round += 1;
            let note = format!("round {}", r.round);
            let text = prompts::fix_findings(&open);
            send(r, Stage::Review, text, &note, now)
        }
        (Stage::Qa, Seen::Idle { outcome, verdict }) => {
            if verdict == Some(true) {
                return (to(r, Stage::Finish, "", now), vec![Effect::Push]);
            }
            r.qa_report = report(&outcome);
            if r.qa_tries >= cfg.qa_retries {
                let reason = format!(
                    "QA still fails after {}",
                    count(r.qa_tries as usize, "fix", "fixes")
                );
                return park(r, ParkKind::QaFailed, reason, String::new(), now);
            }
            r.qa_tries += 1;
            let text = prompts::fix_qa(&r.qa_report);
            send(r, Stage::Qa, text, "after QA", now)
        }
        (Stage::Finish, Seen::Pushed(Ok(()))) => {
            r.finished.push("push".into());
            (r, vec![Effect::OpenPull])
        }
        (Stage::Finish, Seen::Pushed(Err(e))) => park(r, ParkKind::Push, e, String::new(), now),
        (Stage::Finish, Seen::Opened(opened)) => {
            match opened {
                Ok(pull) => {
                    r.pull = Some(pull);
                    r.finished.push("pull".into());
                }
                Err(e) => r.notes.push(format!("The draft was not opened: {e}")),
            }
            (r, vec![after_pull(cfg)])
        }
        (Stage::Finish, Seen::Moved(moved)) => {
            match moved {
                Ok(()) => r.finished.push("linear".into()),
                Err(e) => r
                    .notes
                    .push(format!("The ticket was not moved in Linear: {e}")),
            }
            (r, vec![Effect::Summarise])
        }
        (Stage::Finish, Seen::Summarised(written)) => {
            match written {
                Ok((summary, comment)) => {
                    r.summary = summary;
                    r.linear_comment = comment;
                }
                Err(e) => {
                    r.notes.push(format!("No summary was written: {e}"));
                    r.summary = r.notes.join("\n");
                }
            }
            let words = done_words(&r);
            (to(r, Stage::Done, "", now), vec![Effect::Notify(words)])
        }
        (_, _) => (r, vec![]),
    }
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// Which queued tickets may move on now, oldest first. Triage needs no machine, so only a few
// run at once; a ticket with a machine waits for a slot on it.
pub fn admit(records: &[Record], cfg: &Cfg, up: &dyn Fn(&str) -> bool) -> Vec<String> {
    let since = |r: &Record| DateTime::parse_from_rfc3339(&r.stage_since).ok();
    let mut queued: Vec<&Record> = records
        .iter()
        .filter(|r| r.stage == Stage::Queued)
        .collect();
    queued.sort_by_key(|r| since(r));
    let mut triaging = records.iter().filter(|r| r.stage == Stage::Triage).count();
    let mut busy: HashMap<&str, u32> = HashMap::new();
    for r in records.iter().filter(|r| r.stage.on_machine()) {
        *busy.entry(r.machine.as_str()).or_default() += 1;
    }
    let mut out = Vec::new();
    for r in queued {
        if r.machine.is_empty() {
            if triaging < TRIAGE_AT_ONCE {
                triaging += 1;
                out.push(r.id.clone());
            }
            continue;
        }
        let used = busy.entry(r.machine.as_str()).or_default();
        if up(&r.machine) && *used < cfg.per_machine {
            *used += 1;
            out.push(r.id.clone());
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::dispatch::GroupOutcome;
    use crate::pipeline::record::{ParkKind, Parked, PullRef, Question};
    use chrono::TimeZone;

    pub(crate) fn cfg() -> Cfg {
        Cfg {
            machines: vec!["hp".into(), "mini".into()],
            test_machine: "devbox".into(),
            per_machine: 2,
            review_rounds: 2,
            qa_retries: 1,
            stage_minutes: 120,
            linear_state: "In Review".into(),
            qa_instructions: String::new(),
        }
    }

    pub(crate) fn at(minute: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 29, 9, minute, 0).unwrap()
    }

    pub(crate) fn record(stage: Stage) -> Record {
        Record {
            id: "COM-1".into(),
            title: "Fix the login".into(),
            stage,
            stage_since: at(0).to_rfc3339(),
            ..Record::default()
        }
    }

    pub(crate) fn outcome(status: &'static str) -> GroupOutcome {
        GroupOutcome {
            status,
            summary: "Made the change and ran the tests.".into(),
            branch: "com-1-fix-the-login".into(),
            details: vec!["12 passed".into()],
        }
    }

    fn finding(severity: &str, place: &str, text: &str) -> Finding {
        Finding {
            severity: severity.into(),
            place: place.into(),
            text: text.into(),
        }
    }

    fn triage() -> Triage {
        Triage {
            machine: "hp".into(),
            folder: "acme/app".into(),
            branch: "com-1-fix-the-login".into(),
            reason: "hp has acme/app and the most room".into(),
            questions: vec![],
        }
    }

    #[test]
    fn a_ticket_walks_every_stage_to_done() {
        let cfg = cfg();
        let mut r = record(Stage::Queued);
        let steps: Vec<(Seen, Stage, Vec<Effect>)> = vec![
            (Seen::Admitted, Stage::Triage, vec![Effect::Triage]),
            (Seen::Triaged(Ok(triage())), Stage::Queued, vec![]),
            (Seen::Admitted, Stage::Implement, vec![Effect::Implement]),
            (
                Seen::Started(Ok("hp-app-com-1".into())),
                Stage::Implement,
                vec![],
            ),
            (
                Seen::Idle {
                    outcome: outcome("done"),
                    verdict: None,
                },
                Stage::Review,
                vec![Effect::Review],
            ),
            (
                Seen::Started(Ok("hp-app-com-1-review".into())),
                Stage::Review,
                vec![],
            ),
            (
                Seen::Reviewed { findings: vec![] },
                Stage::Qa,
                vec![Effect::MoveToTest],
            ),
            (
                Seen::Started(Ok("devbox-app-com-1".into())),
                Stage::Qa,
                vec![],
            ),
            (
                Seen::Idle {
                    outcome: outcome("done"),
                    verdict: Some(true),
                },
                Stage::Finish,
                vec![Effect::Push],
            ),
            (Seen::Pushed(Ok(())), Stage::Finish, vec![Effect::OpenPull]),
            (
                Seen::Opened(Ok(PullRef {
                    url: "https://github.com/acme/app/pull/12".into(),
                    number: 12,
                })),
                Stage::Finish,
                vec![Effect::MoveLinear],
            ),
            (Seen::Moved(Ok(())), Stage::Finish, vec![Effect::Summarise]),
        ];
        for (seen, stage, effects) in steps {
            let label = format!("{seen:?}");
            let (next, did) = step(r, seen, &cfg, at(5));
            assert_eq!(next.stage, stage, "after {label}");
            assert_eq!(did, effects, "after {label}");
            r = next;
        }
        assert_eq!(r.machine, "hp");
        assert_eq!(r.folder, "acme/app");
        assert_eq!(r.branch, "com-1-fix-the-login");
        assert_eq!(r.sessions.implement, "hp-app-com-1");
        assert_eq!(r.sessions.review, "hp-app-com-1-review");
        assert_eq!(r.sessions.qa, "devbox-app-com-1");
        assert_eq!(r.finished, vec!["push", "pull", "linear"]);
        assert_eq!(r.pull.as_ref().unwrap().number, 12);
        let (done, did) = step(
            r,
            Seen::Summarised(Ok(("Fixed it.".into(), "Fixed in #12.".into()))),
            &cfg,
            at(6),
        );
        assert_eq!(done.stage, Stage::Done);
        assert_eq!(done.summary, "Fixed it.");
        assert_eq!(done.linear_comment, "Fixed in #12.");
        assert!(matches!(&did[..], [Effect::Notify(text)] if text.contains("COM-1")));
        let stages: Vec<Stage> = done.history.iter().map(|e| e.stage).collect();
        assert_eq!(
            stages,
            vec![
                Stage::Triage,
                Stage::Queued,
                Stage::Implement,
                Stage::Review,
                Stage::Qa,
                Stage::Finish,
                Stage::Done
            ]
        );
        assert_eq!(done.stage_since, at(6).to_rfc3339());
    }

    #[test]
    fn review_findings_go_back_to_the_implementer() {
        let (r, did) = step(
            record(Stage::Review),
            Seen::Reviewed {
                findings: vec![finding("high", "src/login.rs:42", "The redirect loops.")],
            },
            &cfg(),
            at(5),
        );
        assert_eq!(r.stage, Stage::Fix);
        assert_eq!(r.round, 1);
        assert_eq!(r.fix_for, Some(Stage::Review));
        match &did[..] {
            [Effect::Send(text)] => {
                assert!(
                    text.contains("The redirect loops.") && text.contains("src/login.rs:42"),
                    "{text}"
                )
            }
            other => panic!("{other:?}"),
        }
        let (r, did) = step(
            r,
            Seen::Idle {
                outcome: outcome("done"),
                verdict: None,
            },
            &cfg(),
            at(6),
        );
        assert_eq!(r.stage, Stage::Review);
        assert_eq!(did, vec![Effect::Review]);
    }

    #[test]
    fn only_low_findings_count_as_ready() {
        let (r, did) = step(
            record(Stage::Review),
            Seen::Reviewed {
                findings: vec![finding("low", "", "Typo."), finding("low", "a.rs", "Name.")],
            },
            &cfg(),
            at(5),
        );
        assert_eq!(r.stage, Stage::Qa);
        assert_eq!(did, vec![Effect::MoveToTest]);
    }

    #[test]
    fn a_qa_fail_sends_the_report_back_once() {
        let mut failed = outcome("done");
        failed.details = vec!["checkout_spec.rb: 1 failure".into()];
        let (r, did) = step(
            record(Stage::Qa),
            Seen::Idle {
                outcome: failed,
                verdict: Some(false),
            },
            &cfg(),
            at(5),
        );
        assert_eq!(r.stage, Stage::Fix);
        assert_eq!(r.fix_for, Some(Stage::Qa));
        assert_eq!(r.qa_tries, 1);
        assert!(r.qa_report.contains("checkout_spec.rb: 1 failure"));
        assert!(matches!(&did[..], [Effect::Send(text)] if text.contains("checkout_spec.rb")));
        let (r, did) = step(
            r,
            Seen::Idle {
                outcome: outcome("done"),
                verdict: None,
            },
            &cfg(),
            at(6),
        );
        assert_eq!(r.stage, Stage::Qa);
        assert_eq!(did, vec![Effect::MoveToTest]);
    }

    #[test]
    fn no_linear_state_skips_the_move() {
        let mut cfg = cfg();
        cfg.linear_state.clear();
        let (_, did) = step(
            record(Stage::Finish),
            Seen::Opened(Ok(PullRef {
                url: "u".into(),
                number: 1,
            })),
            &cfg,
            at(5),
        );
        assert_eq!(did, vec![Effect::Summarise]);
    }

    #[test]
    fn a_failed_pull_is_noted_and_the_ticket_finishes() {
        let cfg = cfg();
        let (r, did) = step(
            record(Stage::Finish),
            Seen::Opened(Err("gh is not logged in on hp".into())),
            &cfg,
            at(5),
        );
        assert!(r
            .notes
            .iter()
            .any(|n| n.contains("gh is not logged in on hp")));
        assert!(r.pull.is_none());
        assert_eq!(did, vec![Effect::MoveLinear]);
        let (r, _) = step(r, Seen::Moved(Ok(())), &cfg, at(5));
        let (r, _) = step(r, Seen::Summarised(Err("no reply".into())), &cfg, at(6));
        assert_eq!(r.stage, Stage::Done);
        assert!(r.summary.contains("gh is not logged in on hp"));
    }

    #[test]
    fn admit_respects_slots_and_order() {
        let cfg = cfg();
        let queued = |id: &str, minute: u32, machine: &str| Record {
            id: id.into(),
            stage: Stage::Queued,
            stage_since: at(minute).to_rfc3339(),
            machine: machine.into(),
            ..Record::default()
        };
        let mut busy = queued("COM-0", 0, "hp");
        busy.stage = Stage::Implement;
        let records = vec![
            queued("COM-3", 3, "hp"),
            queued("COM-1", 1, "hp"),
            queued("COM-2", 2, "hp"),
            busy,
        ];
        assert_eq!(admit(&records, &cfg, &|_| true), vec!["COM-1"]);
        assert!(admit(&records, &cfg, &|_| false).is_empty());

        let mut triaging = queued("COM-0", 0, "");
        triaging.stage = Stage::Triage;
        let records = vec![
            queued("COM-6", 6, ""),
            queued("COM-5", 5, ""),
            queued("COM-7", 7, ""),
            triaging,
        ];
        assert_eq!(admit(&records, &cfg, &|_| true), vec!["COM-5"]);
    }

    fn parked(r: &Record) -> (ParkKind, Stage) {
        let p = r.parked.as_ref().expect("parked");
        assert_eq!(r.stage, Stage::Parked);
        (p.kind, p.from)
    }

    fn notified(did: &[Effect]) -> bool {
        did.iter()
            .any(|e| matches!(e, Effect::Notify(t) if t.contains("COM-1")))
    }

    #[test]
    fn questions_park_the_ticket() {
        let mut t = triage();
        t.questions = vec!["Which page?".into(), "Keep old links?".into()];
        let (r, did) = step(record(Stage::Triage), Seen::Triaged(Ok(t)), &cfg(), at(5));
        assert_eq!(parked(&r), (ParkKind::Questions, Stage::Triage));
        assert_eq!(r.questions.len(), 2);
        assert_eq!(r.questions[0].asked, "Which page?");
        assert!(notified(&did));
    }

    #[test]
    fn a_linear_failure_waits_and_tries_again() {
        let cfg = cfg();
        let err = || Seen::Triaged(Err("Linear did not answer: timeout".into()));
        let (r, did) = step(record(Stage::Triage), err(), &cfg, at(0));
        assert_eq!(r.stage, Stage::Triage);
        assert!(did.is_empty());
        assert_eq!(r.next_try.as_deref(), Some(at(1).to_rfc3339().as_str()));
        let (r, did) = step(r, Seen::Tick, &cfg, at(0));
        assert!(did.is_empty(), "too early");
        let (r, did) = step(r, Seen::Tick, &cfg, at(1));
        assert_eq!(did, vec![Effect::Triage]);
        assert!(r.next_try.is_none());
        let (r, _) = step(r, err(), &cfg, at(1));
        assert_eq!(r.next_try.as_deref(), Some(at(3).to_rfc3339().as_str()));
        let (r, _) = step(r, err(), &cfg, at(3));
        let (r, _) = step(r, err(), &cfg, at(7));
        let (r, _) = step(r, err(), &cfg, at(15));
        assert_eq!(r.next_try.as_deref(), Some(at(23).to_rfc3339().as_str()));
        assert_eq!(r.stage, Stage::Triage);
    }

    #[test]
    fn a_waiting_session_parks_with_its_screen() {
        for stage in [Stage::Implement, Stage::Fix, Stage::Review, Stage::Qa] {
            let (r, did) = step(
                record(stage),
                Seen::Waiting("Allow edit?\n❯ 1. Yes".into()),
                &cfg(),
                at(5),
            );
            assert_eq!(parked(&r), (ParkKind::Asked, stage));
            assert!(r.parked.as_ref().unwrap().screen.contains("Allow edit?"));
            assert!(notified(&did));
        }
    }

    #[test]
    fn a_failed_result_with_a_question_parks() {
        let mut o = outcome("failed");
        o.summary = "The ticket names two pages. Which one should redirect?".into();
        let (r, _) = step(
            record(Stage::Implement),
            Seen::Idle {
                outcome: o,
                verdict: None,
            },
            &cfg(),
            at(5),
        );
        assert_eq!(parked(&r), (ParkKind::Asked, Stage::Implement));
        assert!(r
            .parked
            .unwrap()
            .screen
            .contains("Which one should redirect?"));
    }

    #[test]
    fn no_result_runs_the_stage_once_more_then_fails() {
        let cfg = cfg();
        let (r, did) = step(
            record(Stage::Implement),
            Seen::NoResult("crashed".into()),
            &cfg,
            at(5),
        );
        assert_eq!(r.stage, Stage::Implement);
        assert!(r.retried);
        assert_eq!(did, vec![Effect::Implement]);
        let screen: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let (r, _) = step(r, Seen::NoResult(screen), &cfg, at(6));
        assert_eq!(r.stage, Stage::Failed);
        assert_eq!(r.failed_at, Some(Stage::Implement));
        assert!(
            r.failed.starts_with("line 11") && r.failed.ends_with("line 20"),
            "{}",
            r.failed
        );
        let (r, did) = step(
            record(Stage::Qa),
            Seen::Idle {
                outcome: outcome("failed"),
                verdict: None,
            },
            &cfg,
            at(5),
        );
        assert_eq!((r.stage, did), (Stage::Qa, vec![Effect::MoveToTest]));
        let mut fix = record(Stage::Fix);
        fix.sent = "Fix these".into();
        let (_, did) = step(fix, Seen::Started(Err("tmux died".into())), &cfg, at(5));
        assert_eq!(did, vec![Effect::Send("Fix these".into())]);
    }

    #[test]
    fn review_rounds_run_out() {
        let mut r = record(Stage::Review);
        r.round = 2;
        let (r, did) = step(
            r,
            Seen::Reviewed {
                findings: vec![finding("medium", "a.rs:1", "Still wrong.")],
            },
            &cfg(),
            at(5),
        );
        assert_eq!(parked(&r), (ParkKind::Findings, Stage::Review));
        assert_eq!(r.findings, vec!["a.rs:1 Still wrong."]);
        assert!(notified(&did));
    }

    #[test]
    fn qa_retries_run_out() {
        let mut r = record(Stage::Qa);
        r.qa_tries = 1;
        let (r, _) = step(
            r,
            Seen::Idle {
                outcome: outcome("done"),
                verdict: Some(false),
            },
            &cfg(),
            at(5),
        );
        assert_eq!(parked(&r), (ParkKind::QaFailed, Stage::Qa));
        assert!(!r.qa_report.is_empty());
    }

    #[test]
    fn a_refused_push_parks() {
        let (r, did) = step(
            record(Stage::Finish),
            Seen::Pushed(Err("a key in config/secrets.yml".into())),
            &cfg(),
            at(5),
        );
        assert_eq!(parked(&r), (ParkKind::Push, Stage::Finish));
        assert!(r
            .parked
            .as_ref()
            .unwrap()
            .reason
            .contains("config/secrets.yml"));
        assert!(notified(&did));
        let (r, _) = step(
            record(Stage::Implement),
            Seen::Refused("deny start_session on hp".into()),
            &cfg(),
            at(5),
        );
        assert_eq!(parked(&r), (ParkKind::Refused, Stage::Implement));
    }

    #[test]
    fn an_offline_machine_parks_after_30_minutes() {
        let cfg = cfg();
        let mut q = record(Stage::Queued);
        q.machine = "hp".into();
        let (r, _) = step(q, Seen::Offline, &cfg, at(0));
        assert_eq!(r.waiting.as_deref(), Some(at(0).to_rfc3339().as_str()));
        let (r, _) = step(r, Seen::Offline, &cfg, at(10));
        assert_eq!(r.waiting.as_deref(), Some(at(0).to_rfc3339().as_str()));
        let (r, _) = step(r, Seen::Tick, &cfg, at(29));
        assert_eq!(r.stage, Stage::Queued);
        let (r, _) = step(r, Seen::Tick, &cfg, at(30));
        assert_eq!(parked(&r), (ParkKind::Offline, Stage::Queued));
        assert_eq!(r.parked.unwrap().reason, "hp is offline");
    }

    #[test]
    fn a_stage_that_runs_too_long_parks() {
        let mut cfg = cfg();
        cfg.stage_minutes = 10;
        let (r, _) = step(record(Stage::Implement), Seen::Tick, &cfg, at(10));
        assert_eq!(r.stage, Stage::Implement);
        let (r, _) = step(r, Seen::Tick, &cfg, at(11));
        assert_eq!(parked(&r), (ParkKind::TooLong, Stage::Implement));
        assert_eq!(r.parked.unwrap().reason, "Implement has run for 11 min");
        cfg.stage_minutes = 120;
        let (r, _) = step(
            record(Stage::Qa),
            Seen::Tick,
            &cfg,
            at(0) + chrono::Duration::minutes(125),
        );
        assert_eq!(r.parked.unwrap().reason, "QA has run for 2 h");
    }

    #[test]
    fn a_ticket_closed_in_linear_parks() {
        let (r, did) = step(
            record(Stage::Review),
            Seen::Closed("completed".into()),
            &cfg(),
            at(5),
        );
        assert_eq!(parked(&r), (ParkKind::Closed, Stage::Review));
        assert_eq!(r.parked.unwrap().reason, "COM-1 was closed in Linear");
        assert!(notified(&did));
    }

    fn park(kind: ParkKind, from: Stage) -> Record {
        let mut r = record(Stage::Parked);
        r.parked = Some(Parked {
            kind,
            reason: "x".into(),
            from,
            screen: String::new(),
        });
        r
    }

    #[test]
    fn answers_go_where_the_ticket_stopped() {
        let cfg = cfg();
        let mut q = park(ParkKind::Questions, Stage::Triage);
        q.questions = vec![Question {
            asked: "Which page?".into(),
            ..Question::default()
        }];
        let (r, did) = step(q, Seen::Answer("The account page".into()), &cfg, at(5));
        assert_eq!((r.stage, did), (Stage::Triage, vec![Effect::Triage]));
        assert_eq!(r.questions[0].answer, "The account page");
        assert!(r.parked.is_none());

        let (r, did) = step(
            park(ParkKind::Asked, Stage::Qa),
            Seen::Answer("Yes".into()),
            &cfg,
            at(5),
        );
        assert_eq!(
            (r.stage, did),
            (Stage::Qa, vec![Effect::Answer("Yes".into())])
        );

        let mut f = park(ParkKind::Findings, Stage::Review);
        f.findings = vec!["a.rs:1 Still wrong.".into()];
        let (r, did) = step(f, Seen::Answer("Ignore the naming one".into()), &cfg, at(5));
        assert_eq!((r.stage, r.fix_for), (Stage::Fix, Some(Stage::Review)));
        assert!(
            matches!(&did[..], [Effect::Send(t)] if t.contains("Ignore the naming one") && t.contains("Still wrong."))
        );

        let mut qa = park(ParkKind::QaFailed, Stage::Qa);
        qa.qa_report = "spec fails".into();
        let (r, did) = step(
            qa,
            Seen::Answer("The spec is outdated, update it".into()),
            &cfg,
            at(5),
        );
        assert_eq!((r.stage, r.fix_for), (Stage::Fix, Some(Stage::Qa)));
        assert!(matches!(&did[..], [Effect::Send(t)] if t.contains("spec fails")));
    }

    #[test]
    fn an_answer_to_a_push_park_is_ignored() {
        let before = park(ParkKind::Push, Stage::Finish);
        let (r, did) = step(before.clone(), Seen::Answer("hi".into()), &cfg(), at(5));
        assert_eq!(r, before);
        assert!(did.is_empty());
    }

    #[test]
    fn retry_goes_back_and_offline_retry_triages_again() {
        let cfg = cfg();
        let (r, did) = step(
            park(ParkKind::Push, Stage::Finish),
            Seen::Retry,
            &cfg,
            at(5),
        );
        assert_eq!((r.stage, did), (Stage::Finish, vec![Effect::Push]));
        let mut half = park(ParkKind::TooLong, Stage::Finish);
        half.finished = vec!["push".into(), "pull".into()];
        let (_, did) = step(half, Seen::Retry, &cfg, at(5));
        assert_eq!(did, vec![Effect::MoveLinear]);
        let mut off = park(ParkKind::Offline, Stage::Queued);
        off.machine = "hp".into();
        let (r, did) = step(off, Seen::Retry, &cfg, at(5));
        assert_eq!(r.stage, Stage::Queued);
        assert!(r.machine.is_empty() && did.is_empty());
        let mut failed = record(Stage::Failed);
        failed.failed_at = Some(Stage::Review);
        let (r, did) = step(failed, Seen::Retry, &cfg, at(5));
        assert_eq!((r.stage, did), (Stage::Review, vec![Effect::Review]));
    }

    #[test]
    fn drop_stops_the_sessions() {
        for stage in [
            Stage::Queued,
            Stage::Implement,
            Stage::Parked,
            Stage::Failed,
        ] {
            let (r, did) = step(record(stage), Seen::Drop, &cfg(), at(5));
            assert_eq!((r.stage, did), (Stage::Dropped, vec![Effect::StopSessions]));
        }
        let (r, did) = step(record(Stage::Done), Seen::Drop, &cfg(), at(5));
        assert_eq!((r.stage, did), (Stage::Done, vec![]));
    }

    #[test]
    fn a_failed_send_runs_the_fix_again_once() {
        let mut fix = record(Stage::Fix);
        fix.sent = "Fix these".into();
        let (r, did) = step(
            fix,
            Seen::Sent(Err("no such session".into())),
            &cfg(),
            at(5),
        );
        assert_eq!(
            (r.stage, did),
            (Stage::Fix, vec![Effect::Send("Fix these".into())])
        );
        let (r, _) = step(r, Seen::Sent(Err("no such session".into())), &cfg(), at(6));
        assert_eq!(r.stage, Stage::Failed);
        let (r, did) = step(record(Stage::Fix), Seen::Sent(Ok(())), &cfg(), at(5));
        assert_eq!((r.stage, did), (Stage::Fix, vec![]));
    }
}
