// Ported from herdr's src/detect/manifest.rs (Apache-2.0), see manifests/README.md. Rules come
// unchanged from herdr so they can be refreshed by copying files; only the parts Yardbell can
// feed are kept. tmux has no OSC progress, so that region is always empty.

use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenState {
    Working,
    Blocked,
    Idle,
}

const MANIFESTS: &[&str] = &[
    include_str!("manifests/amp.toml"),
    include_str!("manifests/antigravity.toml"),
    include_str!("manifests/claude.toml"),
    include_str!("manifests/cline.toml"),
    include_str!("manifests/codex.toml"),
    include_str!("manifests/cursor.toml"),
    include_str!("manifests/devin.toml"),
    include_str!("manifests/droid.toml"),
    include_str!("manifests/gemini.toml"),
    include_str!("manifests/grok.toml"),
    include_str!("manifests/hermes.toml"),
    include_str!("manifests/kilo.toml"),
    include_str!("manifests/kimi.toml"),
    include_str!("manifests/kiro.toml"),
    include_str!("manifests/letta.toml"),
    include_str!("manifests/maki.toml"),
    include_str!("manifests/muse.toml"),
    include_str!("manifests/opencode.toml"),
    include_str!("manifests/pi.toml"),
    include_str!("manifests/qodercli.toml"),
    include_str!("manifests/qwen.toml"),
    include_str!("manifests/github-copilot.toml"),
];

#[derive(Deserialize)]
struct RawManifest {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    rules: Vec<RawRule>,
}

#[derive(Deserialize)]
struct RawRule {
    id: String,
    state: Option<String>,
    #[serde(default)]
    priority: i32,
    #[serde(default = "whole_recent")]
    region: String,
    #[serde(default)]
    skip_state_update: bool,
    #[serde(flatten)]
    gate: RawGate,
}

#[derive(Deserialize, Default)]
struct RawGate {
    #[serde(default)]
    all: Vec<RawGate>,
    #[serde(default)]
    any: Vec<RawGate>,
    #[serde(default, rename = "not")]
    not_gate: Vec<RawGate>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

fn whole_recent() -> String {
    "whole_recent".into()
}

struct Manifest {
    names: Vec<String>,
    rules: Vec<Rule>,
}

struct Rule {
    priority: i32,
    region: String,
    state: Option<ScreenState>,
    gate: Gate,
}

struct Gate {
    all: Vec<Gate>,
    any: Vec<Gate>,
    not_gate: Vec<Gate>,
    contains: Vec<String>,
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
}

fn compile_gate(raw: &RawGate) -> Result<Gate, regex::Error> {
    let gates = |list: &[RawGate]| list.iter().map(compile_gate).collect::<Result<_, _>>();
    let regexes = |list: &[String]| list.iter().map(|p| Regex::new(p)).collect::<Result<_, _>>();
    Ok(Gate {
        all: gates(&raw.all)?,
        any: gates(&raw.any)?,
        not_gate: gates(&raw.not_gate)?,
        contains: raw.contains.iter().map(|c| c.to_lowercase()).collect(),
        regex: regexes(&raw.regex)?,
        line_regex: regexes(&raw.line_regex)?,
    })
}

fn parse(text: &str) -> Result<Manifest, String> {
    let raw: RawManifest = toml::from_str(text).map_err(|e| e.to_string())?;
    let rules = raw
        .rules
        .iter()
        .map(|r| {
            let state = match (r.skip_state_update, r.state.as_deref()) {
                (true, _) => None,
                (_, Some("working")) => Some(ScreenState::Working),
                (_, Some("blocked")) => Some(ScreenState::Blocked),
                (_, Some("idle")) => Some(ScreenState::Idle),
                _ => None,
            };
            let gate =
                compile_gate(&r.gate).map_err(|e| format!("{}: rule {}: {e}", raw.id, r.id))?;
            Ok(Rule {
                priority: r.priority,
                region: r.region.trim().to_string(),
                state,
                gate,
            })
        })
        .collect::<Result<_, String>>()?;
    let mut names = vec![raw.id];
    names.extend(raw.aliases);
    Ok(Manifest { names, rules })
}

fn manifests() -> &'static [Manifest] {
    static ALL: OnceLock<Vec<Manifest>> = OnceLock::new();
    ALL.get_or_init(|| {
        MANIFESTS
            .iter()
            .filter_map(|text| {
                parse(text)
                    .map_err(|e| tracing::warn!(error = %e, "skipped agent screen rules"))
                    .ok()
            })
            .collect()
    })
}

pub fn knows(agent: &str) -> bool {
    manifests()
        .iter()
        .any(|m| m.names.iter().any(|n| n == agent))
}

/// None means the screen says nothing either way (no rules for this agent, or a rule such as an
/// open transcript viewer that hides the agent's state), so the caller keeps its own estimate.
pub fn detect(agent: &str, screen: &str, title: &str) -> Option<ScreenState> {
    let manifest = manifests()
        .iter()
        .find(|m| m.names.iter().any(|n| n == agent))?;
    let mut best: Option<&Rule> = None;
    for rule in &manifest.rules {
        if best.is_some_and(|b| b.priority >= rule.priority) {
            continue;
        }
        let text = region(screen, title, &rule.region);
        if gate_matches(&rule.gate, text, &text.to_lowercase()) {
            best = Some(rule);
        }
    }
    match best {
        Some(rule) => rule.state,
        None => Some(ScreenState::Idle),
    }
}

fn gate_matches(gate: &Gate, text: &str, lower: &str) -> bool {
    gate.contains.iter().all(|needle| lower.contains(needle))
        && gate.regex.iter().all(|re| re.is_match(text))
        && gate
            .line_regex
            .iter()
            .all(|re| text.lines().any(|line| re.is_match(line)))
        && gate.all.iter().all(|g| gate_matches(g, text, lower))
        && (gate.any.is_empty() || gate.any.iter().any(|g| gate_matches(g, text, lower)))
        && !gate.not_gate.iter().any(|g| gate_matches(g, text, lower))
}

fn region<'a>(screen: &'a str, title: &'a str, spec: &str) -> &'a str {
    match spec {
        "osc_title" => title,
        "osc_progress" => "",
        "whole_recent" => screen,
        "after_last_prompt_marker" => after_last_prompt_marker(screen),
        "before_current_prompt_marker" => before_current_prompt_marker(screen),
        "whole_recent_without_current_prompt_marker" => {
            let lines: Vec<&str> = screen.lines().collect();
            if current_prompt_index(&lines).is_some() {
                ""
            } else {
                screen
            }
        }
        "current_prompt_block_marker" => current_prompt_block_marker(screen).unwrap_or(""),
        "after_current_prompt_block_marker" => {
            after_current_prompt_block_marker(screen).unwrap_or("")
        }
        "prompt_box_body" => prompt_box_body(screen).unwrap_or(""),
        "above_prompt_box" => above_prompt_box(screen),
        "last_non_empty_above_prompt_box" => last_non_empty_line(above_prompt_box(screen)),
        "after_last_horizontal_rule" => after_last_horizontal_rule(screen),
        _ => {
            if let Some(n) = count(spec, "bottom_lines") {
                let lines: Vec<&str> = screen.lines().collect();
                return from_line(screen, &lines, lines.len().saturating_sub(n));
            }
            if let Some(n) = count(spec, "bottom_non_empty_lines") {
                return bottom_non_empty_lines(screen, n);
            }
            if let Some(n) = count(spec, "top_non_empty_lines") {
                return top_non_empty_lines(screen, n);
            }
            ""
        }
    }
}

fn count(spec: &str, name: &str) -> Option<usize> {
    spec.strip_prefix(name)?
        .strip_prefix('(')?
        .strip_suffix(')')?
        .parse()
        .ok()
}

fn line_start(content: &str, lines: &[&str], index: usize) -> usize {
    lines[..index.min(lines.len())]
        .iter()
        .map(|l| l.len() + 1)
        .sum::<usize>()
        .min(content.len())
}

fn from_line<'a>(content: &'a str, lines: &[&str], index: usize) -> &'a str {
    &content[line_start(content, lines, index)..]
}

fn bottom_non_empty_lines(content: &str, n: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let start = lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, l)| !l.trim().is_empty())
        .take(n)
        .last()
        .map(|(i, _)| i);
    start.map_or("", |i| from_line(content, &lines, i))
}

fn top_non_empty_lines(content: &str, n: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let end = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .take(n)
        .last()
        .map(|(i, _)| i);
    end.map_or("", |i| &content[..line_start(content, &lines, i + 1)])
}

fn prompt_line(line: &str) -> bool {
    line == "›" || line.starts_with("› ")
}

fn block_marker_line(line: &str) -> bool {
    line.starts_with(['•', '■', '✗', '✓'])
}

fn current_prompt_index(lines: &[&str]) -> Option<usize> {
    let i = lines.iter().rposition(|l| prompt_line(l))?;
    (!lines[i + 1..].iter().any(|l| block_marker_line(l))).then_some(i)
}

fn after_last_prompt_marker(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match lines.iter().rposition(|l| prompt_line(l)) {
        Some(i) => from_line(content, &lines, i + 1),
        None => content,
    }
}

fn before_current_prompt_marker(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match current_prompt_index(&lines) {
        Some(i) => &content[..line_start(content, &lines, i)],
        None => content,
    }
}

fn current_prompt_block_marker(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let prompt = current_prompt_index(&lines)?;
    lines[..prompt]
        .iter()
        .rev()
        .find(|l| block_marker_line(l))
        .copied()
}

fn after_current_prompt_block_marker(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let prompt = current_prompt_index(&lines)?;
    let block = lines[..prompt].iter().rposition(|l| block_marker_line(l))?;
    Some(from_line(content, &lines, block))
}

fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    let dashes = trimmed.chars().take_while(|&c| c == '─').count();
    if dashes == 0 {
        return false;
    }
    let rest = trimmed[dashes * '─'.len_utf8()..].trim_start();
    rest.is_empty() || dashes >= 3
}

fn prompt_box_top(lines: &[&str]) -> Option<usize> {
    (0..lines.len())
        .rev()
        .filter(|&i| is_horizontal_rule(lines[i]))
        .nth(1)
}

fn prompt_box_body(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let top = prompt_box_top(&lines)?;
    let end = lines[top + 1..]
        .iter()
        .position(|l| is_horizontal_rule(l))
        .map_or(lines.len(), |r| top + 1 + r);
    Some(&content[line_start(content, &lines, top + 1)..line_start(content, &lines, end)])
}

fn above_prompt_box(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match prompt_box_top(&lines) {
        Some(top) => &content[..line_start(content, &lines, top)],
        None => content,
    }
}

fn after_last_horizontal_rule(content: &str) -> &str {
    let mut start = 0;
    let mut offset = 0;
    for line in content.lines() {
        offset += line.len() + 1;
        if is_horizontal_rule(line) {
            start = offset.min(content.len());
        }
    }
    &content[start..]
}

fn last_non_empty_line(content: &str) -> &str {
    content
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
}

#[cfg(test)]
mod tests;
