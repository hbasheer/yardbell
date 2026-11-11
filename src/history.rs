use crate::pipeline::transcript::{cut, text_of};
use crate::shell::{quote, Duration};
use serde::Serialize;
use serde_json::Value;

pub const FOLDER_FILES: usize = 60;
pub const ALL_FILES: usize = 120;
pub const HISTORY_MAX: usize = 8 * 1024 * 1024;
pub const WAIT: Duration = Duration::from_secs(25);
const FILE: &str = "@@file ";
const COUNT: &str = "@@count ";
const SCANNED: &str = "@@scanned ";
const PROMPT_LINES: usize = 12;
const PROMPT_LINE_MAX: usize = 60_000;
const REPLY_LINE_MAX: usize = 200_000;
const TITLE_MAX: usize = 160;
const TEXT_MAX: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Past {
    pub id: String,
    pub folder: String,
    pub title: String,
    pub prompt: String,
    pub summary: String,
    pub updated: i64,
    pub messages: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct History {
    pub sessions: Vec<Past>,
    pub scanned: usize,
    pub cut: bool,
}

// One pass over each transcript keeps what a list needs: Claude Code's own title, the first few
// prompts, the last reply with text, and how many messages there were. Lines too long to be a
// prompt worth showing never leave the machine.
fn awk_program() -> String {
    format!(
        r#"index($0, "\"type\":\"ai-title\"") {{ title = $0; next }}
index($0, "\"isSidechain\":true") {{ next }}
index($0, "\"type\":\"user\"") {{ n++; if (users < {PROMPT_LINES} && length($0) < {PROMPT_LINE_MAX}) {{ print; users++ }} next }}
index($0, "\"type\":\"assistant\"") {{ n++; if (index($0, "\"type\":\"text\"") && length($0) < {REPLY_LINE_MAX}) reply = $0; next }}
END {{ if (title != "") print title; if (reply != "") print reply; print "{COUNT}" n + 0 }}"#
    )
}

// Claude Code keeps each session under a folder named after the folder it ran in. Without a
// folder, the newest transcripts of every project are read. It runs under sh, since a zsh login
// shell would stop at a glob that matches nothing.
pub fn command(folder: Option<&str>) -> String {
    let (enter, glob, limit) = match folder {
        Some(path) => (
            format!(
                "cd -- \"$(printf %s {} | sed 's/[^a-zA-Z0-9]/-/g')\" 2>/dev/null || exit 0; ",
                quote(path)
            ),
            "*.jsonl",
            FOLDER_FILES,
        ),
        None => (String::new(), "*/*.jsonl", ALL_FILES),
    };
    let script = format!(
        "cd \"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects\" 2>/dev/null || exit 0; {enter}\
         printf '{SCANNED}%s\\n' \"$(ls -- {glob} 2>/dev/null | wc -l | tr -d ' ')\"; \
         ls -t -- {glob} 2>/dev/null | head -n {limit} | while IFS= read -r f; do \
         [ -f \"$f\" ] && [ ! -L \"$f\" ] || continue; \
         t=$(stat -c %Y -- \"$f\" 2>/dev/null || stat -f %m -- \"$f\" 2>/dev/null); \
         printf '%s%s\\t%s\\n' {} \"$f\" \"$t\"; \
         LC_ALL=C awk {} \"$f\"; \
         done | head -c {HISTORY_MAX}; true",
        quote(FILE),
        quote(&awk_program()),
    );
    format!("sh -c {}", quote(&script))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !id.starts_with('-')
}

fn prompt_of(line: &Value) -> Option<String> {
    if line["isMeta"] == true {
        return None;
    }
    let content = &line["message"]["content"];
    let text = match content {
        Value::Array(parts) => text_of(&Value::Array(
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .cloned()
                .collect(),
        )),
        other => text_of(other),
    };
    let text = text.trim();
    let noise = text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:");
    (!noise).then(|| text.to_string())
}

fn reply_of(line: &Value) -> String {
    line["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["type"] == "text")
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct Reading {
    past: Past,
    title: String,
}

impl Reading {
    fn finish(self) -> Past {
        let mut past = self.past;
        let first = past.prompt.lines().next().unwrap_or_default().to_string();
        past.title = cut(
            &one_line(if self.title.is_empty() {
                &first
            } else {
                &self.title
            }),
            TITLE_MAX,
        );
        past.prompt = cut(&one_line(&past.prompt), TEXT_MAX);
        past
    }
}

pub fn parse(text: &str) -> History {
    let mut history = History {
        cut: text.len() >= HISTORY_MAX,
        ..History::default()
    };
    let mut current: Option<Reading> = None;
    for line in text.lines() {
        if let Some(n) = line.strip_prefix(SCANNED) {
            history.scanned = n.trim().parse().unwrap_or(0);
            continue;
        }
        if let Some(rest) = line.strip_prefix(FILE) {
            history.sessions.extend(current.take().map(Reading::finish));
            let (file, at) = rest.rsplit_once('\t').unwrap_or((rest, ""));
            let id = file
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .trim_end_matches(".jsonl");
            current = valid_id(id).then(|| Reading {
                past: Past {
                    id: id.to_string(),
                    folder: String::new(),
                    title: String::new(),
                    prompt: String::new(),
                    summary: String::new(),
                    updated: at.trim().parse().unwrap_or(0),
                    messages: 0,
                },
                title: String::new(),
            });
            continue;
        }
        let Some(r) = current.as_mut() else {
            continue;
        };
        if let Some(n) = line.strip_prefix(COUNT) {
            r.past.messages = n.trim().parse().unwrap_or(0);
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["isSidechain"] == true {
            continue;
        }
        match v["type"].as_str() {
            Some("ai-title") => r.title = v["aiTitle"].as_str().unwrap_or_default().to_string(),
            Some("user") => {
                if r.past.folder.is_empty() {
                    r.past.folder = v["cwd"].as_str().unwrap_or_default().to_string();
                }
                if r.past.prompt.is_empty() {
                    r.past.prompt = prompt_of(&v).unwrap_or_default();
                }
            }
            Some("assistant") => {
                let reply = one_line(&reply_of(&v));
                if !reply.is_empty() {
                    r.past.summary = cut(&reply, TEXT_MAX);
                }
            }
            _ => {}
        }
    }
    history.sessions.extend(current.map(Reading::finish));
    history
        .sessions
        .sort_by_key(|p| std::cmp::Reverse(p.updated));
    history
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> String {
        json!({"type": "user", "cwd": "/r/app", "sessionId": "s", "message": {"role": "user", "content": text}})
            .to_string()
    }

    fn reply(text: &str) -> String {
        json!({"type": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "hidden"},
            {"type": "text", "text": text},
        ]}})
        .to_string()
    }

    fn fixture() -> String {
        [
            json!({"type": "user", "isMeta": true, "cwd": "/r/app", "message": {"content": "Caveat: ignore"}}).to_string(),
            user("<command-name>/clear</command-name>"),
            user("Fix the login redirect\nand add a test"),
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]}}).to_string(),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]}}).to_string(),
            reply("Fixed it.\n\nThe test   passes now."),
            json!({"type": "assistant", "isSidechain": true, "message": {"content": [{"type": "text", "text": "a subagent"}]}}).to_string(),
        ]
        .join("\n")
            + "\n"
    }

    #[test]
    fn a_transcript_gives_its_prompt_last_reply_and_count() {
        let text = format!(
            "{SCANNED}2\n{FILE}a1b2c3d4-0000-4000-8000-000000000001.jsonl\t1700000000\n{}{COUNT}5\n",
            fixture()
        );
        let h = parse(&text);
        assert_eq!(h.scanned, 2);
        assert_eq!(
            h.sessions,
            vec![Past {
                id: "a1b2c3d4-0000-4000-8000-000000000001".into(),
                folder: "/r/app".into(),
                title: "Fix the login redirect".into(),
                prompt: "Fix the login redirect and add a test".into(),
                summary: "Fixed it. The test passes now.".into(),
                updated: 1_700_000_000,
                messages: 5,
            }]
        );
    }

    #[test]
    fn claude_codes_title_wins_and_newest_comes_first() {
        let title = json!({"type": "ai-title", "aiTitle": "Login redirect fix"}).to_string();
        let text = format!(
            "{FILE}-r-app/old-one.jsonl\t100\n{}\n{COUNT}1\n{FILE}-r-app/new-one.jsonl\t200\n{}\n{title}\n{COUNT}2\n{FILE}-r-app/bad id.jsonl\t300\n{}\n",
            user("Old work"),
            user("New work"),
            user("Never listed")
        );
        let h = parse(&text);
        let ids: Vec<&str> = h.sessions.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["new-one", "old-one"]);
        assert_eq!(h.sessions[0].title, "Login redirect fix");
        assert_eq!(h.sessions[0].prompt, "New work");
        assert_eq!(h.sessions[1].summary, "");
    }

    #[test]
    fn the_command_reads_a_folders_transcripts_on_the_machine() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".claude/projects/-r-app");
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = fixture();
        body.push_str(&format!(
            "{{\"type\":\"user\",\"huge\":\"{}\"}}\n",
            "x".repeat(PROMPT_LINE_MAX)
        ));
        std::fs::write(
            dir.join("a1b2c3d4-0000-4000-8000-000000000001.jsonl"),
            &body,
        )
        .unwrap();
        let other = home.path().join(".claude/projects/-r-other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("ffff0000-0000-4000-8000-000000000002.jsonl"),
            user("Elsewhere"),
        )
        .unwrap();
        let run = |folder: Option<&str>| {
            let out = std::process::Command::new("sh")
                .args(["-c", &command(folder)])
                .env("HOME", home.path())
                .env_remove("CLAUDE_CONFIG_DIR")
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let said = run(Some("/r/app"));
        assert!(
            !said.contains("xxxx"),
            "a line too long is left on the machine"
        );
        let h = parse(&said);
        assert_eq!(h.scanned, 1);
        assert_eq!(h.sessions.len(), 1);
        assert_eq!(h.sessions[0].title, "Fix the login redirect");
        assert_eq!(
            h.sessions[0].messages, 7,
            "user and assistant lines, not a subagent's"
        );
        assert!(h.sessions[0].updated > 0);
        let all = parse(&run(None));
        assert_eq!(all.scanned, 2);
        assert_eq!(all.sessions.len(), 2);
        assert!(parse(&run(Some("/r/none"))).sessions.is_empty());
    }

    #[test]
    fn session_ids_are_checked() {
        assert!(valid_id("a1b2c3d4-0000-4000-8000-000000000001"));
        for bad in ["", "-x", "a b", "a;b", "../x", &"a".repeat(81)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }
}
