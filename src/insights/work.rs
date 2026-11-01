use super::Period;
use chrono::{DateTime, FixedOffset};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

const TEXT_MAX: usize = 1500;
const ACTION_MAX: usize = 160;
const STEPS_KEPT: usize = 100;
// Yardbell notices a change of state at its next check, so what the transcript times just before
// or after a change can belong to the other side of it.
const LAG_SECS: i64 = 60;
pub const LATEST_MARK: &str = "--- latest ---";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Action {
    pub tool: String,
    pub what: String,
}

#[derive(Debug, Clone, PartialEq)]
enum Said {
    Person(String),
    Agent(String),
    Question(String),
    Did(Action),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Moment {
    at: DateTime<FixedOffset>,
    said: Said,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Work {
    pub title: String,
    pub first_prompt: String,
    #[serde(skip)]
    pub moments: Vec<Moment>,
    pub partial: bool,
    pub shared: bool,
    pub screen: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Part {
    pub asked: Vec<String>,
    pub question: String,
    pub stopped_at: String,
    pub summary: String,
    pub did: Vec<Action>,
    // Older steps left out of `did`, still counted in `summary`.
    pub more: usize,
    pub files: Vec<String>,
    pub said: String,
}

impl Part {
    pub fn is_empty(&self) -> bool {
        *self == Part::default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Parts {
    pub before: Part,
    pub periods: Vec<Part>,
}

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{}...", kept.trim_end())
}

// Agents write markdown, and Insights shows plain text.
fn plain(text: &str) -> String {
    text.lines()
        .map(|line| line.trim_start_matches('#').trim_start_matches(' '))
        .collect::<Vec<_>>()
        .join("\n")
        .replace("**", "")
        .replace('`', "")
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
    if let Some(inside) = path
        .strip_prefix(cwd)
        .map(|p| p.trim_start_matches('/'))
        .filter(|p| !p.is_empty())
    {
        return inside.to_string();
    }
    ["/Users/", "/home/"]
        .iter()
        .find_map(|home| path.strip_prefix(home)?.split_once('/'))
        .map_or_else(|| path.to_string(), |(_, rest)| format!("~/{rest}"))
}

fn edits_file(tool: &str) -> bool {
    matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit")
}

fn action_of(tool: &str, input: &Value, cwd: &str) -> Option<Action> {
    let field = |key: &str| input[key].as_str().unwrap_or_default();
    let path = || {
        let at = [field("file_path"), field("notebook_path"), field("path")]
            .into_iter()
            .find(|p| !p.is_empty())
            .unwrap_or_default();
        relative(at, cwd)
    };
    let what = match tool {
        "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" | "TaskStop"
        | "ToolSearch" | "Monitor" | "ScheduleWakeup" | "EnterPlanMode" | "ExitPlanMode" => {
            return None
        }
        t if edits_file(t) => format!("Edited {}", path()),
        "Read" => format!("Read {}", path()),
        "Bash" => {
            let said = field("description");
            let command = field("command").lines().next().unwrap_or_default();
            if said.is_empty() {
                format!("Ran {command}")
            } else {
                said.to_string()
            }
        }
        "Grep" | "Glob" => format!("Searched for {}", field("pattern")),
        "Task" | "Agent" => format!("Started an agent: {}", field("description")),
        "WebFetch" => format!("Read {}", field("url")),
        "WebSearch" => format!("Searched the web for {}", field("query")),
        "Skill" => format!("Used the {} skill", field("skill")),
        other => match other.strip_prefix("mcp__").and_then(|t| t.split_once("__")) {
            Some((server, name)) => format!("Used {name} in {server}"),
            None => format!("Used {other}"),
        },
    };
    Some(Action {
        tool: tool.to_string(),
        what: cut(&what, ACTION_MAX),
    })
}

fn question_of(input: &Value) -> String {
    let asked: Vec<&str> = input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|q| q["question"].as_str())
        .collect();
    cut(&plain(&asked.join(" ")), TEXT_MAX)
}

// Lines come from the start of the transcript, then the mark, then its latest part, so a short
// transcript gives the same line twice. Agents started by the session itself write their own lines,
// marked as a sidechain, and are not this session.
pub fn of_transcript(text: &str, cwd: &str) -> Option<Work> {
    let mut lines = text.lines();
    let size: u64 = lines.next()?.trim().parse().ok()?;
    let mut work = Work {
        partial: size > READ_WHOLE,
        ..Work::default()
    };
    let mut seen = false;
    let mut read = BTreeSet::new();
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
        if let Some(id) = entry["uuid"].as_str() {
            if !read.insert(id.to_string()) {
                continue;
            }
        }
        let at = entry["timestamp"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
        let mut note = |said: Said| {
            if let Some(at) = at {
                work.moments.push(Moment { at, said });
            }
        };
        let content = &entry["message"]["content"];
        match entry["type"].as_str() {
            Some("user") => {
                let said = text_of(content);
                if !is_person(&said) {
                    continue;
                }
                seen = true;
                let said = cut(&said, TEXT_MAX);
                note(Said::Person(said.clone()));
                if work.first_prompt.is_empty() {
                    work.first_prompt = said;
                }
            }
            Some("assistant") => {
                seen = true;
                let said = text_of(content);
                if !said.trim().is_empty() {
                    note(Said::Agent(cut(&plain(&said), TEXT_MAX)));
                }
                for block in content.as_array().into_iter().flatten() {
                    if block["type"] != "tool_use" {
                        continue;
                    }
                    let tool = block["name"].as_str().unwrap_or_default();
                    if tool == "AskUserQuestion" {
                        note(Said::Question(question_of(&block["input"])));
                    } else if let Some(action) = action_of(tool, &block["input"], cwd) {
                        note(Said::Did(action));
                    }
                }
            }
            _ => {}
        }
    }
    seen.then_some(work)
}

pub const READ_WHOLE: u64 = 4 * 1024 * 1024;

fn start_of(period: &Period) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(&period.from).ok()
}

fn period_of(periods: &[Period], moment: &Moment) -> Option<usize> {
    let at = moment.at;
    let inside = periods
        .iter()
        .rposition(|p| start_of(p).is_some_and(|from| from <= at));
    let after = inside.map_or(0, |i| i + 1);
    let next_starts_soon = |state: &str| {
        periods.get(after).is_some_and(|next| {
            next.state == state
                && start_of(next).is_some_and(|from| (from - at).num_seconds() <= LAG_SECS)
        })
    };
    let not_working = inside.is_none_or(|i| periods[i].state != "working");
    match &moment.said {
        Said::Person(_) if not_working && next_starts_soon("working") => Some(after),
        Said::Question(_) if next_starts_soon("waiting") => Some(after),
        Said::Agent(_) | Said::Did(_) if not_working => {
            let i = inside?;
            let just_began =
                start_of(&periods[i]).is_some_and(|from| (at - from).num_seconds() <= LAG_SECS);
            if i > 0 && just_began && periods[i - 1].state == "working" {
                Some(i - 1)
            } else {
                Some(i)
            }
        }
        _ => inside,
    }
}

fn counted(n: usize, one: &str, many: &str) -> Option<String> {
    (n > 0).then(|| format!("{n} {}", if n == 1 { one } else { many }))
}

fn summary_of(steps: &[Action], files: &[String]) -> String {
    let count = |tools: &[&str]| {
        steps
            .iter()
            .filter(|a| tools.contains(&a.tool.as_str()))
            .map(|a| a.what.as_str())
            .collect::<BTreeSet<_>>()
            .len()
    };
    let known = ["Bash", "Read", "Grep", "Glob", "Task", "Agent"];
    let other = steps
        .iter()
        .filter(|a| !edits_file(&a.tool) && !known.contains(&a.tool.as_str()))
        .count();
    let commands = steps.iter().filter(|a| a.tool == "Bash").count();
    let searches = steps
        .iter()
        .filter(|a| matches!(a.tool.as_str(), "Grep" | "Glob"))
        .count();
    let phrases = [
        counted(files.len(), "file", "files").map(|n| format!("edited {n}")),
        counted(commands, "command", "commands").map(|n| format!("ran {n}")),
        counted(count(&["Read"]), "file", "files").map(|n| format!("read {n}")),
        counted(searches, "time", "times").map(|n| format!("searched {n}")),
        counted(count(&["Task", "Agent"]), "agent", "agents").map(|n| format!("started {n}")),
        counted(other, "other step", "other steps").map(|n| format!("used {n}")),
    ];
    let joined = phrases.into_iter().flatten().collect::<Vec<_>>().join(", ");
    let mut letters = joined.chars();
    letters.next().map_or(String::new(), |first| {
        first.to_uppercase().chain(letters).collect()
    })
}

pub fn parts(periods: &[Period], moments: &[Moment]) -> Parts {
    let mut before = Part::default();
    let mut out = vec![Part::default(); periods.len()];
    let mut steps: Vec<Vec<Action>> = vec![Vec::new(); periods.len() + 1];
    for moment in moments {
        let index = period_of(periods, moment);
        let part = index.map_or(&mut before, |i| &mut out[i]);
        match &moment.said {
            Said::Person(text) => part.asked.push(text.clone()),
            Said::Agent(text) => part.said = text.clone(),
            Said::Question(text) => part.question = text.clone(),
            Said::Did(action) => {
                if edits_file(&action.tool) {
                    let file = action.what.trim_start_matches("Edited ").to_string();
                    if !part.files.contains(&file) {
                        part.files.push(file);
                    }
                }
                steps[index.unwrap_or(periods.len())].push(action.clone());
            }
        }
    }
    let mut stopped = String::new();
    for (i, part) in out.iter_mut().enumerate() {
        if periods[i].state == "waiting" && part.question.is_empty() {
            part.stopped_at = std::mem::take(&mut stopped);
        }
        stopped = steps[i].last().map(|a| a.what.clone()).unwrap_or_default();
        finish(part, std::mem::take(&mut steps[i]));
    }
    finish(&mut before, std::mem::take(&mut steps[periods.len()]));
    Parts {
        before,
        periods: out,
    }
}

fn finish(part: &mut Part, mut steps: Vec<Action>) {
    part.summary = summary_of(&steps, &part.files);
    part.more = steps.len().saturating_sub(STEPS_KEPT);
    steps.drain(..part.more);
    part.did = steps;
}

pub fn scrub(work: &mut Work, saved: &[String]) {
    let clean = |text: &mut String| *text = crate::mcp_read::scrubbed(text, saved);
    clean(&mut work.title);
    clean(&mut work.first_prompt);
    clean(&mut work.screen);
    for moment in &mut work.moments {
        match &mut moment.said {
            Said::Person(text) | Said::Agent(text) | Said::Question(text) => clean(text),
            Said::Did(action) => clean(&mut action.what),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn said(role: &str, content: Value) -> String {
        json!({ "type": role, "message": { "content": content } }).to_string()
    }

    fn said_at(role: &str, at: &str, content: Value) -> String {
        json!({ "type": role, "timestamp": at, "message": { "content": content } }).to_string()
    }

    fn tool_at(at: &str, name: &str, input: Value) -> String {
        said_at(
            "assistant",
            at,
            json!([{ "type": "tool_use", "name": name, "input": input }]),
        )
    }

    fn transcript(lines: &[String]) -> String {
        format!("1000\n{}\n", lines.join("\n"))
    }

    fn period(state: &'static str, from: &str, to: Option<&str>) -> Period {
        Period {
            state,
            from: from.to_string(),
            to: to.map(str::to_string),
            seconds: 0,
        }
    }

    const T: &str = "2026-11-01T10:";

    fn at(clock: &str) -> String {
        format!("{T}{clock}.000Z")
    }

    fn three_periods() -> Vec<Period> {
        vec![
            period("working", &at("00:00"), Some(&at("10:00"))),
            period("waiting", &at("10:00"), Some(&at("20:00"))),
            period("working", &at("20:00"), None),
        ]
    }

    fn parts_of(lines: &[String], periods: &[Period]) -> Parts {
        let work = of_transcript(&transcript(lines), "/r").unwrap();
        parts(periods, &work.moments)
    }

    #[test]
    fn each_part_says_what_happened_in_it() {
        let parts = parts_of(
            &[
                said_at("user", &at("00:10"), json!("Fix the login bug")),
                tool_at(
                    &at("01:00"),
                    "Read",
                    json!({ "file_path": "/r/src/login.rs" }),
                ),
                tool_at(
                    &at("02:00"),
                    "Edit",
                    json!({ "file_path": "/r/src/login.rs" }),
                ),
                tool_at(
                    &at("03:00"),
                    "Bash",
                    json!({ "command": "cargo test", "description": "Run the tests" }),
                ),
                said_at(
                    "assistant",
                    &at("04:00"),
                    json!([{ "type": "text", "text": "## Done\nThe **tests** pass with `cargo test`." }]),
                ),
                said_at("user", &at("21:00"), json!("Now add a test")),
                tool_at(
                    &at("22:00"),
                    "Edit",
                    json!({ "file_path": "/r/src/lock.rs" }),
                ),
            ],
            &three_periods(),
        );
        let first = &parts.periods[0];
        assert_eq!(first.asked, ["Fix the login bug"]);
        assert_eq!(first.summary, "Edited 1 file, ran 1 command, read 1 file");
        assert_eq!(first.files, ["src/login.rs"]);
        assert_eq!(first.said, "Done\nThe tests pass with cargo test.");
        let steps: Vec<&str> = first.did.iter().map(|a| a.what.as_str()).collect();
        assert_eq!(
            steps,
            ["Read src/login.rs", "Edited src/login.rs", "Run the tests"]
        );
        assert_eq!(parts.periods[2].asked, ["Now add a test"]);
        assert_eq!(parts.periods[2].files, ["src/lock.rs"]);
        assert!(parts.before.is_empty());
    }

    #[test]
    fn a_prompt_typed_just_before_the_agent_starts_belongs_to_that_work() {
        let parts = parts_of(
            &[said_at("user", &at("19:30"), json!("Carry on"))],
            &three_periods(),
        );
        assert!(parts.periods[1].asked.is_empty());
        assert_eq!(parts.periods[2].asked, ["Carry on"]);
    }

    #[test]
    fn a_prompt_long_before_the_next_work_stays_where_it_was_typed() {
        let parts = parts_of(
            &[said_at("user", &at("15:00"), json!("Are you there?"))],
            &three_periods(),
        );
        assert_eq!(parts.periods[1].asked, ["Are you there?"]);
    }

    #[test]
    fn a_wait_says_what_the_agent_asked() {
        let parts = parts_of(
            &[tool_at(
                &at("09:30"),
                "AskUserQuestion",
                json!({ "questions": [{ "question": "Which **database**?", "options": [] }] }),
            )],
            &three_periods(),
        );
        assert_eq!(parts.periods[1].question, "Which database?");
        assert!(parts.periods[0].did.is_empty(), "a question is not a step");
    }

    #[test]
    fn a_wait_with_no_question_says_what_it_stopped_at() {
        let parts = parts_of(
            &[tool_at(
                &at("09:30"),
                "Bash",
                json!({ "command": "rm -rf build", "description": "Clear the build" }),
            )],
            &three_periods(),
        );
        assert_eq!(parts.periods[1].stopped_at, "Clear the build");
    }

    #[test]
    fn work_noticed_late_stays_with_the_work_before_it() {
        let parts = parts_of(
            &[said_at(
                "assistant",
                &at("10:20"),
                json!([{ "type": "text", "text": "All done." }]),
            )],
            &three_periods(),
        );
        assert_eq!(parts.periods[0].said, "All done.");
        assert!(parts.periods[1].is_empty());
    }

    #[test]
    fn work_from_before_yardbell_watched_is_kept_apart() {
        let parts = parts_of(
            &[said_at("user", "2026-11-01T08:00:00.000Z", json!("Start"))],
            &three_periods(),
        );
        assert_eq!(parts.before.asked, ["Start"]);
        assert!(parts.periods[0].is_empty());
    }

    #[test]
    fn a_part_keeps_its_newest_steps_and_counts_them_all() {
        let lines: Vec<String> = (0..STEPS_KEPT + 5)
            .map(|n| {
                tool_at(
                    &at("01:00"),
                    "Read",
                    json!({ "file_path": format!("/r/{n}.rs") }),
                )
            })
            .collect();
        let parts = parts_of(&lines, &three_periods());
        let first = &parts.periods[0];
        assert_eq!(first.did.len(), STEPS_KEPT);
        assert_eq!(first.more, 5);
        assert_eq!(first.summary, format!("Read {} files", STEPS_KEPT + 5));
    }

    #[test]
    fn a_line_read_twice_counts_once() {
        let line = json!({ "type": "user", "uuid": "a1", "timestamp": at("00:10"), "message": { "content": "Once" } }).to_string();
        let parts = parts_of(&[line.clone(), line], &three_periods());
        assert_eq!(parts.periods[0].asked, ["Once"]);
    }

    #[test]
    fn steps_read_the_way_a_person_would_say_them() {
        let what = |name: &str, input: Value| action_of(name, &input, "/r").map(|a| a.what);
        assert_eq!(
            what("Skill", json!({ "skill": "superpowers:brainstorming" })).unwrap(),
            "Used the superpowers:brainstorming skill"
        );
        assert_eq!(
            what("mcp__linear__get_issue", json!({})).unwrap(),
            "Used get_issue in linear"
        );
        assert_eq!(
            what("Edit", json!({ "file_path": "/Users/me/.claude/notes.md" })).unwrap(),
            "Edited ~/.claude/notes.md"
        );
        assert_eq!(
            what("Read", json!({ "file_path": "/home/me/other/a.rs" })).unwrap(),
            "Read ~/other/a.rs"
        );
        for quiet in [
            "TodoWrite",
            "TaskCreate",
            "TaskUpdate",
            "ToolSearch",
            "Monitor",
        ] {
            assert_eq!(what(quiet, json!({})), None, "{quiet}");
        }
    }

    #[test]
    fn it_finds_the_title_and_first_prompt() {
        let text = transcript(&[
            json!({ "type": "ai-title", "aiTitle": "Fix the login" }).to_string(),
            said("user", json!("Fix the login bug")),
            said(
                "user",
                json!([{ "type": "tool_result", "content": "secret file body" }]),
            ),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert_eq!(work.title, "Fix the login");
        assert_eq!(work.first_prompt, "Fix the login bug");
        let parts = parts(&three_periods(), &work.moments);
        assert!(!format!("{parts:?}").contains("secret file body"));
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
    }

    #[test]
    fn a_sidechain_is_not_this_session() {
        let text = transcript(&[
            said("user", json!("Mine")),
            json!({ "type": "assistant", "isSidechain": true, "timestamp": at("01:00"), "message": { "content": [
                { "type": "tool_use", "name": "Edit", "input": { "file_path": "/r/other.rs" } },
                { "type": "text", "text": "from a helper" },
            ] } })
            .to_string(),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert!(parts(&three_periods(), &work.moments).periods[0].is_empty());
    }

    #[test]
    fn long_and_broken_text_is_handled() {
        let long = "x".repeat(5000);
        let text = transcript(&[
            "{ cut off by the read".to_string(),
            "not json".to_string(),
            said("user", json!(long)),
            tool_at(&at("01:00"), "Bash", json!({ "command": "y".repeat(500) })),
            tool_at("not a time", "Bash", json!({ "command": "lost" })),
        ]);
        let work = of_transcript(&text, "/r").unwrap();
        assert_eq!(work.first_prompt.chars().count(), TEXT_MAX + 3);
        let parts = parts(&three_periods(), &work.moments);
        assert!(parts.periods[0].did[0].what.chars().count() <= ACTION_MAX + 3);
        assert_eq!(parts.periods[0].did.len(), 1);
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
            said_at("user", &at("00:10"), json!("Use shh-secret-1 please")),
            tool_at(
                &at("01:00"),
                "Bash",
                json!({ "command": "curl -H shh-secret-1 x" }),
            ),
            said_at(
                "assistant",
                &at("02:00"),
                json!([{ "type": "text", "text": "Sent shh-secret-1." }]),
            ),
        ]);
        let mut work = of_transcript(&text, "/r").unwrap();
        scrub(&mut work, &["shh-secret-1".to_string()]);
        assert!(!serde_json::to_string(&work)
            .unwrap()
            .contains("shh-secret-1"));
        let parts = parts(&three_periods(), &work.moments);
        assert!(!format!("{parts:?}").contains("shh-secret-1"));
    }
}
