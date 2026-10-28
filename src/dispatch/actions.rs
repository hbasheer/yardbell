use super::review::ReviewOf;
use rand::Rng;
use serde_json::{json, Value};

const ID_LEN: usize = 8;
const CHANGING: [&str; 4] = [
    "start_session",
    "send_to_session",
    "stop_session",
    "review_session",
];

pub fn changes_something(tool: &str) -> bool {
    CHANGING.contains(&tool)
}

pub fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn new_id() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(ID_LEN)
        .map(|b| char::from(b).to_ascii_lowercase())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum By {
    Dispatch,
    You,
}

pub fn event(
    tool: &str,
    input: Value,
    by: By,
    review: Option<&ReviewOf>,
    status: &str,
    at: &str,
) -> Value {
    let mut event = json!({
        "role": "action",
        "id": new_id(),
        "tool": tool,
        "input": input,
        "by": if by == By::You { "you" } else { "dispatch" },
        "status": status,
        "at": at,
    });
    if let Some(review) = review {
        event["review"] = json!(review);
    }
    event
}

pub fn result(outcome: &Result<Value, String>, at: &str) -> Value {
    match outcome {
        Ok(value) => {
            let mut result = json!({
                "ok": true,
                "text": serde_json::to_string_pretty(value).unwrap_or_default(),
                "at": at,
            });
            if value["name"].is_string() && value["machine"].is_string() {
                result["session"] = json!({
                    "machine": value["machine"],
                    "name": value["name"],
                    "path": value["path"],
                });
            }
            result
        }
        Err(message) => json!({ "ok": false, "text": message, "at": at }),
    }
}

pub fn find<'a>(events: &'a mut [Value], id: &str) -> Option<&'a mut Value> {
    events
        .iter_mut()
        .find(|e| e["role"] == "action" && e["id"] == id)
}

pub fn pending(events: &[Value]) -> impl Iterator<Item = &Value> {
    events
        .iter()
        .filter(|e| e["role"] == "action" && e["status"] == "pending")
}

// Like an AI agent's pending reply in Commslayer, an undecided step goes stale once the person
// writes again, so it is withdrawn and Dispatch decides afresh with the new message.
pub fn withdraw(events: &mut [Value], at: &str) {
    for e in events
        .iter_mut()
        .filter(|e| e["role"] == "action" && e["status"] == "pending")
    {
        e["status"] = json!("withdrawn");
        e["decided"] = json!(at);
    }
}

// Interrupted by a restart between the decision and the result, the step cannot be told apart
// from one that never ran.
pub fn interrupted(events: &mut [Value]) {
    for e in events.iter_mut().filter(|e| {
        e["role"] == "action"
            && (e["status"] == "approved" || e["status"] == "edited")
            && e["result"].is_null()
    }) {
        e["result"] = json!({
            "ok": false,
            "text": "Yardbell restarted before this finished. Check the session list to see whether it ran.",
            "at": e["decided"],
        });
    }
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

// The step as Dispatch proposed it, before any edit.
fn what(action: &Value) -> String {
    let input = match &action["original"] {
        original if original.is_object() => original,
        _ => &action["input"],
    };
    let machine = text(input, "machine");
    let session = text(input, "name");
    match text(action, "tool") {
        "start_session" if action["review"].is_object() => {
            format!(
                "starting a review of {} on {machine}",
                reviewed(&action["review"])
            )
        }
        "start_session" => {
            let folder = [text(input, "folder"), text(input, "path")]
                .into_iter()
                .find(|f| !f.is_empty())
                .unwrap_or("its default folder");
            let branch = text(input, "branch");
            let on = if branch.is_empty() {
                String::new()
            } else {
                format!(" on branch {branch}")
            };
            format!("starting a session on {machine} in {folder}{on}")
        }
        "send_to_session" => format!(
            "typing \"{}\" into {session} on {machine}",
            text(input, "text")
        ),
        "stop_session" => format!("stopping {session} on {machine}"),
        other => other.to_string(),
    }
}

fn blank(v: Option<&Value>) -> bool {
    v.is_none_or(|v| v.is_null() || *v == "" || *v == false)
}

fn changed(action: &Value) -> String {
    let (before, after) = (&action["original"], &action["input"]);
    if !before.is_object() {
        return String::new();
    }
    let mut fields: Vec<&str> = Vec::new();
    for (key, word) in [
        ("machine", "machine"),
        ("folder", "folder"),
        ("path", "folder"),
        ("branch", "branch"),
        ("new_branch", "branch"),
        ("base", "branch"),
        ("agent", "agent"),
        ("prompt", "task"),
        ("text", "text"),
    ] {
        let (a, b) = (before.get(key), after.get(key));
        if !(a == b || blank(a) && blank(b)) && !fields.contains(&word) {
            fields.push(word);
        }
    }
    match fields.as_slice() {
        [] => String::new(),
        [one] => format!(" after changing the {one}"),
        [rest @ .., last] => format!(" after changing the {} and {last}", rest.join(", ")),
    }
}

// How the step ended, as the end of a sentence: ", and it was sent" or ", but it failed: ...".
fn ran(action: &Value) -> Option<String> {
    let result = &action["result"];
    if result.is_null() {
        return None;
    }
    if result["ok"] != true {
        return Some(format!(", but it failed: {}", text(result, "text")));
    }
    Some(match text(action, "tool") {
        "start_session" => format!(
            ", and it started as {} on {}",
            text(&result["session"], "name"),
            text(&result["session"], "machine")
        ),
        "send_to_session" => ", and it was sent".into(),
        "stop_session" => ", and the session stopped".into(),
        _ => ", and it ran".into(),
    })
}

fn action_outcome(action: &Value) -> Option<String> {
    let mine = action["by"] == "you";
    match text(action, "status") {
        "approved" | "edited" if mine => {
            Some(format!("I asked for {}{}.", subject(action), ran(action)?))
        }
        "approved" | "edited" => Some(format!(
            "You proposed {}. I approved it{}{}.",
            what(action),
            changed(action),
            ran(action)?
        )),
        "rejected" | "withdrawn" if mine => Some(String::new()),
        "rejected" => Some(format!("You proposed {}. I rejected it.", what(action))),
        "withdrawn" => Some(format!(
            "You proposed {}, but I wrote this message before deciding, so it was withdrawn. \
Propose it again only if it still fits.",
            what(action)
        )),
        _ => None,
    }
}

fn subject(action: &Value) -> String {
    let of = &action["review"];
    if !of.is_object() {
        return what(action);
    }
    format!(
        "a review of {} on {}",
        reviewed(of),
        text(&action["input"], "machine")
    )
}

fn reviewed(of: &Value) -> String {
    match text(of, "branch") {
        "" => format!("the work of {}", text(of, "name")),
        branch => format!("branch {branch}"),
    }
}

fn review_finished(review: &Value) -> String {
    let verdict = if review["verdict"] == "ready" {
        "ready"
    } else {
        "changes needed"
    };
    let findings: Vec<String> = review["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, f)| {
            let place = match text(f, "place") {
                "" => String::new(),
                place => format!(" {place}"),
            };
            format!(
                "{}) {}{place} {}",
                i + 1,
                text(f, "severity"),
                text(f, "text")
            )
        })
        .collect();
    let listed = if findings.is_empty() {
        " No findings.".to_string()
    } else {
        format!(" Findings: {}", findings.join(" "))
    };
    format!(
        "The review of {} by {} on {} finished: {verdict}. {}{listed}",
        reviewed(&review["of"]),
        text(review, "name"),
        text(review, "machine"),
        text(review, "summary")
    )
}

fn review_decided(review: &Value) -> String {
    let outcome = &review["outcome"];
    let subject = reviewed(&review["of"]);
    match text(outcome, "decision") {
        "sent" => format!(
            "I sent {} of the findings from the review of {subject} to {} to fix.",
            outcome["findings"].as_array().map_or(0, Vec::len),
            text(outcome, "to")
        ),
        _ => format!("I dismissed the review of {subject}."),
    }
}

fn answer_outcome(card: &Value) -> Option<String> {
    let answer = &card["answer"];
    (answer.is_object() && answer["told"] != true).then(|| {
        format!(
            "I answered the question {} on {} asked with \"{}\".",
            text(card, "name"),
            text(card, "machine"),
            text(answer, "label")
        )
    })
}

// What Dispatch has not heard about yet, each item marked as told. An empty line marks an item
// that needs no mention.
pub fn untold(events: &mut [Value]) -> Vec<String> {
    let mut lines = Vec::new();
    for e in events.iter_mut() {
        match text(e, "role") {
            "action" if e["told"] != true => {
                if let Some(line) = action_outcome(e) {
                    e["told"] = json!(true);
                    lines.push(line);
                }
            }
            "review" => {
                if e["told"] != true {
                    lines.push(review_finished(e));
                    e["told"] = json!(true);
                }
                if e["outcome"].is_object() && e["outcome"]["told"] != true {
                    lines.push(review_decided(e));
                    e["outcome"]["told"] = json!(true);
                }
            }
            "pull" => lines.extend(super::pull::untold(e)),
            "session" => {
                if let Some(line) = answer_outcome(e) {
                    e["answer"]["told"] = json!(true);
                    lines.push(line);
                }
            }
            _ => {}
        }
    }
    lines.retain(|l| !l.is_empty());
    lines
}

pub fn with_news(news: &[String], text: &str) -> String {
    if news.is_empty() {
        return text.to_string();
    }
    format!(
        "What happened since your last reply:\n- {}\n\nMy message:\n{text}",
        news.join("\n- ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(by: By) -> Value {
        event(
            "start_session",
            json!({ "machine": "hp", "folder": "demo-app", "branch": "eng-1", "prompt": "fix it" }),
            by,
            None,
            "pending",
            "t0",
        )
    }

    #[test]
    fn decided_steps_are_told_once() {
        let mut approved = start(By::Dispatch);
        approved["status"] = json!("edited");
        approved["original"] = approved["input"].clone();
        approved["input"]["machine"] = json!("mini");
        approved["input"]["prompt"] = json!("fix it well");
        approved["result"] = result(
            &Ok(json!({ "machine": "mini", "name": "mini-eng-1", "path": "/r/app" })),
            "t1",
        );
        let mut rejected = event(
            "stop_session",
            json!({ "machine": "hp", "name": "hp-old" }),
            By::Dispatch,
            None,
            "rejected",
            "t0",
        );
        rejected["decided"] = json!("t1");
        let still_running = {
            let mut e = start(By::Dispatch);
            e["status"] = json!("approved");
            e
        };
        let mut events = vec![approved, rejected, still_running, start(By::Dispatch)];
        withdraw(&mut events, "t2");
        assert_eq!(events[3]["status"], "withdrawn");
        let news = untold(&mut events);
        assert_eq!(
            news,
            [
                "You proposed starting a session on hp in demo-app on branch eng-1. I approved it after changing the machine and task, and it started as mini-eng-1 on mini.",
                "You proposed stopping hp-old on hp. I rejected it.",
                "You proposed starting a session on hp in demo-app on branch eng-1, but I wrote this message before deciding, so it was withdrawn. Propose it again only if it still fits.",
            ]
        );
        assert!(untold(&mut events).is_empty(), "told once");
        events[2]["result"] = result(&Err("tmux: no server".into()), "t3");
        assert_eq!(
            untold(&mut events),
            ["You proposed starting a session on hp in demo-app on branch eng-1. I approved it, but it failed: tmux: no server."]
        );
    }

    #[test]
    fn reviews_and_answers_are_told_with_their_outcome() {
        let mut events = vec![
            json!({ "role": "review", "machine": "hp", "name": "hp-app-2", "of": { "machine": "hp", "name": "hp-app", "branch": "eng-1" }, "verdict": "changes", "summary": "One bug.", "findings": [{ "severity": "high", "place": "a.rs:1", "text": "Off by one." }] }),
            json!({ "role": "session", "machine": "hp", "name": "hp-app", "state": "blocked", "answer": { "key": "1", "label": "Yes" } }),
        ];
        assert_eq!(
            untold(&mut events),
            [
                "The review of branch eng-1 by hp-app-2 on hp finished: changes needed. One bug. Findings: 1) high a.rs:1 Off by one.",
                "I answered the question hp-app on hp asked with \"Yes\".",
            ]
        );
        events[0]["outcome"] = json!({ "decision": "sent", "findings": [0], "to": "hp-app" });
        assert_eq!(
            untold(&mut events),
            ["I sent 1 of the findings from the review of branch eng-1 to hp-app to fix."]
        );
        assert!(untold(&mut events).is_empty());
    }

    #[test]
    fn a_review_decided_before_it_was_told_gives_both_lines() {
        let mut events = vec![
            json!({ "role": "review", "machine": "hp", "name": "hp-app-2", "of": { "name": "hp-app" }, "verdict": "ready", "summary": "Fine.", "findings": [], "outcome": { "decision": "dismissed" } }),
        ];
        assert_eq!(
            untold(&mut events),
            [
                "The review of the work of hp-app by hp-app-2 on hp finished: ready. Fine. No findings.",
                "I dismissed the review of the work of hp-app.",
            ]
        );
        assert!(untold(&mut events).is_empty());
    }

    #[test]
    fn the_news_goes_before_the_message() {
        assert_eq!(with_news(&[], "hi"), "hi");
        assert_eq!(
            with_news(&["a".into(), "b".into()], "hi"),
            "What happened since your last reply:\n- a\n- b\n\nMy message:\nhi"
        );
    }

    #[test]
    fn interrupted_steps_are_marked_failed() {
        let mut e = start(By::You);
        e["status"] = json!("approved");
        e["decided"] = json!("t1");
        let mut events = vec![e];
        interrupted(&mut events);
        assert_eq!(events[0]["result"]["ok"], false);
        assert_eq!(events[0]["result"]["at"], "t1");
    }
}
