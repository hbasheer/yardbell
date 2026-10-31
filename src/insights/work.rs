use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

const TEXT_MAX: usize = 1500;
const ACTIONS_KEPT: usize = 10;
const FILES_KEPT: usize = 30;
const ACTION_MAX: usize = 160;
pub const LATEST_MARK: &str = "--- latest ---";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Action {
    pub tool: String,
    pub what: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Work {
    pub title: String,
    pub first_prompt: String,
    pub last_prompt: String,
    pub message: String,
    pub actions: Vec<Action>,
    pub files: Vec<String>,
    pub partial: bool,
    pub shared: bool,
    pub screen: String,
}

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{}...", kept.trim_end())
}

fn is_person(text: &str) -> bool {
    let text = text.trim_start();
    !text.is_empty()
        && !text.starts_with('<')
        && !text.starts_with("Caveat:")
        && !text.starts_with("[Request interrupted")
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn relative(path: &str, cwd: &str) -> String {
    path.strip_prefix(cwd)
        .map(|p| p.trim_start_matches('/'))
        .filter(|p| !p.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn edits_file(tool: &str) -> bool {
    matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit")
}

fn action_of(tool: &str, input: &Value, cwd: &str) -> Action {
    let field = |key: &str| input[key].as_str().unwrap_or_default();
    let path = || {
        let at = [field("file_path"), field("notebook_path"), field("path")]
            .into_iter()
            .find(|p| !p.is_empty())
            .unwrap_or_default();
        relative(at, cwd)
    };
    let what = match tool {
        t if edits_file(t) => format!("Edited {}", path()),
        "Read" => format!("Read {}", path()),
        "Bash" => {
            let said = field("description");
            let command = field("command").lines().next().unwrap_or_default();
            format!("Ran {}", if said.is_empty() { command } else { said })
        }
        "Grep" | "Glob" => format!("Searched for {}", field("pattern")),
        "Task" | "Agent" => format!("Started an agent: {}", field("description")),
        "WebFetch" => format!("Read {}", field("url")),
        "WebSearch" => format!("Searched the web for {}", field("query")),
        other => format!("Used {other}"),
    };
    Action {
        tool: tool.to_string(),
        what: cut(&what, ACTION_MAX),
    }
}

// Lines come from the start of the transcript, then the mark, then its latest part. Agents started
// by the session itself write their own lines, marked as a sidechain, and are not this session.
pub fn of_transcript(text: &str, cwd: &str) -> Option<Work> {
    let mut lines = text.lines();
    let size: u64 = lines.next()?.trim().parse().ok()?;
    let mut work = Work {
        partial: size > READ_WHOLE,
        ..Work::default()
    };
    let mut seen = false;
    let mut files = Vec::new();
    for line in lines {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["type"] == "ai-title" {
            if let Some(title) = entry["aiTitle"].as_str() {
                work.title = cut(title, ACTION_MAX);
            }
            continue;
        }
        if entry["isSidechain"] == true
            || entry["isMeta"] == true
            || entry["isCompactSummary"] == true
            || entry["isVisibleInTranscriptOnly"] == true
        {
            continue;
        }
        let content = &entry["message"]["content"];
        match entry["type"].as_str() {
            Some("user") => {
                let said = text_of(content);
                if !is_person(&said) {
                    continue;
                }
                seen = true;
                let said = cut(&said, TEXT_MAX);
                if work.first_prompt.is_empty() {
                    work.first_prompt = said.clone();
                }
                work.last_prompt = said;
            }
            Some("assistant") => {
                seen = true;
                let said = text_of(content);
                if !said.trim().is_empty() {
                    work.message = cut(&said, TEXT_MAX);
                }
                for block in content.as_array().into_iter().flatten() {
                    if block["type"] != "tool_use" {
                        continue;
                    }
                    let tool = block["name"].as_str().unwrap_or_default();
                    let action = action_of(tool, &block["input"], cwd);
                    if edits_file(tool) {
                        files.push(action.what.trim_start_matches("Edited ").to_string());
                    }
                    work.actions.push(action);
                }
            }
            _ => {}
        }
    }
    if !seen {
        return None;
    }
    if work.last_prompt == work.first_prompt {
        work.last_prompt.clear();
    }
    let from = work.actions.len().saturating_sub(ACTIONS_KEPT);
    work.actions.drain(..from);
    work.actions.reverse();
    let mut kept = BTreeSet::new();
    work.files = files
        .into_iter()
        .rev()
        .filter(|f| kept.insert(f.clone()))
        .take(FILES_KEPT)
        .collect();
    Some(work)
}

pub const READ_WHOLE: u64 = 4 * 1024 * 1024;

pub fn scrub(work: &mut Work, saved: &[String]) {
    let clean = |text: &mut String| *text = crate::mcp_read::scrubbed(text, saved);
    clean(&mut work.title);
    clean(&mut work.first_prompt);
    clean(&mut work.last_prompt);
    clean(&mut work.message);
    clean(&mut work.screen);
    work.files.iter_mut().for_each(clean);
    for action in &mut work.actions {
        clean(&mut action.what);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn said(role: &str, content: Value) -> String {
        json!({ "type": role, "message": { "content": content } }).to_string()
    }

    fn tool(name: &str, input: Value) -> String {
        said(
            "assistant",
            json!([{ "type": "tool_use", "name": name, "input": input }]),
        )
    }

    fn transcript(lines: &[String]) -> String {
        format!("1000\n{}\n", lines.join("\n"))
    }

    #[test]
    fn it_says_what_the_agent_was_asked_and_did() {
        let text = transcript(&[
            json!({ "type": "ai-title", "aiTitle": "Fix the login" }).to_string(),
            said("user", json!("Fix the login bug")),
            tool("Read", json!({ "file_path": "/r/src/login.rs" })),
            said(
                "user",
                json!([{ "type": "tool_result", "content": "secret file body" }]),
            ),
            tool("Edit", json!({ "file_path": "/r/src/login.rs" })),
            tool(
                "Bash",
                json!({ "command": "cargo test\nmore", "description": "Run the tests" }),
            ),
            said(
                "assistant",
                json!([{ "type": "text", "text": "The tests pass now." }]),
            ),
            said("user", json!("Now add a test for the lockout")),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert_eq!(work.title, "Fix the login");
        assert_eq!(work.first_prompt, "Fix the login bug");
        assert_eq!(work.last_prompt, "Now add a test for the lockout");
        assert_eq!(work.message, "The tests pass now.");
        assert_eq!(work.files, ["src/login.rs"]);
        let did: Vec<&str> = work.actions.iter().map(|a| a.what.as_str()).collect();
        assert_eq!(
            did,
            [
                "Ran Run the tests",
                "Edited src/login.rs",
                "Read src/login.rs"
            ]
        );
        assert!(!text_contains(&work, "secret file body"));
    }

    fn text_contains(work: &Work, needle: &str) -> bool {
        serde_json::to_string(work).unwrap().contains(needle)
    }

    #[test]
    fn only_what_a_person_typed_counts_as_a_prompt() {
        let text = transcript(&[
            said("user", json!("<system-reminder>not a person</system-reminder>")),
            said("user", json!("<command-name>/clear</command-name>")),
            json!({ "type": "user", "isMeta": true, "message": { "content": "meta" } }).to_string(),
            json!({ "type": "user", "isCompactSummary": true, "message": { "content": "summary" } }).to_string(),
            said("user", json!("[Request interrupted by user]")),
            said("user", json!("The real one")),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert_eq!(work.first_prompt, "The real one");
        assert_eq!(work.last_prompt, "", "the same prompt is not shown twice");
    }

    #[test]
    fn a_sidechain_is_not_this_session() {
        let text = transcript(&[
            said("user", json!("Mine")),
            json!({ "type": "assistant", "isSidechain": true, "message": { "content": [
                { "type": "tool_use", "name": "Edit", "input": { "file_path": "/r/other.rs" } },
                { "type": "text", "text": "from a helper" },
            ] } })
            .to_string(),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert!(work.actions.is_empty() && work.files.is_empty());
        assert_eq!(work.message, "");
    }

    #[test]
    fn long_and_broken_text_is_handled() {
        let long = "x".repeat(5000);
        let text = transcript(&[
            "{ cut off by the read".to_string(),
            "not json".to_string(),
            said("user", json!(long)),
            tool("Bash", json!({ "command": "y".repeat(500) })),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert_eq!(work.first_prompt.chars().count(), TEXT_MAX + 3);
        assert!(work.actions[0].what.chars().count() <= ACTION_MAX + 3);
    }

    #[test]
    fn it_keeps_the_newest_actions_and_each_file_once() {
        let mut lines = vec![said("user", json!("Go"))];
        for n in 0..15 {
            lines.push(tool(
                "Edit",
                json!({ "file_path": format!("/r/{}.rs", n % 3) }),
            ));
        }
        let work = of_transcript(&transcript(&lines), "/r").unwrap();
        assert_eq!(work.actions.len(), ACTIONS_KEPT);
        assert_eq!(work.files, ["2.rs", "1.rs", "0.rs"]);
    }

    #[test]
    fn a_long_transcript_says_it_is_partial() {
        let text = format!("{}\n{}\n", READ_WHOLE + 1, said("user", json!("Go")));
        assert!(of_transcript(&text, "/r").unwrap().partial);
        assert!(
            !of_transcript(&transcript(&[said("user", json!("Go"))]), "/r")
                .unwrap()
                .partial
        );
    }

    #[test]
    fn nothing_readable_is_none() {
        assert_eq!(of_transcript("", "/r"), None);
        assert_eq!(of_transcript("12\n", "/r"), None);
        assert_eq!(of_transcript("no size\n", "/r"), None);
    }

    #[test]
    fn saved_secrets_are_removed() {
        let text = transcript(&[
            said("user", json!("Go")),
            tool("Bash", json!({ "command": "curl -H shh-secret-1 x" })),
        ]);
        let mut work = of_transcript(&text, "/r").unwrap();
        scrub(&mut work, &["shh-secret-1".to_string()]);
        assert!(!text_contains(&work, "shh-secret-1"));
    }
}
