use super::record::Run;
use crate::sessions::{STEP_TRANSCRIPT_FILE, STEP_TRANSCRIPT_MAX, STEP_TRANSCRIPT_SKIPPED};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

const TEXT_MAX: usize = 20_000;
const INPUT_MAX: usize = 2_000;
const RESULT_MAX: usize = 4_000;
const ITEMS_MAX: usize = 1_500;
const INPUT_KEYS: [&str; 8] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    Prompt {
        text: String,
        at: String,
    },
    Agent {
        text: String,
        at: String,
    },
    Tool {
        name: String,
        input: String,
        result: String,
        failed: bool,
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Transcript {
    pub files: Vec<String>,
    pub items: Vec<Item>,
    // Lines too long to send, the oldest items left out past ITEMS_MAX, and whether the machine's
    // answer was cut at its size limit.
    pub skipped: usize,
    pub dropped: usize,
    pub cut: bool,
}

// The marker in "step: <marker>", as every prompt and result of one try carries it. The prefix
// keeps a step named "fix" from claiming the prompts of one named "review_fix".
pub fn needles(run: &Run, step: &str) -> Vec<String> {
    let runs = run.steps.get(step).map_or(0, |s| s.runs);
    (1..=runs)
        .map(|n| needle(&super::prompts::marker_of_try(run, step, n)))
        .collect()
}

fn needle(marker: &str) -> String {
    format!("step: {marker}")
}

fn owners(run: &Run) -> Vec<(String, String)> {
    let mut all: Vec<(String, String)> = run
        .steps
        .keys()
        .flat_map(|id| needles(run, id).into_iter().map(move |n| (n, id.clone())))
        .collect();
    all.sort_by_key(|(n, _)| std::cmp::Reverse(n.len()));
    all
}

pub(crate) fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

pub(crate) fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str() {
                Some("text") => p["text"].as_str().map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn input_of(input: &Value) -> String {
    let named = INPUT_KEYS
        .iter()
        .find_map(|k| input[*k].as_str().filter(|s| !s.is_empty()));
    let text = match named {
        Some(s) => s.to_string(),
        None if input.is_null() => String::new(),
        None => input.to_string(),
    };
    cut(&text, INPUT_MAX)
}

struct Section<'a> {
    file: &'a str,
    lines: Vec<Value>,
}

fn sections(text: &str) -> (Vec<Section<'_>>, usize) {
    let mut out: Vec<Section> = Vec::new();
    let mut skipped = 0;
    for line in text.lines() {
        if let Some(file) = line.strip_prefix(STEP_TRANSCRIPT_FILE) {
            out.push(Section {
                file,
                lines: Vec::new(),
            });
        } else if line == STEP_TRANSCRIPT_SKIPPED {
            skipped += 1;
        } else if let (Some(s), Ok(v)) = (out.last_mut(), serde_json::from_str::<Value>(line)) {
            s.lines.push(v);
        }
    }
    let first_at = |s: &Section| {
        s.lines
            .iter()
            .find_map(|l| l["timestamp"].as_str().map(str::to_string))
            .unwrap_or_default()
    };
    out.sort_by_cached_key(first_at);
    (out, skipped)
}

// The parts of each transcript that belong to this step: from a prompt carrying one of its
// markers up to a prompt carrying another step's, since steps can share one session.
pub fn read(text: &str, run: &Run, step: &str) -> Transcript {
    let owners = owners(run);
    let (sections, skipped) = sections(text);
    let mut t = Transcript {
        skipped,
        cut: text.len() >= STEP_TRANSCRIPT_MAX,
        ..Transcript::default()
    };
    for section in sections {
        let mut mine = false;
        let mut used = false;
        let mut tools: HashMap<String, usize> = HashMap::new();
        for line in section.lines {
            if line["isMeta"] == true || line["isSidechain"] == true {
                continue;
            }
            let at = line["timestamp"].as_str().unwrap_or_default().to_string();
            let content = &line["message"]["content"];
            match line["type"].as_str() {
                Some("user") => {
                    let prompt = match content {
                        Value::String(_) => text_of(content),
                        Value::Array(parts) => text_of(&Value::Array(
                            parts
                                .iter()
                                .filter(|p| p["type"] == "text")
                                .cloned()
                                .collect(),
                        )),
                        _ => String::new(),
                    };
                    if let Some((_, owner)) = owners.iter().find(|(n, _)| prompt.contains(n)) {
                        mine = owner == step;
                    }
                    if !mine {
                        continue;
                    }
                    if !prompt.trim().is_empty() {
                        t.items.push(Item::Prompt {
                            text: cut(&prompt, TEXT_MAX),
                            at: at.clone(),
                        });
                        used = true;
                    }
                    for part in content.as_array().into_iter().flatten() {
                        if part["type"] != "tool_result" {
                            continue;
                        }
                        let id = part["tool_use_id"].as_str().unwrap_or_default();
                        let Some(Item::Tool { result, failed, .. }) =
                            tools.get(id).and_then(|i| t.items.get_mut(*i))
                        else {
                            continue;
                        };
                        *result = cut(&text_of(&part["content"]), RESULT_MAX);
                        *failed = part["is_error"] == true;
                    }
                }
                Some("assistant") if mine => {
                    for part in content.as_array().into_iter().flatten() {
                        match part["type"].as_str() {
                            Some("text") => {
                                let text = part["text"].as_str().unwrap_or_default();
                                if text.trim().is_empty() {
                                    continue;
                                }
                                t.items.push(Item::Agent {
                                    text: cut(text, TEXT_MAX),
                                    at: at.clone(),
                                });
                            }
                            Some("tool_use") => {
                                let id = part["id"].as_str().unwrap_or_default().to_string();
                                tools.insert(id, t.items.len());
                                t.items.push(Item::Tool {
                                    name: part["name"].as_str().unwrap_or("tool").to_string(),
                                    input: input_of(&part["input"]),
                                    result: String::new(),
                                    failed: false,
                                    at: at.clone(),
                                });
                            }
                            _ => continue,
                        }
                        used = true;
                    }
                }
                _ => {}
            }
        }
        if used {
            t.files.push(section.file.to_string());
        }
    }
    if t.items.len() > ITEMS_MAX {
        t.dropped = t.items.len() - ITEMS_MAX;
        t.items.drain(..t.dropped);
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run() -> Run {
        let mut run = Run {
            id: "run-abc123".into(),
            ..Run::default()
        };
        run.state_of("review").runs = 2;
        run.state_of("review_fix").runs = 1;
        run.state_of("fix").runs = 1;
        run
    }

    fn line(v: Value) -> String {
        v.to_string()
    }

    fn prompt(text: &str, at: &str) -> String {
        line(json!({"type": "user", "timestamp": at, "message": {"role": "user", "content": text}}))
    }

    #[test]
    fn needles_name_each_try_of_the_step() {
        assert_eq!(
            needles(&run(), "review"),
            vec!["step: review-1-abc123", "step: review-2-abc123"]
        );
        assert!(needles(&run(), "never").is_empty());
    }

    #[test]
    fn a_shared_session_gives_each_step_only_its_own_part() {
        let text = [
            "@@file a.jsonl".to_string(),
            prompt("Fix it.\nstep: review_fix-1-abc123", "2026-01-01T10:00:00Z"),
            line(json!({"type": "assistant", "timestamp": "2026-01-01T10:01:00Z", "message": {"content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "text", "text": "Fixed the dedup."},
            ]}})),
            prompt("Fix the rest.\nstep: fix-1-abc123", "2026-01-01T10:02:00Z"),
            line(json!({"type": "assistant", "timestamp": "2026-01-01T10:03:00Z", "message": {"content": [
                {"type": "text", "text": "Fixed the rest."},
            ]}})),
        ]
        .join("\n");
        let t = read(&text, &run(), "review_fix");
        assert_eq!(t.files, vec!["a.jsonl"]);
        let texts: Vec<_> = t
            .items
            .iter()
            .map(|i| match i {
                Item::Prompt { text, .. } | Item::Agent { text, .. } => text.as_str(),
                Item::Tool { .. } => "tool",
            })
            .collect();
        assert_eq!(
            texts,
            vec!["Fix it.\nstep: review_fix-1-abc123", "Fixed the dedup."]
        );
        let fix = read(&text, &run(), "fix");
        assert_eq!(fix.items.len(), 2, "{fix:?}");
    }

    #[test]
    fn a_tool_call_carries_its_result() {
        let text = [
            "@@file b.jsonl".to_string(),
            prompt("Review.\nstep: review-2-abc123", "2026-01-02T10:00:00Z"),
            line(json!({"type": "assistant", "timestamp": "t1", "message": {"content": [
                {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "bin/rspec", "description": "Run specs"}},
            ]}})),
            line(json!({"type": "user", "timestamp": "t2", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "tu1", "is_error": true, "content": [{"type": "text", "text": "1 failure"}]},
            ]}})),
            "@@skipped".to_string(),
            line(json!({"type": "user", "isMeta": true, "message": {"content": "Caveat: step: review-2-abc123"}})),
        ]
        .join("\n");
        let t = read(&text, &run(), "review");
        assert_eq!(t.skipped, 1);
        assert_eq!(
            t.items[1],
            Item::Tool {
                name: "Bash".into(),
                input: "bin/rspec".into(),
                result: "1 failure".into(),
                failed: true,
                at: "t1".into()
            }
        );
        assert_eq!(t.items.len(), 2, "the meta line is left out");
    }

    #[test]
    fn transcripts_read_oldest_first_and_unrelated_ones_are_left_out() {
        let text = [
            "@@file new.jsonl".to_string(),
            prompt("Again.\nstep: review-2-abc123", "2026-01-02T10:00:00Z"),
            "@@file other.jsonl".to_string(),
            prompt("Someone else's work", "2026-01-01T09:00:00Z"),
            "@@file old.jsonl".to_string(),
            prompt("First.\nstep: review-1-abc123", "2026-01-01T10:00:00Z"),
            "not json".to_string(),
        ]
        .join("\n");
        let t = read(&text, &run(), "review");
        assert_eq!(t.files, vec!["old.jsonl", "new.jsonl"]);
        assert!(!t.cut);
    }

    #[test]
    fn long_text_is_cut_and_old_items_dropped() {
        assert_eq!(cut("abcdef", 3), "abc…");
        assert_eq!(cut("åäö", 3), "åäö");
        let mut lines = vec![
            "@@file a.jsonl".to_string(),
            prompt("step: fix-1-abc123", "t"),
        ];
        for n in 0..ITEMS_MAX + 5 {
            lines.push(line(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": format!("reply {n}")}]}})));
        }
        let t = read(&lines.join("\n"), &run(), "fix");
        assert_eq!(t.items.len(), ITEMS_MAX);
        assert_eq!(t.dropped, 6);
        assert_eq!(
            t.items.last(),
            Some(&Item::Agent {
                text: format!("reply {}", ITEMS_MAX + 4),
                at: String::new()
            })
        );
    }

    #[test]
    fn a_tool_input_names_what_it_acts_on() {
        assert_eq!(
            input_of(&json!({"file_path": "/r/a.rb", "old_string": "x"})),
            "/r/a.rb"
        );
        assert_eq!(input_of(&json!({"todos": [1]})), r#"{"todos":[1]}"#);
        assert_eq!(input_of(&Value::Null), "");
    }
}
