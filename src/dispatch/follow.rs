use crate::snapshot::Activity;
use crate::state::StateView;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SCREEN_LINES: usize = 14;
const OPTION_LINES: usize = 25;

// A session Dispatch started, and the state it was last seen in, so a change can be reported in
// the conversation that started it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tracked {
    pub machine: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub last: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub conversation: String,
    pub machine: String,
    pub name: String,
    pub path: String,
    pub state: &'static str,
}

pub fn started(result: &str) -> Option<Tracked> {
    let v: Value = serde_json::from_str(result).ok()?;
    Some(Tracked {
        machine: v["machine"].as_str()?.to_string(),
        name: v["name"].as_str()?.to_string(),
        path: v["path"].as_str().unwrap_or_default().to_string(),
        last: String::new(),
    })
}

fn state_now(t: &Tracked, view: &StateView) -> Option<&'static str> {
    let session = view
        .sessions
        .iter()
        .find(|s| !s.stale && s.machine == t.machine && s.tmux.as_deref() == Some(t.name.as_str()));
    if let Some(s) = session {
        return Some(match s.activity {
            Activity::Blocked => "blocked",
            Activity::Active => "working",
            Activity::Idle => "idle",
        });
    }
    let up = view.machines.iter().any(|m| m.name == t.machine && m.up);
    up.then_some("ended")
}

// A session is worth a message when it starts waiting for an answer, goes quiet after working
// (it finished, or wants the next instruction), or ends. The first sighting only sets the state,
// except a session that is already waiting.
pub fn changes(conversation: &str, tracked: &mut [Tracked], view: &StateView) -> Vec<Change> {
    let mut out = Vec::new();
    for t in tracked.iter_mut() {
        if t.last == "ended" {
            continue;
        }
        let Some(now) = state_now(t, view) else {
            continue;
        };
        let report = match now {
            "blocked" => t.last != "blocked",
            "idle" => t.last == "working" || t.last == "blocked",
            "ended" => !t.last.is_empty(),
            _ => false,
        };
        if report {
            out.push(Change {
                conversation: conversation.to_string(),
                machine: t.machine.clone(),
                name: t.name.clone(),
                path: t.path.clone(),
                state: now,
            });
        }
        t.last = now.to_string();
    }
    out
}

pub fn tail(screen: &str, lines: usize) -> String {
    let kept: Vec<&str> = screen
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    kept[kept.len().saturating_sub(lines)..].join("\n")
}

// The numbered choices an agent shows when it asks for permission, such as "❯ 1. Yes".
pub fn options(screen: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = screen.lines().collect();
    let recent = &lines[lines.len().saturating_sub(OPTION_LINES)..];
    let mut found: Vec<(String, String)> = Vec::new();
    for line in recent {
        let text = line.trim().trim_start_matches(['❯', '>', '›']).trim();
        let Some((key, label)) = text.split_once(". ") else {
            continue;
        };
        if key.len() == 1 && key.chars().all(|c| c.is_ascii_digit()) && !label.trim().is_empty() {
            found.retain(|(k, _)| k != key);
            found.push((key.to_string(), label.trim().to_string()));
        }
    }
    found.sort();
    found
}

pub fn event(change: &Change, screen: &str) -> Value {
    let options: Vec<Value> = if change.state == "blocked" {
        options(screen)
            .into_iter()
            .map(|(key, label)| json!({ "key": key, "label": label }))
            .collect()
    } else {
        Vec::new()
    };
    json!({
        "role": "session",
        "machine": change.machine,
        "name": change.name,
        "path": change.path,
        "state": change.state,
        "screen": tail(screen, SCREEN_LINES),
        "options": options,
        "at": chrono::Local::now().to_rfc3339(),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedTask {
    pub name: String,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostTerminal;
    use crate::state::{MachineView, SessionView};

    fn view(sessions: Vec<(&str, Activity)>, up: bool) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: vec![MachineView {
                name: "hp".into(),
                up,
                reason: None,
                last_seen: None,
                local: true,
                health: None,
                mesh_on: None,
            }],
            folders: vec![],
            sessions: sessions
                .into_iter()
                .map(|(name, activity)| SessionView {
                    id: name.into(),
                    machine: "hp".into(),
                    agent: "claude".into(),
                    pid: 1,
                    folder: "app".into(),
                    ticket: "-".into(),
                    branch: "main".into(),
                    activity,
                    attachable: true,
                    tmux: Some(name.into()),
                    stale: false,
                    ports: vec![],
                })
                .collect(),
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
            server: None,
        }
    }

    fn tracked() -> Vec<Tracked> {
        vec![Tracked {
            machine: "hp".into(),
            name: "hp-app".into(),
            path: "/r/app".into(),
            last: String::new(),
        }]
    }

    fn states(list: &[Change]) -> Vec<&str> {
        list.iter().map(|c| c.state).collect()
    }

    #[test]
    fn a_start_result_is_tracked() {
        let t = started(r#"{"machine":"hp","name":"hp-app","path":"/r/app"}"#).unwrap();
        assert_eq!(
            (t.machine.as_str(), t.name.as_str(), t.path.as_str()),
            ("hp", "hp-app", "/r/app")
        );
        assert_eq!(started("not json"), None);
        assert_eq!(started(r#"{"error":"x"}"#), None);
    }

    #[test]
    fn finishing_waiting_and_ending_are_reported_once() {
        let mut t = tracked();
        assert!(changes("c", &mut t, &view(vec![("hp-app", Activity::Active)], true)).is_empty());
        assert!(changes("c", &mut t, &view(vec![("hp-app", Activity::Active)], true)).is_empty());
        assert_eq!(
            states(&changes(
                "c",
                &mut t,
                &view(vec![("hp-app", Activity::Blocked)], true)
            )),
            ["blocked"]
        );
        assert!(changes(
            "c",
            &mut t,
            &view(vec![("hp-app", Activity::Blocked)], true)
        )
        .is_empty());
        assert_eq!(
            states(&changes(
                "c",
                &mut t,
                &view(vec![("hp-app", Activity::Idle)], true)
            )),
            ["idle"]
        );
        assert!(changes("c", &mut t, &view(vec![("hp-app", Activity::Idle)], true)).is_empty());
        assert!(
            changes("c", &mut t, &view(vec![], false)).is_empty(),
            "a machine that is down says nothing"
        );
        assert_eq!(
            states(&changes("c", &mut t, &view(vec![], true))),
            ["ended"]
        );
        assert!(changes("c", &mut t, &view(vec![], true)).is_empty());
    }

    #[test]
    fn a_session_already_waiting_is_reported_at_first_sight() {
        let mut t = tracked();
        assert_eq!(
            states(&changes(
                "c",
                &mut t,
                &view(vec![("hp-app", Activity::Blocked)], true)
            )),
            ["blocked"]
        );
        let mut quiet = tracked();
        assert!(changes(
            "c",
            &mut quiet,
            &view(vec![("hp-app", Activity::Idle)], true)
        )
        .is_empty());
    }

    #[test]
    fn permission_choices_are_read_from_the_screen() {
        let screen = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm\n   3. No, and tell Claude what to do differently (esc)\n\n Esc to cancel";
        assert_eq!(
            options(screen),
            [
                ("1".to_string(), "Yes".to_string()),
                (
                    "2".to_string(),
                    "Yes, and don't ask again for rm".to_string()
                ),
                (
                    "3".to_string(),
                    "No, and tell Claude what to do differently (esc)".to_string()
                ),
            ]
        );
        assert!(options("1. step one in a plan\nsome text").len() == 1);
        assert!(options("nothing to pick").is_empty());
    }

    #[test]
    fn the_tail_keeps_the_last_lines_with_text() {
        assert_eq!(tail("a\n\nb\nc\n\n", 2), "b\nc");
    }
}
