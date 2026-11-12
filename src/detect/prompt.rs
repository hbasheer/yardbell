// Yardbell's own, like stopped.rs: the choices a waiting agent offers, read from the bottom of its
// screen so a phone can answer with one tap. Anything not recognised is left as None, and the
// phone then offers only the keys that are safe in every state.

use serde::Serialize;

const RECENT_LINES: usize = 25;
const ESC: &str = "\x1b";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptKind {
    Permission,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Yes,
    Always,
    No,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Choice {
    pub number: u8,
    pub label: String,
    // What to type to pick it, exactly as the agent reads it.
    pub keys: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Prompt {
    pub kind: PromptKind,
    pub choices: Vec<Choice>,
}

#[derive(Clone, Copy, PartialEq)]
enum Agent {
    Claude,
    Codex,
}

fn agent_of(name: &str) -> Option<Agent> {
    match name {
        "claude" | "claude-code" => Some(Agent::Claude),
        "codex" => Some(Agent::Codex),
        _ => None,
    }
}

pub fn prompt(agent: &str, screen: &str) -> Option<Prompt> {
    let agent = agent_of(agent)?;
    let found = numbered(screen);
    if found.len() < 2 {
        return None;
    }
    let roles: Vec<Option<Role>> = found.iter().map(|(_, label)| role(label)).collect();
    let permission = roles.iter().filter(|r| **r == Some(Role::Yes)).count() == 1
        && roles.iter().filter(|r| **r == Some(Role::No)).count() == 1
        && roles.iter().filter(|r| **r == Some(Role::Always)).count() <= 1
        && roles.iter().all(Option::is_some);
    // Codex picks by the letter it prints after each choice; a question of its own has none.
    if agent == Agent::Codex && !permission {
        return None;
    }
    let mut choices = Vec::new();
    for ((number, label), role) in found.into_iter().zip(roles) {
        let keys = match agent {
            Agent::Claude => number.to_string(),
            Agent::Codex => hotkey(&label)?,
        };
        choices.push(Choice {
            number,
            label,
            keys,
            role: if permission { role } else { None },
        });
    }
    let kind = if permission {
        PromptKind::Permission
    } else {
        PromptKind::Question
    };
    Some(Prompt { kind, choices })
}

fn role(label: &str) -> Option<Role> {
    let lower = label.to_lowercase();
    if lower == "no" || lower.starts_with("no,") || lower.starts_with("no ") {
        return Some(Role::No);
    }
    if lower != "yes" && !lower.starts_with("yes,") && !lower.starts_with("yes ") {
        return None;
    }
    let always = ["don't ask again", "don’t ask again", "allow all", "always"]
        .iter()
        .any(|w| lower.contains(w));
    Some(if always { Role::Always } else { Role::Yes })
}

// "Yes, proceed (y)" is picked with y, and "(esc)" with Esc.
fn hotkey(label: &str) -> Option<String> {
    let inner = label.trim_end().strip_suffix(')')?;
    let key = &inner[inner.rfind('(')? + 1..];
    match key {
        "esc" => Some(ESC.into()),
        k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => Some(k.into()),
        _ => None,
    }
}

// The last run of choices numbered from 1 up, read upwards from the bottom, so a numbered list
// earlier in the agent's reply is not taken for the question below it.
fn numbered(screen: &str) -> Vec<(u8, String)> {
    // A tall pane pads the screen with empty rows below the prompt.
    let lines: Vec<&str> = screen.trim_end().lines().collect();
    let recent = &lines[lines.len().saturating_sub(RECENT_LINES)..];
    let mut found: Vec<(u8, String)> = Vec::new();
    for line in recent.iter().rev() {
        let Some((number, label)) = choice_line(line) else {
            continue;
        };
        let expected = found.last().and_then(|(n, _)| n.checked_sub(1));
        if expected.is_some_and(|e| e != number) {
            found.clear();
        }
        found.push((number, label));
        if number == 1 {
            break;
        }
    }
    found.reverse();
    let counted = found
        .iter()
        .enumerate()
        .all(|(i, (n, _))| *n as usize == i + 1);
    if counted {
        found
    } else {
        Vec::new()
    }
}

fn choice_line(line: &str) -> Option<(u8, String)> {
    let text = line
        .trim()
        .trim_start_matches('│')
        .trim_start()
        .trim_start_matches(['❯', '>', '›'])
        .trim();
    let (key, label) = text.split_once(". ")?;
    if key.len() != 1 || !key.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let number: u8 = key.parse().ok()?;
    let label = beside_box(label);
    (number > 0 && !label.is_empty()).then(|| (number, label.to_string()))
}

// A preview box, or the agent's own frame, can share the line to the right of a choice.
fn beside_box(label: &str) -> &str {
    let gap = label.find("   ").unwrap_or(label.len());
    let label = &label[..gap];
    let border = label
        .find(|c| ('\u{2500}'..='\u{257f}').contains(&c))
        .unwrap_or(label.len());
    label[..border].trim()
}
