use super::prompts;
use super::record::{Effect, Entry, Finding, PullRef, Record, Seen, Stage, Triage};
use crate::config::Pipeline as Cfg;
use chrono::{DateTime, Local};
use std::collections::HashMap;

pub const TRIAGE_AT_ONCE: usize = 2;

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

fn report(outcome: &crate::dispatch::GroupOutcome) -> String {
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

pub fn step(mut r: Record, seen: Seen, cfg: &Cfg, now: DateTime<Local>) -> (Record, Vec<Effect>) {
    let now = &now;
    match (r.stage, seen) {
        (Stage::Queued, Seen::Admitted) if r.machine.is_empty() => {
            (to(r, Stage::Triage, "", now), vec![Effect::Triage])
        }
        (Stage::Queued, Seen::Admitted) => {
            let note = format!("on {}", r.machine);
            (to(r, Stage::Implement, &note, now), vec![Effect::Implement])
        }
        (Stage::Triage, Seen::Triaged(Ok(t))) if t.questions.is_empty() => {
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
            (to(r, Stage::Queued, &reason, now), vec![])
        }
        (stage, Seen::Started(Ok(name))) => {
            match stage {
                Stage::Implement => r.sessions.implement = name,
                Stage::Review => r.sessions.review = name,
                Stage::Qa => r.sessions.qa = name,
                _ => {}
            }
            (r, vec![])
        }
        (Stage::Implement, Seen::Idle { outcome, .. }) if outcome.status != "failed" => {
            r.outcome = outcome.summary.clone();
            (to(r, Stage::Review, "", now), vec![Effect::Review])
        }
        (Stage::Fix, Seen::Idle { outcome, .. }) if outcome.status != "failed" => {
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
            r.round += 1;
            r.fix_for = Some(Stage::Review);
            let note = format!("round {}", r.round);
            let text = prompts::fix_findings(&open);
            (to(r, Stage::Fix, &note, now), vec![Effect::Send(text)])
        }
        (Stage::Qa, Seen::Idle { outcome, verdict })
            if outcome.status != "failed" || verdict.is_some() =>
        {
            if verdict == Some(true) {
                return (to(r, Stage::Finish, "", now), vec![Effect::Push]);
            }
            r.qa_report = report(&outcome);
            r.qa_tries += 1;
            r.fix_for = Some(Stage::Qa);
            let text = prompts::fix_qa(&r.qa_report);
            (to(r, Stage::Fix, "after QA", now), vec![Effect::Send(text)])
        }
        (Stage::Finish, Seen::Pushed(Ok(()))) => {
            r.finished.push("push".into());
            (r, vec![Effect::OpenPull])
        }
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
}
