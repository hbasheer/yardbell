use chrono::{DateTime, FixedOffset};
use serde::Serialize;
use serde_json::Value;

// The newest review of a branch in a folder, as a session shows it beside its pull request badge.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Mark {
    #[serde(skip)]
    pub machine: String,
    #[serde(skip)]
    pub path: String,
    #[serde(skip)]
    pub branch: String,
    pub state: &'static str,
    pub findings: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub top: String,
    // What the review was about: the pull request's head when it was asked for, or else the
    // commit it read. A pull request whose head is something else has moved on since.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub commit: String,
    pub conversation: String,
    pub at: String,
}

impl Mark {
    pub fn covers(&self, machine: &str, path: &str, branch: &str) -> bool {
        self.machine == machine
            && self.branch == branch
            && !path.is_empty()
            && (self.path == path
                || self
                    .path
                    .strip_prefix(path)
                    .is_some_and(|rest| rest.starts_with('/')))
    }
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

fn when(at: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(at).ok()
}

fn commit_of(of: &Value) -> String {
    match text(&of["pull"], "head") {
        "" => text(&of["pin"], "head").to_string(),
        head => head.to_string(),
    }
}

fn top_severity(findings: &[Value]) -> String {
    ["high", "medium", "low"]
        .into_iter()
        .find(|level| findings.iter().any(|f| f["severity"] == *level))
        .unwrap_or_default()
        .to_string()
}

fn mark(of: &Value, state: &'static str, conversation: &str, at: &str) -> Option<Mark> {
    if of["scan"].is_string() || text(of, "branch").is_empty() {
        return None;
    }
    Some(Mark {
        machine: text(of, "machine").to_string(),
        path: text(of, "path").to_string(),
        branch: text(of, "branch").to_string(),
        state,
        findings: 0,
        top: String::new(),
        commit: commit_of(of),
        conversation: conversation.to_string(),
        at: at.to_string(),
    })
}

// A step that starts a reviewer waits for the person, or has started one that is still there. A
// reviewer that went away without a report says nothing, so the review before it still shows.
fn from_step(e: &Value, conversation: &str, alive: &dyn Fn(&str, &str) -> bool) -> Option<Mark> {
    let of = &e["review"];
    if e["role"] != "action" || !of.is_object() {
        return None;
    }
    match text(e, "status") {
        "pending" => mark(of, "asking", conversation, text(e, "at")),
        "approved" | "edited" => {
            let result = &e["result"];
            let reviewer = &result["session"];
            if result["ok"] != true || !alive(text(reviewer, "machine"), text(reviewer, "name")) {
                return None;
            }
            mark(of, "reviewing", conversation, text(result, "at"))
        }
        _ => None,
    }
}

fn from_card(e: &Value, conversation: &str) -> Option<Mark> {
    if e["role"] != "review" {
        return None;
    }
    let ready = e["verdict"] == "ready";
    let findings = e["findings"].as_array().cloned().unwrap_or_default();
    let mut m = mark(
        &e["of"],
        if ready { "ready" } else { "changes" },
        conversation,
        text(e, "at"),
    )?;
    m.findings = findings.len();
    m.top = top_severity(&findings);
    Some(m)
}

pub fn marks<'a>(
    conversations: impl Iterator<Item = (&'a str, &'a [Value])>,
    alive: &dyn Fn(&str, &str) -> bool,
) -> Vec<Mark> {
    let mut newest: Vec<Mark> = Vec::new();
    for (id, events) in conversations {
        for e in events {
            let Some(m) = from_card(e, id).or_else(|| from_step(e, id, alive)) else {
                continue;
            };
            let same = newest
                .iter()
                .position(|n| n.machine == m.machine && n.path == m.path && n.branch == m.branch);
            match same {
                Some(i) if when(&newest[i].at) >= when(&m.at) => {}
                Some(i) => newest[i] = m,
                None => newest.push(m),
            }
        }
    }
    newest
}

pub fn mark_for<'a>(all: &'a [Mark], machine: &str, path: &str, branch: &str) -> Option<&'a Mark> {
    all.iter()
        .filter(|m| m.covers(machine, path, branch))
        .max_by_key(|m| when(&m.at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "aaaaaaaa11111111111111111111111111111111";
    const B: &str = "bbbbbbbb22222222222222222222222222222222";

    fn of(extra: Value) -> Value {
        let mut of =
            json!({ "machine": "hp", "name": "hp-app", "path": "/r/app", "branch": "eng-1" });
        for (k, v) in extra.as_object().unwrap() {
            of[k] = v.clone();
        }
        of
    }

    fn step(status: &str, at: &str, result: Value) -> Value {
        json!({ "role": "action", "tool": "start_session", "status": status, "at": at, "review": of(json!({})), "result": result })
    }

    fn started(at: &str) -> Value {
        json!({ "ok": true, "at": at, "session": { "machine": "hp", "name": "hp-app-2" } })
    }

    fn card(at: &str, verdict: &str, findings: Value, extra: Value) -> Value {
        json!({ "role": "review", "machine": "hp", "name": "hp-app-2", "of": of(extra), "verdict": verdict, "findings": findings, "at": at })
    }

    #[test]
    fn the_newest_review_of_a_branch_is_its_mark() {
        let alive = |_: &str, name: &str| name == "hp-app-2";
        let one = vec![
            card(
                "2026-11-09T10:00:00+02:00",
                "ready",
                json!([]),
                json!({ "pin": { "head": A } }),
            ),
            step(
                "approved",
                "2026-11-09T11:00:00+02:00",
                started("2026-11-09T11:00:01+02:00"),
            ),
        ];
        let all = marks([("c1", one.as_slice())].into_iter(), &alive);
        assert_eq!(all.len(), 1);
        assert_eq!(
            (all[0].state, all[0].conversation.as_str()),
            ("reviewing", "c1")
        );

        let gone = |_: &str, _: &str| false;
        let all = marks([("c1", one.as_slice())].into_iter(), &gone);
        assert_eq!(
            all[0].state, "ready",
            "a reviewer that went away leaves the review before it"
        );
        assert_eq!(all[0].commit, A);

        let two = vec![card(
            "2026-11-09T12:00:00+02:00",
            "changes",
            json!([{ "severity": "low" }, { "severity": "high" }]),
            json!({ "pin": { "head": B }, "pull": { "forge": "gitlab", "number": 7, "url": "u", "head": A } }),
        )];
        let all = marks(
            [("c1", one.as_slice()), ("c2", two.as_slice())].into_iter(),
            &alive,
        );
        let m = &all[0];
        assert_eq!(
            (
                m.state,
                m.findings,
                m.top.as_str(),
                m.commit.as_str(),
                m.conversation.as_str()
            ),
            ("changes", 2, "high", A, "c2"),
            "the pull request's head, not the commit it read"
        );
        assert_eq!(
            serde_json::to_value(m).unwrap(),
            json!({ "state": "changes", "findings": 2, "top": "high", "commit": A, "conversation": "c2", "at": "2026-11-09T12:00:00+02:00" })
        );
    }

    #[test]
    fn times_compare_across_offsets_and_scans_and_refusals_say_nothing() {
        let alive = |_: &str, _: &str| true;
        let events = vec![
            card("2026-11-09T10:30:00+01:00", "ready", json!([]), json!({})),
            step("pending", "2026-11-09T11:00:00+02:00", Value::Null),
            step("rejected", "2026-11-09T12:00:00+02:00", Value::Null),
            card(
                "2026-11-09T13:00:00+02:00",
                "clean",
                json!([]),
                json!({ "scan": "security" }),
            ),
        ];
        let all = marks([("c", events.as_slice())].into_iter(), &alive);
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0].state, "ready",
            "10:30 at +01:00 is after 11:00 at +02:00"
        );
    }

    #[test]
    fn a_mark_covers_its_folder_and_the_folders_inside_it() {
        let alive = |_: &str, _: &str| true;
        let events = vec![card(
            "2026-11-09T10:00:00+02:00",
            "ready",
            json!([]),
            json!({ "path": "/r/app/web" }),
        )];
        let all = marks([("c", events.as_slice())].into_iter(), &alive);
        assert!(mark_for(&all, "hp", "/r/app", "eng-1").is_some());
        assert!(mark_for(&all, "hp", "/r/app/web", "eng-1").is_some());
        assert!(mark_for(&all, "hp", "/r/ap", "eng-1").is_none());
        assert!(mark_for(&all, "hp", "/r/app", "eng-2").is_none());
        assert!(mark_for(&all, "mini", "/r/app", "eng-1").is_none());
        assert!(mark_for(&all, "hp", "", "eng-1").is_none());
    }
}
