use crate::pulls::{
    both, clip, noun, said_by, says_what_broke, what_failed, Check, Ci, Note, Pull, Unsettled,
};
use chrono::{DateTime, Local};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const FAILING_COMMITS: usize = 4;
// A push can be read before its CI has said anything, so no checks at first means nothing yet.
const NO_CHECKS_MINUTES: i64 = 10;
const COMMENTS: usize = 12;
const COMMENT_CHARS: usize = 1200;
const REPORT_MAX: usize = 12_000;
const CHANGES: &str = "review:changes";
const CHECK: &str = "check:";

#[derive(Debug, Clone, PartialEq)]
pub enum Read {
    Found(Box<Pull>),
    NoPull,
    // Something a person has to put right, such as gh logged out.
    Blocked(String),
    // Something that may pass by itself, so the wait asks again until its time limit.
    Problem(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct FailedCheck {
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Round {
    pub head: String,
    pub failed: Vec<FailedCheck>,
}

// What one wait remembers across its Fix steps and across restarts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Watch {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub status: String,
    // The failing commits since CI last passed, oldest first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rounds: Vec<Round>,
    // What the fail line has already been given.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sent: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub green: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_checks: Option<(String, String)>,
}

impl Watch {
    pub fn is_empty(&self) -> bool {
        *self == Watch::default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Hold(String),
    Pass(String),
    Fail(String),
    Stop { reason: String, report: String },
    Unsettled { reason: String, report: String },
}

fn short(head: &str) -> String {
    head.chars().take(7).collect()
}

fn asks_for_changes(pull: &Pull) -> bool {
    pull.review == "changes_requested" || !pull.asking.is_empty()
}

// A repository that does not require reviews has no review decision from GitHub, so an approver
// is what says so there.
fn approved(pull: &Pull) -> bool {
    !asks_for_changes(pull)
        && (pull.review == "approved" || (pull.review.is_empty() && !pull.approvers.is_empty()))
}

fn normalised() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b[0-9a-f]{7,40}\b|\d+").expect("static regex"))
}

// The lines that say what broke, without the commit ids, times and counts that change on every
// run. Two failures with the same signature failed the same way. A log with nothing in it has no
// signature, and so never counts as a repeat.
pub fn signature(log: &str) -> Option<String> {
    let lines: Vec<&str> = log
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let telling: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| says_what_broke(l))
        .collect();
    let chosen = if telling.is_empty() {
        lines.last().map(|l| vec![*l])?
    } else {
        telling
    };
    let mut plain: Vec<String> = chosen
        .iter()
        .map(|l| normalised().replace_all(l, "#").to_string())
        .collect();
    plain.sort_unstable();
    plain.dedup();
    let digest = Sha256::digest(plain.join("\n").as_bytes());
    Some(format!("{digest:x}")[..16].to_string())
}

// Records this commit's failures, and says whether anything in them is new.
fn note_failures(watch: &mut Watch, pull: &Pull) -> bool {
    let mut new = false;
    if watch.rounds.last().is_none_or(|r| r.head != pull.head) {
        watch.rounds.push(Round {
            head: pull.head.clone(),
            failed: Vec::new(),
        });
        new = true;
    }
    let extra = watch.rounds.len().saturating_sub(FAILING_COMMITS);
    watch.rounds.drain(..extra);
    let Some(round) = watch.rounds.last_mut() else {
        return new;
    };
    for check in &pull.failed {
        let read = signature(&check.log);
        match round.failed.iter_mut().find(|f| f.name == check.name) {
            Some(known) => {
                new |= known.url != check.url;
                known.url.clone_from(&check.url);
                let unread = format!("{CHECK}{}:{}", check.name, pull.head);
                if let Some(sign) = read.filter(|s| known.signature.as_ref() != Some(s)) {
                    // A log read late says how a failure already sent failed, which is no news.
                    if known.signature.is_none() && watch.sent.contains(&unread) {
                        watch.sent.push(format!("{CHECK}{}:{sign}", check.name));
                    }
                    known.signature = Some(sign);
                    new = true;
                }
            }
            None => {
                round.failed.push(FailedCheck {
                    name: check.name.clone(),
                    url: check.url.clone(),
                    signature: read,
                });
                new = true;
            }
        }
    }
    new
}

fn same_way(watch: &Watch) -> Option<String> {
    let (now, earlier) = watch.rounds.split_last()?;
    for check in &now.failed {
        let Some(sign) = &check.signature else {
            continue;
        };
        let before = earlier
            .iter()
            .find(|r| {
                r.failed
                    .iter()
                    .any(|f| f.name == check.name && f.signature.as_ref() == Some(sign))
            })
            .map(|r| short(&r.head));
        if let Some(before) = before {
            return Some(format!(
                "{} failed the same way on {before} and {}",
                check.name,
                short(&now.head)
            ));
        }
    }
    None
}

fn unresolved(pull: &Pull) -> Vec<&Note> {
    pull.notes
        .iter()
        .filter(|n| !pull.resolved.contains(&n.id))
        .filter(|n| n.kind != "changes_requested" || pull.asking.contains(&n.id))
        .filter(|n| !n.body.trim().is_empty() || n.kind == "changes_requested")
        .collect()
}

// The failures as a set: each check with how it failed, and what reviewers ask for. A check whose
// log could not be read is told apart by its commit, so a new commit is news.
fn failures(watch: &Watch, pull: &Pull) -> Vec<String> {
    let mut set = Vec::new();
    if pull.ci == Ci::Failing {
        let round = watch.rounds.last();
        if pull.failed.is_empty() {
            set.push(format!("{CHECK}:{}", pull.head));
        }
        for check in &pull.failed {
            let sign = round
                .and_then(|r| r.failed.iter().find(|f| f.name == check.name))
                .and_then(|f| f.signature.clone());
            let how = sign.unwrap_or_else(|| pull.head.clone());
            set.push(format!("{CHECK}{}:{how}", check.name));
        }
    }
    if asks_for_changes(pull) {
        set.push(CHANGES.to_string());
        set.extend(pull.asking.iter().cloned());
        set.extend(unresolved(pull).iter().map(|n| n.id.clone()));
    }
    set
}

fn report(pull: &Pull, headline: String) -> String {
    let mut out = vec![headline];
    let comments = unresolved(pull);
    if !comments.is_empty() {
        out.push(String::new());
        out.push("Unresolved comments:".into());
        for n in comments.iter().take(COMMENTS) {
            let body = clip(n.body.trim(), COMMENT_CHARS);
            out.push(format!("- {}: {body}", said_by(n)));
            if !n.url.is_empty() {
                out.push(format!("  {}", n.url));
            }
        }
        if comments.len() > COMMENTS {
            out.push(format!("And {} more.", comments.len() - COMMENTS));
        }
    }
    if pull.ci == Ci::Failing {
        for check in &pull.failed {
            out.push(String::new());
            out.push(format!("Failed check: {}", check.name));
            if !check.url.is_empty() {
                out.push(check.url.clone());
            }
            if check.log.trim().is_empty() {
                out.push("Its log could not be read here. Open the link for it.".into());
            } else {
                out.push(check.log.trim_end().to_string());
            }
        }
    }
    for u in &pull.unsettled {
        out.push(String::new());
        let label = match u.how {
            Unsettled::Cancelled => "Cancelled check",
            Unsettled::Stale => "Stale check",
            Unsettled::ActionRequired => "Check needing action",
        };
        out.push(format!("{label}: {}", u.check.name));
        if !u.check.url.is_empty() {
            out.push(u.check.url.clone());
        }
    }
    out.join("\n").chars().take(REPORT_MAX).collect()
}

fn what_happened(pull: &Pull, at: &str) -> String {
    let mut parts = Vec::new();
    for how in [
        Unsettled::Cancelled,
        Unsettled::Stale,
        Unsettled::ActionRequired,
    ] {
        let checks: Vec<Check> = pull
            .unsettled
            .iter()
            .filter(|u| u.how == how)
            .map(|u| u.check.clone())
            .collect();
        if checks.is_empty() {
            continue;
        }
        let one = checks.len() == 1;
        let did = match how {
            Unsettled::Cancelled if one => "was cancelled",
            Unsettled::Cancelled => "were cancelled",
            Unsettled::Stale => "went stale",
            Unsettled::ActionRequired if one => "is waiting for someone to act on it",
            Unsettled::ActionRequired => "are waiting for someone to act on them",
        };
        parts.push(format!("{} {did}", what_failed(&checks)));
    }
    let needs_a_person = pull
        .unsettled
        .iter()
        .any(|u| u.how == Unsettled::ActionRequired);
    let then = match (needs_a_person, pull.unsettled.len()) {
        (true, _) => "This carries on by itself once that is dealt with",
        (false, 1) => "Run it again and this carries on by itself",
        (false, _) => "Run them again and this carries on by itself",
    };
    format!(
        "{} at {at}, so an agent has nothing to fix. {then}",
        both(&parts)
    )
}

fn failure_headline(pull: &Pull) -> String {
    let at = format!("{} at {}", noun(pull), short(&pull.head));
    match (pull.ci == Ci::Failing, asks_for_changes(pull)) {
        (true, true) => format!(
            "CI failed on {} and changes are requested on {at}.",
            what_failed(&pull.failed)
        ),
        (true, false) => format!("CI failed on {} for {at}.", what_failed(&pull.failed)),
        _ => format!("Changes are requested on {at}."),
    }
}

// Reads what one look at the pull or merge request means for the wait.
pub fn judge(
    watch: &mut Watch,
    pull: &Pull,
    require_approval: bool,
    now: &DateTime<Local>,
) -> Verdict {
    let named = noun(pull);
    match pull.state.as_str() {
        "merged" => return Verdict::Pass(format!("{named} was merged.")),
        "closed" => {
            return Verdict::Stop {
                reason: format!("{named} was closed"),
                report: String::new(),
            }
        }
        _ => {}
    }
    if !pull.unsettled.is_empty() {
        watch.green.clear();
    } else if pull.ci == Ci::Passing {
        watch.rounds.clear();
        watch.sent.retain(|e| !e.starts_with(CHECK));
    }
    if !asks_for_changes(pull) {
        watch.sent.retain(|e| e != CHANGES);
    }
    if pull.ci == Ci::Failing && note_failures(watch, pull) {
        let stuck = same_way(watch).or_else(|| {
            (watch.rounds.len() >= FAILING_COMMITS)
                .then(|| format!("Checks failed on {FAILING_COMMITS} commits in a row"))
        });
        if let Some(reason) = stuck {
            return Verdict::Stop {
                report: report(pull, format!("{reason}. {}", failure_headline(pull))),
                reason,
            };
        }
    }
    let set = failures(watch, pull);
    if !set.is_empty() {
        let fresh: Vec<String> = set
            .iter()
            .filter(|e| !watch.sent.contains(e))
            .cloned()
            .collect();
        if fresh.is_empty() {
            return Verdict::Hold(format!(
                "The same failures on {named} were already sent. Waiting for a new commit or review"
            ));
        }
        watch.sent.extend(fresh);
        return Verdict::Fail(report(pull, failure_headline(pull)));
    }
    let at = short(&pull.head);
    // Checks still running could yet fail, and a failure gives an agent something to fix.
    if !pull.unsettled.is_empty() && pull.ci != Ci::Pending {
        let reason = what_happened(pull, &at);
        return Verdict::Unsettled {
            report: report(pull, format!("{reason}.")),
            reason,
        };
    }
    match pull.ci {
        Ci::Failing | Ci::Pending => Verdict::Hold(format!("CI is running on {named} at {at}")),
        Ci::None => no_checks(watch, pull, now),
        Ci::Passing => {
            if require_approval && !approved(pull) {
                return Verdict::Hold(format!("CI passed on {at}. Waiting for an approval"));
            }
            // A check that registers late could turn this green too soon, so green must hold for
            // a second look at the same commit.
            if watch.green != pull.head {
                watch.green.clone_from(&pull.head);
                return Verdict::Hold(format!("CI passed on {at}. Looking once more"));
            }
            let by = if pull.approvers.is_empty() {
                String::new()
            } else {
                format!(" Approved by {}.", pull.approvers.join(", "))
            };
            Verdict::Pass(report(pull, format!("CI passed on {named} at {at}.{by}")))
        }
    }
}

fn no_checks(watch: &mut Watch, pull: &Pull, now: &DateTime<Local>) -> Verdict {
    let at = short(&pull.head);
    let since = match &watch.no_checks {
        Some((head, since)) if *head == pull.head => since.clone(),
        _ => {
            let since = now.to_rfc3339();
            watch.no_checks = Some((pull.head.clone(), since.clone()));
            since
        }
    };
    let waited = DateTime::parse_from_rfc3339(&since)
        .map(|s| (*now - s.with_timezone(&Local)).num_minutes())
        .unwrap_or_default();
    if waited < NO_CHECKS_MINUTES {
        return Verdict::Hold(format!("No checks have started on {at} yet"));
    }
    let reason = format!("No checks ran on {at} in {waited} minutes, so nothing says it passed");
    Verdict::Stop {
        report: format!("{reason}."),
        reason,
    }
}

// Whether this look needs the logs and comments: a verdict other than Hold will quote them, and a
// check not seen before needs its log for its signature.
pub fn wants_detail(watch: &Watch, pull: &Pull, require_approval: bool) -> bool {
    let unseen = pull.ci == Ci::Failing
        && pull.failed.iter().any(|c| {
            !watch.rounds.last().is_some_and(|r| {
                r.head == pull.head
                    && r.failed
                        .iter()
                        .any(|f| f.name == c.name && f.url == c.url && f.signature.is_some())
            })
        });
    let mut probe = watch.clone();
    unseen
        || !matches!(
            judge(&mut probe, pull, require_approval, &Local::now()),
            Verdict::Hold(_) | Verdict::Unsettled { .. }
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pulls::UnsettledCheck;

    fn now() -> DateTime<Local> {
        Local::now()
    }

    fn pull(head: &str, ci: Ci) -> Pull {
        Pull {
            forge: "github".into(),
            number: 12,
            url: "https://github.com/acme/app/pull/12".into(),
            title: "Fix".into(),
            state: "open".into(),
            draft: true,
            review: String::new(),
            ci,
            failed: vec![],
            head: head.into(),
            author: "me".into(),
            notes: vec![],
            created: String::new(),
            approvers: vec![],
            asking: vec![],
            resolved: vec![],
            unsettled: vec![],
        }
    }

    fn check(name: &str, log: &str) -> Check {
        Check {
            name: name.into(),
            url: format!("https://ci/{name}"),
            log: log.into(),
        }
    }

    fn failing(head: &str, checks: Vec<Check>) -> Pull {
        Pull {
            failed: checks,
            ..pull(head, Ci::Failing)
        }
    }

    fn note(id: &str, kind: &str, body: &str) -> Note {
        Note {
            id: id.into(),
            kind: kind.into(),
            author: "alice".into(),
            body: body.into(),
            url: format!("https://x/{id}"),
            place: String::new(),
        }
    }

    fn see(watch: &mut Watch, p: &Pull) -> Verdict {
        judge(watch, p, false, &now())
    }

    fn is_fail(v: &Verdict) -> bool {
        matches!(v, Verdict::Fail(_))
    }

    #[test]
    fn green_passes_on_a_second_look_at_the_same_commit() {
        let mut w = Watch::default();
        let p = pull("aaaaaaaa", Ci::Passing);
        assert!(matches!(see(&mut w, &p), Verdict::Hold(_)));
        match see(&mut w, &p) {
            Verdict::Pass(r) => assert!(r.contains("CI passed on pull request #12 at aaaaaaa")),
            other => panic!("{other:?}"),
        }
        let moved = pull("bbbbbbbb", Ci::Passing);
        assert!(
            matches!(see(&mut w, &moved), Verdict::Hold(_)),
            "a new commit looks twice as well"
        );
    }

    #[test]
    fn pending_and_early_no_checks_hold() {
        let mut w = Watch::default();
        assert!(matches!(
            see(&mut w, &pull("a", Ci::Pending)),
            Verdict::Hold(_)
        ));
        assert!(matches!(
            see(&mut w, &pull("a", Ci::None)),
            Verdict::Hold(_)
        ));
    }

    #[test]
    fn no_checks_at_all_goes_to_the_person_after_a_while() {
        let mut w = Watch::default();
        let p = pull("aaaaaaaa", Ci::None);
        let first = now();
        assert!(matches!(judge(&mut w, &p, false, &first), Verdict::Hold(_)));
        let later = first + chrono::Duration::minutes(NO_CHECKS_MINUTES);
        match judge(&mut w, &p, false, &later) {
            Verdict::Stop { reason, .. } => assert!(reason.contains("No checks ran"), "{reason}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn approval_is_asked_for_only_when_the_step_says_so() {
        let mut w = Watch::default();
        let p = pull("aaaaaaaa", Ci::Passing);
        match judge(&mut w, &p, true, &now()) {
            Verdict::Hold(s) => assert!(s.contains("Waiting for an approval"), "{s}"),
            other => panic!("{other:?}"),
        }
        let approved = Pull {
            review: "approved".into(),
            approvers: vec!["alice".into()],
            ..p.clone()
        };
        judge(&mut w, &approved, true, &now());
        match judge(&mut w, &approved, true, &now()) {
            Verdict::Pass(r) => assert!(r.contains("Approved by alice"), "{r}"),
            other => panic!("{other:?}"),
        }
        let no_rule = Pull {
            approvers: vec!["alice".into()],
            ..p.clone()
        };
        assert!(super::approved(&no_rule), "no required reviews on GitHub");
        let dismissed = Pull {
            review: "review_required".into(),
            approvers: vec!["alice".into()],
            ..p
        };
        assert!(!super::approved(&dismissed), "a stale approval");
    }

    #[test]
    fn a_failure_is_sent_once_while_the_set_stays_the_same() {
        let mut w = Watch::default();
        let p = failing("aaaaaaaa", vec![check("test", "error: boom")]);
        let first = see(&mut w, &p);
        assert!(is_fail(&first), "{first:?}");
        let Verdict::Fail(r) = first else { panic!() };
        assert!(
            r.starts_with("CI failed on test for pull request #12 at aaaaaaa."),
            "{r}"
        );
        assert!(
            r.contains("Failed check: test\nhttps://ci/test\nerror: boom"),
            "{r}"
        );
        let mut no_log = p.clone();
        no_log.failed[0].log = String::new();
        assert!(
            matches!(see(&mut w, &no_log), Verdict::Hold(s) if s.contains("already sent")),
            "a Fix that pushed nothing leaves the same set"
        );
    }

    #[test]
    fn a_new_failure_on_the_same_commit_is_sent() {
        let mut w = Watch::default();
        see(&mut w, &failing("a", vec![check("test", "error: boom")]));
        let more = failing(
            "a",
            vec![check("test", "error: boom"), check("lint", "error: style")],
        );
        assert!(is_fail(&see(&mut w, &more)));
        assert_eq!(w.rounds.len(), 1, "one commit is one round");
    }

    #[test]
    fn the_same_check_failing_the_same_way_on_two_commits_stops() {
        let mut w = Watch::default();
        see(
            &mut w,
            &failing("aaaaaaaa", vec![check("test", "error at 12:01 in abcdef1")]),
        );
        let again = failing("bbbbbbbb", vec![check("test", "error at 12:44 in 1234abc")]);
        match see(&mut w, &again) {
            Verdict::Stop { reason, report } => {
                assert_eq!(reason, "test failed the same way on aaaaaaa and bbbbbbb");
                assert!(report.contains("Failed check: test"), "{report}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_same_check_failing_another_way_is_sent_again() {
        let mut w = Watch::default();
        see(&mut w, &failing("a", vec![check("test", "error: first")]));
        assert!(is_fail(&see(
            &mut w,
            &failing("b", vec![check("test", "error: second")])
        )));
    }

    #[test]
    fn four_failing_commits_in_a_row_stop_and_a_pass_starts_the_count_again() {
        let mut w = Watch::default();
        for (i, head) in ["a", "b", "c"].iter().enumerate() {
            let log = format!("error: way {}", ["one", "two", "three"][i]);
            assert!(is_fail(&see(
                &mut w,
                &failing(head, vec![check("test", &log)])
            )));
        }
        see(&mut w, &pull("c", Ci::Passing));
        assert!(w.rounds.is_empty());
        for (i, head) in ["d", "e", "f"].iter().enumerate() {
            let log = format!("error: new {}", ["one", "two", "three"][i]);
            assert!(is_fail(&see(
                &mut w,
                &failing(head, vec![check("test", &log)])
            )));
        }
        match see(&mut w, &failing("g", vec![check("lint", "error: other")])) {
            Verdict::Stop { reason, .. } => {
                assert_eq!(reason, "Checks failed on 4 commits in a row")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_unread_log_never_counts_as_a_repeat_but_a_new_commit_is_sent() {
        let mut w = Watch::default();
        assert!(is_fail(&see(
            &mut w,
            &failing("a", vec![check("test", "")])
        )));
        assert!(is_fail(&see(
            &mut w,
            &failing("b", vec![check("test", "")])
        )));
    }

    #[test]
    fn changes_requested_fails_and_stays_quiet_until_something_new() {
        let mut w = Watch::default();
        let mut p = pull("aaaaaaaa", Ci::Passing);
        p.review = "changes_requested".into();
        p.notes = vec![note("r1", "changes_requested", "Rename this")];
        p.asking = vec!["r1".into()];
        let first = see(&mut w, &p);
        let Verdict::Fail(r) = first else {
            panic!("{first:?}")
        };
        assert!(
            r.starts_with("Changes are requested on pull request #12"),
            "{r}"
        );
        assert!(r.contains("alice requested changes: Rename this"), "{r}");
        p.head = "bbbbbbbb".into();
        assert!(
            matches!(see(&mut w, &p), Verdict::Hold(_)),
            "the same request after a new commit waits for the reviewer"
        );
        p.notes.push(note("c2", "comment", "And this"));
        assert!(is_fail(&see(&mut w, &p)));
    }

    #[test]
    fn a_review_with_no_decision_from_github_still_asks_for_changes() {
        let mut w = Watch::default();
        let mut p = pull("a", Ci::Passing);
        p.notes = vec![note("r1", "changes_requested", "No")];
        p.asking = vec!["r1".into()];
        assert!(is_fail(&see(&mut w, &p)));
    }

    #[test]
    fn plain_comments_do_not_fail_and_come_along_on_a_pass() {
        let mut w = Watch::default();
        let mut p = pull("a", Ci::Passing);
        p.notes = vec![
            note("c1", "comment", "Nice"),
            note("c2", "inline", "Done already"),
            note("r0", "changes_requested", "Old, since approved"),
        ];
        p.resolved = vec!["c2".into()];
        see(&mut w, &p);
        let Verdict::Pass(r) = see(&mut w, &p) else {
            panic!()
        };
        assert!(r.contains("Unresolved comments:\n- alice: Nice"), "{r}");
        assert!(!r.contains("Done already"), "{r}");
        assert!(!r.contains("Old, since approved"), "{r}");
    }

    #[test]
    fn a_merged_pull_passes_and_a_closed_one_stops() {
        let mut w = Watch::default();
        let mut p = pull("a", Ci::Failing);
        p.state = "merged".into();
        assert!(matches!(see(&mut w, &p), Verdict::Pass(_)));
        p.state = "closed".into();
        assert!(matches!(see(&mut w, &p), Verdict::Stop { .. }));
    }

    #[test]
    fn a_failure_back_after_a_pass_is_news_again() {
        let mut w = Watch::default();
        let p = failing("a", vec![check("test", "error: boom")]);
        assert!(is_fail(&see(&mut w, &p)));
        see(&mut w, &pull("a", Ci::Passing));
        assert!(is_fail(&see(&mut w, &failing("b", p.failed.clone()))));
    }

    #[test]
    fn signatures_ignore_ids_times_and_counts() {
        assert_eq!(
            signature("ok line\ntest a FAILED in 12ms at 1a2b3c4d"),
            signature("other\ntest a FAILED in 987ms at 99aa88bb")
        );
        assert_ne!(signature("test a FAILED"), signature("test b FAILED"));
        assert_eq!(signature(" \n"), None);
        assert!(signature("just a line").is_some());
        assert_eq!(
            signature("error: x\nProcess completed with exit code 1"),
            signature("error: x\nProcess completed with exit code 2")
        );
    }

    #[test]
    fn only_a_look_that_says_something_asks_for_the_detail() {
        let mut w = Watch::default();
        let p = failing("a", vec![check("test", "")]);
        assert!(wants_detail(&w, &p, false), "a new failure");
        let read = failing("a", vec![check("test", "error: boom")]);
        see(&mut w, &read);
        assert!(
            !wants_detail(&w, &p, false),
            "the same failure, already read"
        );
        assert!(!wants_detail(&w, &pull("a", Ci::Pending), false));
        let mut green = Watch::default();
        assert!(!wants_detail(&green, &pull("a", Ci::Passing), false));
        see(&mut green, &pull("a", Ci::Passing));
        assert!(wants_detail(&green, &pull("a", Ci::Passing), false));
        assert!(!wants_detail(&green, &pull("a", Ci::Passing), true));
    }

    fn cancelled(head: &str, ci: Ci, names: &[&str]) -> Pull {
        Pull {
            unsettled: names
                .iter()
                .map(|n| UnsettledCheck {
                    check: check(n, ""),
                    how: Unsettled::Cancelled,
                })
                .collect(),
            ..pull(head, ci)
        }
    }

    #[test]
    fn a_cancelled_check_is_not_green_at_any_read_and_names_itself() {
        let mut w = Watch::default();
        let p = cancelled("aaaaaaaa", Ci::Passing, &["build", "lint"]);
        for _ in 0..3 {
            match see(&mut w, &p) {
                Verdict::Unsettled { reason, report } => {
                    assert!(reason.contains("build and lint were cancelled"), "{reason}");
                    assert!(reason.contains("aaaaaaa"), "{reason}");
                    assert!(report.contains("Cancelled check: build"), "{report}");
                }
                other => panic!("{other:?}"),
            }
        }
    }

    fn ended(ci: Ci, checks: &[(&str, Unsettled)]) -> Pull {
        Pull {
            unsettled: checks
                .iter()
                .map(|(n, how)| UnsettledCheck {
                    check: check(n, ""),
                    how: *how,
                })
                .collect(),
            ..pull("aaaaaaaa", ci)
        }
    }

    fn said(checks: &[(&str, Unsettled)]) -> (String, String) {
        match see(&mut Watch::default(), &ended(Ci::Passing, checks)) {
            Verdict::Unsettled { reason, report } => (reason, report),
            other => panic!("{other:?}"),
        }
    }

    const NOTHING: &str = "at aaaaaaa, so an agent has nothing to fix.";
    const RUN_IT: &str = "Run it again and this carries on by itself";
    const RUN_THEM: &str = "Run them again and this carries on by itself";
    const DEALT: &str = "This carries on by itself once that is dealt with";

    #[test]
    fn a_stale_check_says_it_went_stale() {
        use Unsettled::*;
        let (reason, report) = said(&[("build", Stale)]);
        assert_eq!(reason, format!("build went stale {NOTHING} {RUN_IT}"));
        assert!(report.contains("Stale check: build"), "{report}");
        assert!(!report.contains("ancelled"), "{report}");
        let (reason, _) = said(&[("build", Stale), ("lint", Stale)]);
        assert_eq!(
            reason,
            format!("build and lint went stale {NOTHING} {RUN_THEM}")
        );
    }

    #[test]
    fn a_check_needing_action_says_someone_must_act() {
        use Unsettled::*;
        let (reason, report) = said(&[("deploy", ActionRequired)]);
        assert_eq!(
            reason,
            format!("deploy is waiting for someone to act on it {NOTHING} {DEALT}")
        );
        assert!(report.contains("Check needing action: deploy"), "{report}");
        assert!(!report.contains("ancelled"), "{report}");
        let (reason, _) = said(&[("a", ActionRequired), ("b", ActionRequired)]);
        assert_eq!(
            reason,
            format!("a and b are waiting for someone to act on them {NOTHING} {DEALT}")
        );
    }

    #[test]
    fn a_mix_of_kinds_says_what_happened_to_each() {
        use Unsettled::*;
        let (reason, _) = said(&[("lint", Stale), ("build", Cancelled)]);
        assert_eq!(
            reason,
            format!("build was cancelled and lint went stale {NOTHING} {RUN_THEM}")
        );
        let (reason, report) = said(&[
            ("c", ActionRequired),
            ("a", Cancelled),
            ("a2", Cancelled),
            ("b", Stale),
        ]);
        assert_eq!(
            reason,
            format!(
                "a and a2 were cancelled, b went stale and c is waiting for someone to act on it {NOTHING} {DEALT}"
            )
        );
        for line in [
            "Cancelled check: a",
            "Stale check: b",
            "Check needing action: c",
        ] {
            assert!(report.contains(line), "{report}");
        }
    }

    #[test]
    fn any_kind_is_not_green_and_a_failure_beside_it_still_goes_to_fix() {
        use Unsettled::*;
        for how in [Stale, ActionRequired] {
            let mut w = Watch::default();
            let p = ended(Ci::Passing, &[("x", how)]);
            for _ in 0..3 {
                assert!(
                    matches!(see(&mut w, &p), Verdict::Unsettled { .. }),
                    "{how:?}"
                );
            }
            let mut w = Watch::default();
            let running = ended(Ci::Pending, &[("x", how)]);
            assert!(matches!(see(&mut w, &running), Verdict::Hold(_)), "{how:?}");
            let mut failing = failing("a", vec![check("test", "error: boom")]);
            failing.unsettled = p.unsettled.clone();
            assert!(is_fail(&see(&mut w, &failing)), "{how:?}");
        }
    }

    #[test]
    fn one_cancelled_check_was_and_three_were() {
        let reason = |names: &[&str]| match see(
            &mut Watch::default(),
            &cancelled("aaaaaaaa", Ci::Passing, names),
        ) {
            Verdict::Unsettled { reason, .. } => reason,
            other => panic!("{other:?}"),
        };
        assert!(reason(&["build"]).starts_with("build was cancelled"));
        assert!(reason(&["a", "b", "c"]).starts_with("a, b and 1 more were cancelled"));
    }

    #[test]
    fn a_cancelled_pipeline_with_no_other_checks_is_named_at_once() {
        let mut w = Watch::default();
        let p = cancelled("a", Ci::None, &["pipeline #5"]);
        assert!(matches!(see(&mut w, &p), Verdict::Unsettled { .. }));
    }

    #[test]
    fn a_re_run_that_goes_green_still_needs_two_reads() {
        let mut w = Watch::default();
        let green = pull("a", Ci::Passing);
        assert!(matches!(see(&mut w, &green), Verdict::Hold(_)));
        see(&mut w, &cancelled("a", Ci::Passing, &["build"]));
        assert!(
            matches!(see(&mut w, &green), Verdict::Hold(_)),
            "the green read before the cancel does not count"
        );
        assert!(matches!(see(&mut w, &green), Verdict::Pass(_)));
    }

    #[test]
    fn a_failure_beside_a_cancelled_check_takes_the_fix_path() {
        let mut w = Watch::default();
        let mut p = failing("a", vec![check("test", "error: boom")]);
        p.unsettled = cancelled("a", Ci::Failing, &["build"]).unsettled;
        let Verdict::Fail(r) = see(&mut w, &p) else {
            panic!("the failure goes to Fix")
        };
        assert!(r.contains("Failed check: test"), "{r}");
        assert!(r.contains("Cancelled check: build"), "{r}");
    }

    #[test]
    fn checks_still_running_beside_a_cancelled_one_are_waited_for() {
        let mut w = Watch::default();
        let p = cancelled("a", Ci::Pending, &["build"]);
        assert!(matches!(see(&mut w, &p), Verdict::Hold(_)));
    }

    #[test]
    fn a_cancelled_check_does_not_start_the_failure_count_again() {
        let mut w = Watch::default();
        see(&mut w, &failing("a", vec![check("test", "error: one")]));
        see(&mut w, &cancelled("b", Ci::Passing, &["test"]));
        assert_eq!(w.rounds.len(), 1, "only a real pass starts it again");
        assert!(
            w.sent.iter().any(|e| e.starts_with(CHECK)),
            "what was sent is still remembered"
        );
    }

    #[test]
    fn a_cancelled_check_asks_for_no_logs_on_each_read() {
        let w = Watch::default();
        let p = cancelled("a", Ci::Passing, &["build"]);
        assert!(!wants_detail(&w, &p, false));
    }

    #[test]
    fn every_check_skipped_stays_as_it_was() {
        let mut w = Watch::default();
        let github = pull("a", Ci::Passing);
        see(&mut w, &github);
        assert!(matches!(see(&mut w, &github), Verdict::Pass(_)));
        let mut w = Watch::default();
        let first = now();
        let gitlab = pull("a", Ci::None);
        judge(&mut w, &gitlab, false, &first);
        let later = first + chrono::Duration::minutes(NO_CHECKS_MINUTES);
        assert!(matches!(
            judge(&mut w, &gitlab, false, &later),
            Verdict::Stop { .. }
        ));
    }

    #[test]
    fn a_long_report_is_cut_with_the_comments_still_in_it() {
        let mut p = failing("a", vec![check("test", &"x".repeat(20_000))]);
        p.review = "changes_requested".into();
        p.notes = vec![note("c", "comment", "Read me")];
        let mut w = Watch::default();
        let Verdict::Fail(r) = see(&mut w, &p) else {
            panic!()
        };
        assert_eq!(r.chars().count(), REPORT_MAX);
        assert!(r.contains("Read me"));
    }
}
