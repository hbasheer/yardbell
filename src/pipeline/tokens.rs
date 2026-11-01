use super::definition::{Definition, Step, StepKind};
use super::record::{Run, Seen};
use super::run::World;
use crate::config::Pipelines as Cfg;
use crate::state::StateView;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const LIMIT_MIN: u64 = 1_000;
pub const LIMIT_MAX: u64 = 1_000_000_000_000;
const READ_EVERY_SECONDS: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

impl Tokens {
    // Cache reads are left out: every turn of a long session reads the whole conversation again,
    // so they would swamp the work done and make a limit say little.
    pub fn counted(&self) -> u64 {
        self.input + self.output + self.cache_write
    }

    pub fn add(&mut self, other: Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_write += other.cache_write;
        self.cache_read += other.cache_read;
    }

    fn keep_largest(&mut self, other: Tokens) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_write = self.cache_write.max(other.cache_write);
        self.cache_read = self.cache_read.max(other.cache_read);
    }
}

// What one run has used. Each transcript or Dispatch conversation has its own entry, read whole
// each time, so a restart or a session shared by several steps counts it once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TokenUse {
    pub sources: BTreeMap<String, Tokens>,
    // Steps whose use is not in the total, and why.
    pub unknown: BTreeMap<String, String>,
    pub limit: Option<u64>,
    pub raised: bool,
    pub go_on_unknown: bool,
    pub told: bool,
    pub read_at: String,
}

impl TokenUse {
    pub fn used(&self) -> u64 {
        self.sources.values().map(Tokens::counted).sum()
    }

    pub fn cache_read(&self) -> u64 {
        self.sources.values().map(|t| t.cache_read).sum()
    }

    pub fn passed(&self) -> bool {
        self.limit.is_some_and(|limit| self.used() >= limit)
    }

    pub fn note(&mut self, found: Vec<(String, Tokens)>, known: Vec<String>) {
        for (source, tokens) in found {
            self.unknown.remove(&moved_key(&source));
            self.sources.entry(source).or_default().keep_largest(tokens);
        }
        for step in known {
            self.unknown.remove(&step);
        }
    }
}

pub fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

// Whether a run past its limit must ask before this step starts. No wildcard: a new step kind has
// to say which side it is on.
pub fn uses_tokens(kind: &StepKind) -> bool {
    match kind {
        StepKind::Agent { .. } | StepKind::Plan { .. } | StepKind::Report => true,
        StepKind::Push
        | StepKind::Update { .. }
        | StepKind::Call { .. }
        | StepKind::Tool { .. }
        | StepKind::Command { .. }
        | StepKind::Checks { .. }
        | StepKind::Wait { .. } => false,
    }
}

pub fn valid_limit(limit: u64) -> bool {
    limit == 0 || (LIMIT_MIN..=LIMIT_MAX).contains(&limit)
}

pub fn limit_for(def: &Definition, cfg: &Cfg) -> Option<u64> {
    Some(def.token_limit.unwrap_or(cfg.token_limit)).filter(|limit| *limit > 0)
}

pub fn over_limit(used: u64, limit: u64) -> String {
    format!(
        "This run used {} tokens, and its limit is {}",
        group(used),
        group(limit)
    )
}

pub fn cannot_check(why: &str, limit: u64) -> String {
    format!(
        "{why}, so the limit of {} tokens cannot be checked",
        group(limit)
    )
}

pub fn blind_why(step: &Step, agent: &str) -> String {
    let who = if agent.is_empty() {
        "your default agent"
    } else {
        agent
    };
    format!("{} runs on {who}, which does not report tokens", step.name)
}

pub fn due(run: &Run, now: DateTime<Local>) -> bool {
    DateTime::parse_from_rfc3339(&run.tokens.read_at).map_or(true, |at| {
        (now - at.with_timezone(&Local)).num_seconds() >= READ_EVERY_SECONDS
    })
}

// Every marker this run has given an agent. A transcript holding one of them is this run's, even
// when another session worked in the same folder.
fn markers(run: &Run) -> Vec<String> {
    let def = run.def();
    run.steps
        .iter()
        .filter(|(id, _)| matches!(def.step(id).map(|s| &s.kind), Some(StepKind::Agent { .. })))
        .flat_map(|(id, st)| (1..=st.runs).map(move |n| format!("{id}-{n}-{}", run.tag())))
        .collect()
}

type Place<'a> = (Vec<&'a str>, Vec<u32>);

const MOVED_WHY: &str =
    "A session of this run moved to a new transcript, as /clear does, and what it used there is not counted";

fn moved_key(source: &str) -> String {
    format!("moved:{source}")
}

fn source_of(machine: &str, file: &str) -> String {
    format!("{machine}:{file}")
}

// Claude Code's transcripts for every folder a live session of this run works in. When a step has
// just ended its folder is read even if the session has gone, and finding nothing is said aloud
// rather than counted as nothing used.
pub async fn read(world: &dyn World, run: &Run, view: &StateView, ending: bool) -> Option<Seen> {
    let def = run.def();
    let mut places: BTreeMap<(&str, &str), Place> = BTreeMap::new();
    for (id, st) in &run.steps {
        let Some(StepKind::Agent { agent, .. }) = def.step(id).map(|s| &s.kind) else {
            continue;
        };
        if st.session.is_empty() || st.path.is_empty() || !world.reports_tokens(agent) {
            continue;
        }
        let live = view
            .sessions
            .iter()
            .find(|s| s.tmux.as_deref() == Some(st.session.as_str()));
        if live.is_some() || (ending && *id == run.step) {
            let place = places
                .entry((st.machine.as_str(), st.path.as_str()))
                .or_default();
            place.0.push(id);
            place.1.extend(live.map(|s| s.pid).filter(|p| *p > 0));
        }
    }
    if places.is_empty() && !ending {
        return None;
    }
    let markers = markers(run);
    let mut found = Vec::new();
    let mut known = Vec::new();
    let mut unknown = Vec::new();
    for ((machine, path), (steps, mut pids)) in places {
        pids.sort_unstable();
        pids.dedup();
        let up = view.machines.iter().any(|m| m.name == machine && m.up);
        let read = match up {
            true => world.token_use(machine, path, &markers, &pids).await,
            false => None,
        };
        let (files, moved) = read.map_or((Vec::new(), Vec::new()), |r| (r.files, r.moved));
        unknown.extend(
            moved
                .iter()
                .map(|file| (moved_key(&source_of(machine, file)), MOVED_WHY.to_string())),
        );
        match Some(files).filter(|list| !list.is_empty()) {
            Some(list) => {
                found.extend(
                    list.into_iter()
                        .map(|(file, tokens)| (source_of(machine, &file), tokens)),
                );
                known.extend(steps.into_iter().map(str::to_string));
            }
            None if ending => unknown.extend(
                steps
                    .into_iter()
                    .filter(|id| *id == run.step)
                    .map(|id| (id.to_string(), unread_why(run, id, machine))),
            ),
            None => {}
        }
    }
    Some(Seen::TokensRead {
        found,
        known,
        unknown,
        ending,
    })
}

fn unread_why(run: &Run, id: &str, machine: &str) -> String {
    let name = run.def().step(id).map_or(id, |s| s.name.as_str());
    format!("Yardbell could not read what {name} used from its transcript on {machine}")
}

// What a Dispatch turn added to the run's conversation. A turn that reported nothing, because it
// failed or was stopped, is unknown rather than free.
pub fn after_turn(world: &dyn World, run: &Run, step: &str, before: Option<Tokens>) -> Seen {
    let now = world.dispatch_tokens(&run.conversation);
    let source = format!("dispatch:{}", run.conversation);
    let found: Vec<(String, Tokens)> = now.into_iter().map(|t| (source.clone(), t)).collect();
    if now.is_some() && now != before {
        return Seen::TokensRead {
            found,
            known: vec![step.to_string()],
            unknown: vec![],
            ending: true,
        };
    }
    let name = run.def().step(step).map_or(step, |s| s.name.as_str());
    Seen::TokensRead {
        found,
        known: vec![],
        unknown: vec![(
            step.to_string(),
            format!("Dispatch did not report what {name} used"),
        )],
        ending: true,
    }
}

// Claude Code's `result` line and Codex's `turn.completed` line. Codex counts cached input inside
// its input.
pub fn from_claude_result(line: &Value) -> Option<Tokens> {
    if line["type"] != "result" {
        return None;
    }
    let usage = &line["usage"];
    let field = |key: &str| usage[key].as_u64().unwrap_or(0);
    usage["input_tokens"].as_u64()?;
    Some(Tokens {
        input: field("input_tokens"),
        output: field("output_tokens"),
        cache_write: field("cache_creation_input_tokens"),
        cache_read: field("cache_read_input_tokens"),
    })
}

pub fn from_codex_turn(line: &Value) -> Option<Tokens> {
    if line["type"] != "turn.completed" {
        return None;
    }
    let usage = &line["usage"];
    let input = usage["input_tokens"].as_u64()?;
    let cached = usage["cached_input_tokens"].as_u64().unwrap_or(0);
    Some(Tokens {
        input: input.saturating_sub(cached),
        output: usage["output_tokens"].as_u64().unwrap_or(0),
        cache_write: 0,
        cache_read: cached,
    })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TranscriptRead {
    pub files: Vec<(String, Tokens)>,
    pub moved: Vec<String>,
}

// `sessions::token_lines_command` prints one line for each transcript, and one naming each
// transcript a live session moved to.
pub fn parse_lines(text: &str) -> TranscriptRead {
    let moved = text
        .lines()
        .filter_map(|line| line.strip_prefix("moved "))
        .filter(|file| file.ends_with(".jsonl"))
        .map(str::to_string)
        .collect();
    let files = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(5, ' ');
            let mut number = || parts.next()?.parse::<u64>().ok();
            let tokens = Tokens {
                input: number()?,
                cache_write: number()?,
                cache_read: number()?,
                output: number()?,
            };
            let file = parts.next()?;
            file.ends_with(".jsonl").then(|| (file.to_string(), tokens))
        })
        .collect();
    TranscriptRead { files, moved }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_step_kind_is_on_its_side_of_the_limit() {
        use crate::pipeline::definition::{MachineChoice, SessionChoice, UpdateAction, Workspace};
        let spends = [
            StepKind::Agent {
                instructions: String::new(),
                agent: String::new(),
                machine: MachineChoice::Pick(vec![]),
                workspace: Workspace::NewWorktree,
                session: SessionChoice::New,
                read_only: false,
                mcp_servers: vec![],
            },
            StepKind::Plan { machines: vec![] },
            StepKind::Report,
        ];
        let free = [
            StepKind::Push,
            StepKind::Update {
                action: UpdateAction::Move,
                state: String::new(),
            },
            StepKind::Call {
                connector: String::new(),
                call: String::new(),
                params: Default::default(),
            },
            StepKind::Tool {
                server: String::new(),
                tool: String::new(),
                arguments: Value::Null,
                call_kind: crate::connectors::CallKind::Change,
                schema_hash: String::new(),
            },
            StepKind::Command {
                command: String::new(),
                approved: String::new(),
            },
            StepKind::Checks {
                require_approval: true,
            },
            StepKind::Wait {
                message: String::new(),
            },
        ];
        assert!(spends.iter().all(uses_tokens));
        assert!(!free.iter().any(uses_tokens));
    }

    #[test]
    fn a_moved_line_is_read_apart_from_the_counts() {
        let got = parse_lines("moved b.jsonl\nmoved not-a-file\n1 2 3 4 a.jsonl\n");
        assert_eq!(got.moved, vec!["b.jsonl"]);
        assert_eq!(got.files.len(), 1);
    }

    #[test]
    fn a_moved_transcript_stops_being_unknown_once_it_is_counted() {
        let mut used = TokenUse::default();
        used.unknown
            .insert(moved_key("hp:b.jsonl"), MOVED_WHY.into());
        used.note(vec![], vec!["fix".into()]);
        assert_eq!(
            used.unknown.len(),
            1,
            "reading the step again does not clear it"
        );
        used.note(vec![("hp:b.jsonl".into(), Tokens::default())], vec![]);
        assert!(used.unknown.is_empty());
    }

    #[test]
    fn numbers_read_with_commas() {
        assert_eq!(group(0), "0");
        assert_eq!(group(999), "999");
        assert_eq!(group(1000), "1,000");
        assert_eq!(group(1234567), "1,234,567");
    }

    #[test]
    fn a_pipeline_limit_beats_the_default_and_zero_means_none() {
        let mut def = crate::pipeline::templates::all().remove(0);
        let cfg = Cfg {
            token_limit: 5000,
            ..Cfg::default()
        };
        assert_eq!(limit_for(&def, &Cfg::default()), None);
        assert_eq!(limit_for(&def, &cfg), Some(5000));
        def.token_limit = Some(9000);
        assert_eq!(limit_for(&def, &cfg), Some(9000));
        def.token_limit = Some(0);
        assert_eq!(limit_for(&def, &cfg), None);
    }

    #[test]
    fn cache_reads_are_kept_but_not_counted() {
        let mut used = TokenUse::default();
        let t = Tokens {
            input: 10,
            output: 20,
            cache_write: 30,
            cache_read: 1000,
        };
        used.note(vec![("a".into(), t)], vec![]);
        assert_eq!(used.used(), 60);
        assert_eq!(used.cache_read(), 1000);
    }

    #[test]
    fn reading_the_same_transcript_again_does_not_add_it_again() {
        let mut used = TokenUse::default();
        let t = |input| Tokens {
            input,
            ..Tokens::default()
        };
        used.note(vec![("a".into(), t(100))], vec![]);
        used.note(vec![("a".into(), t(100))], vec![]);
        assert_eq!(used.used(), 100);
        used.note(vec![("a".into(), t(150)), ("b".into(), t(5))], vec![]);
        assert_eq!(used.used(), 155);
        used.note(vec![("a".into(), t(1))], vec![]);
        assert_eq!(
            used.used(),
            155,
            "a transcript cleaned away keeps its figure"
        );
    }

    #[test]
    fn a_read_step_is_no_longer_unknown() {
        let mut used = TokenUse::default();
        used.unknown.insert("fix".into(), "unread".into());
        used.note(vec![], vec!["fix".into()]);
        assert!(used.unknown.is_empty());
    }

    #[test]
    fn the_lines_the_command_prints_are_read_and_noise_is_not() {
        let got =
            parse_lines("1 2 3 4 a.jsonl\nsome shell noise\n5 6 7 8 b/subagents/agent one.jsonl\n")
                .files;
        assert_eq!(got.len(), 2);
        assert_eq!(
            got[0],
            (
                "a.jsonl".to_string(),
                Tokens {
                    input: 1,
                    cache_write: 2,
                    cache_read: 3,
                    output: 4
                }
            )
        );
        assert_eq!(got[1].0, "b/subagents/agent one.jsonl");
    }

    #[test]
    fn a_dispatch_turn_is_read_from_either_agents_last_line() {
        let claude = json!({"type": "result", "usage": {"input_tokens": 5, "output_tokens": 7,
            "cache_creation_input_tokens": 11, "cache_read_input_tokens": 13}});
        assert_eq!(
            from_claude_result(&claude),
            Some(Tokens {
                input: 5,
                output: 7,
                cache_write: 11,
                cache_read: 13
            })
        );
        assert_eq!(from_claude_result(&json!({"type": "result"})), None);
        assert_eq!(from_claude_result(&json!({"type": "assistant"})), None);
        let codex = json!({"type": "turn.completed", "usage": {"input_tokens": 28882,
            "cached_input_tokens": 12032, "cache_write_input_tokens": 0, "output_tokens": 268}});
        let got = from_codex_turn(&codex).unwrap();
        assert_eq!((got.input, got.cache_read, got.output), (16850, 12032, 268));
        assert_eq!(
            from_codex_turn(&json!({"type": "turn.completed", "usage": {}})),
            None
        );
    }
}
