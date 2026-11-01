use crate::config::Config;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const END: &str = "end";
pub const WAIT: &str = "wait";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Pass,
    Fail,
    NeedsYou,
}

impl Outcome {
    pub fn word(&self) -> &'static str {
        match self {
            Outcome::Pass => "passed",
            Outcome::Fail => "failed",
            Outcome::NeedsYou => "needs you",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Next {
    pub pass: String,
    pub fail: String,
    pub needs_you: String,
}

impl Default for Next {
    fn default() -> Self {
        Next {
            pass: END.into(),
            fail: WAIT.into(),
            needs_you: WAIT.into(),
        }
    }
}

impl Next {
    pub fn of(&self, outcome: Outcome) -> &str {
        match outcome {
            Outcome::Pass => &self.pass,
            Outcome::Fail => &self.fail,
            Outcome::NeedsYou => &self.needs_you,
        }
    }

    fn lines(&self) -> [(&'static str, &str); 3] {
        [
            ("pass", &self.pass),
            ("fail", &self.fail),
            ("needs you", &self.needs_you),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineChoice {
    Name(String),
    SameAs(String),
    Pick(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Workspace {
    NewWorktree,
    SameAs { step: String },
    Copy { from: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionChoice {
    New,
    Continue(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateAction {
    Move,
    Comment,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepKind {
    Agent {
        instructions: String,
        #[serde(default)]
        agent: String,
        machine: MachineChoice,
        workspace: Workspace,
        session: SessionChoice,
        #[serde(default)]
        read_only: bool,
        #[serde(default)]
        mcp_servers: Vec<String>,
    },
    Plan {
        #[serde(default)]
        machines: Vec<String>,
    },
    Push,
    #[serde(rename = "update", alias = "linear")]
    Update {
        action: UpdateAction,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        state: String,
    },
    Report,
    Call {
        connector: String,
        call: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        params: BTreeMap<String, String>,
    },
    Tool {
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Value,
        #[serde(default = "changes")]
        call_kind: crate::connectors::CallKind,
        #[serde(default)]
        schema_hash: String,
    },
    Wait {
        #[serde(default)]
        message: String,
    },
    Command {
        command: String,
        // The exact text a person accepted. Only this text runs, so a command an agent proposed
        // or changed waits for a person the first time a run reaches it.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        approved: String,
    },
}

pub const COMMAND_MINUTES: u64 = 10;
const COMMAND_MAX: usize = 4000;

// The command reaches the shell exactly as it was approved, so nothing from a ticket can get in.
fn command_problem(command: &str) -> Option<String> {
    if command.trim().is_empty() {
        return Some("the command is empty".into());
    }
    if command.chars().count() > COMMAND_MAX {
        return Some(format!(
            "the command must be at most {COMMAND_MAX} characters"
        ));
    }
    if command
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Some(
            "the command has control characters that would not show when you read it".into(),
        );
    }
    let placeholder =
        Regex::new(r"(?:^|[^$])(\{(?:ticket|title|url|description|branch|pr|report)(?::[^}]*)?\})")
            .expect("static regex");
    placeholder.captures(command).map(|c| {
        format!(
            "a command does not fill in {}, because a ticket's text must never reach a shell",
            &c[1]
        )
    })
}

fn changes() -> crate::connectors::CallKind {
    crate::connectors::CallKind::Change
}

fn two() -> u32 {
    2
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub kind: StepKind,
    #[serde(default = "two")]
    pub max_runs: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u64>,
    #[serde(default)]
    pub next: Next,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    Manual,
    Schedule {
        schedule: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        state: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        connector: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        params: BTreeMap<String, String>,
    },
    Connector {
        connector: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        params: BTreeMap<String, String>,
        #[serde(default)]
        states: Vec<String>,
    },
    Linear {
        #[serde(default)]
        assigned: bool,
        #[serde(default)]
        states: Vec<String>,
    },
    Webhook {
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        map: BTreeMap<String, String>,
    },
    GithubReview,
    GitlabReviewer {
        #[serde(default)]
        host: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub version: u32,
    pub trigger: Trigger,
    pub start: String,
    pub steps: Vec<Step>,
}

impl Definition {
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    fn name_of(&self, id: &str) -> String {
        self.step(id)
            .map_or_else(|| id.to_string(), |s| s.name.clone())
    }

    // For each step, the steps every path from the start passes through before it, itself
    // included. A step that is not reached has none.
    pub fn before(&self) -> BTreeMap<String, BTreeSet<String>> {
        let ids: BTreeSet<String> = self.steps.iter().map(|s| s.id.clone()).collect();
        let mut preds: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for s in &self.steps {
            for (_, to) in s.next.lines() {
                if ids.contains(to) {
                    preds.entry(to).or_default().push(&s.id);
                }
            }
        }
        let reached = self.reached();
        let mut dom: BTreeMap<String, BTreeSet<String>> = reached
            .iter()
            .map(|id| {
                let all = if *id == self.start {
                    BTreeSet::from([id.clone()])
                } else {
                    reached.clone()
                };
                (id.clone(), all)
            })
            .collect();
        loop {
            let mut changed = false;
            for id in &reached {
                if *id == self.start {
                    continue;
                }
                let mut meet: Option<BTreeSet<String>> = None;
                for p in preds.get(id.as_str()).into_iter().flatten() {
                    if let Some(d) = dom.get(*p) {
                        meet = Some(match meet {
                            None => d.clone(),
                            Some(m) => m.intersection(d).cloned().collect(),
                        });
                    }
                }
                let mut next = meet.unwrap_or_default();
                next.insert(id.clone());
                if dom.get(id) != Some(&next) {
                    dom.insert(id.clone(), next);
                    changed = true;
                }
            }
            if !changed {
                return dom;
            }
        }
    }

    fn reached(&self) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut todo = vec![self.start.clone()];
        while let Some(id) = todo.pop() {
            let Some(step) = self.step(&id) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            for (_, to) in step.next.lines() {
                todo.push(to.to_string());
            }
        }
        seen
    }
}

pub fn check(def: &Definition, cfg: &Config) -> Result<(), Vec<String>> {
    let mut out = Vec::new();
    if def.name.trim().is_empty() {
        out.push("the pipeline needs a name".to_string());
    }
    let known = |name: &str| cfg.machine(name).is_some();
    let source = match &def.trigger {
        Trigger::Connector { connector, .. } => Some(connector.as_str()),
        Trigger::Schedule { connector, .. } if !connector.is_empty() => Some(connector.as_str()),
        _ => None,
    };
    let gives = match &def.trigger {
        Trigger::Webhook { .. } => Some("webhook"),
        _ => source,
    };
    if let Some(id) = gives {
        for s in &def.steps {
            let StepKind::Update { action, .. } = &s.kind else {
                continue;
            };
            if id == "webhook" {
                out.push(format!(
                    "{} updates a ticket, and a webhook gives none to update",
                    s.name
                ));
                continue;
            }
            let need = match action {
                UpdateAction::Move => "move",
                UpdateAction::Comment => "comment",
            };
            if let Some(c) = cfg.connectors.iter().find(|c| c.id == id) {
                if !c.calls.contains_key(need) {
                    out.push(format!(
                        "{} needs the action {need}, which {} does not have",
                        s.name, c.name
                    ));
                }
            }
        }
    }
    for s in &def.steps {
        let StepKind::Tool { server, .. } = &s.kind else {
            continue;
        };
        match cfg.mcp_servers.iter().find(|m| &m.name == server) {
            Some(m) if crate::mcp_client::is_own_server(&m.url, cfg) => out.push(format!(
                "{} calls {server}, which is Yardbell itself, and a pipeline must not call it",
                s.name
            )),
            None if def.enabled => out.push(format!(
                "{} names the server {server}, which is not in Settings, Connections",
                s.name
            )),
            _ => {}
        }
    }
    if def.enabled {
        for s in &def.steps {
            let StepKind::Call {
                connector, call, ..
            } = &s.kind
            else {
                continue;
            };
            match cfg.connectors.iter().find(|c| &c.id == connector) {
                None => out.push(format!(
                    "{} names connector {connector}, which is not in Settings",
                    s.name
                )),
                Some(c) if !c.calls.contains_key(call) => out.push(format!(
                    "{} names the call {call}, which {connector} does not have",
                    s.name
                )),
                Some(_) => {}
            }
        }
        let chosen = match &def.trigger {
            Trigger::Connector { params, .. } | Trigger::Schedule { params, .. } => Some(params),
            _ => None,
        };
        let connector = source.and_then(|id| cfg.connectors.iter().find(|c| c.id == id));
        if let (Some(c), Some(chosen)) = (connector, chosen) {
            let needs = c.calls.get("list").map(crate::connectors::client::needs_of);
            for p in &c.params {
                let needed = needs.as_ref().is_some_and(|n| n.contains(&p.name));
                if needed && !chosen.contains_key(&p.name) {
                    out.push(format!("Pick a {} for the trigger", p.label));
                }
            }
        }
        match source.map(|id| (id, cfg.connectors.iter().find(|c| c.id == id))) {
            Some((id, None)) => out.push(format!(
                "the trigger names connector {id}, which is not in Settings"
            )),
            Some((id, Some(c))) if !c.enabled => {
                out.push(format!("connector {id} is switched off"))
            }
            _ => {}
        }
        match &def.trigger {
            Trigger::Schedule { schedule, .. } => {
                if let Err(e) = crate::triggers::Schedule::parse(schedule) {
                    out.push(format!("schedule: {e}"));
                }
            }
            Trigger::Linear { assigned, states } if !assigned && states.is_empty() => {
                out.push("the Linear trigger needs assigned or a list of states".into());
            }
            Trigger::GitlabReviewer { host } if host.trim().is_empty() => {
                out.push("gitlab_reviewer needs a host".into());
            }
            Trigger::GitlabReviewer { host } => {
                let listed = cfg
                    .pull_requests
                    .gitlab
                    .iter()
                    .any(|g| g.host.eq_ignore_ascii_case(host.trim()));
                if !listed {
                    out.push(format!(
                        "gitlab_reviewer names {host}, which is not under pull_requests.gitlab"
                    ));
                }
            }
            _ => {}
        }
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for s in &def.steps {
        if !ids.insert(s.id.as_str()) {
            out.push(format!("two steps have the id {}", s.id));
        }
        if !names.insert(s.name.trim().to_lowercase()) {
            out.push(format!("two steps are named {}", s.name));
        }
    }
    if def.steps.is_empty() {
        if def.enabled {
            out.push("the pipeline needs at least one step".into());
        }
    } else if def.start.trim().is_empty() {
        out.push("the pipeline needs a first step".into());
    } else if def.step(&def.start).is_none() {
        out.push(format!("the start step {} does not exist", def.start));
    }
    let reached = def.reached();
    let before = def.before();
    let plans: BTreeSet<&str> = def
        .steps
        .iter()
        .filter(|s| matches!(s.kind, StepKind::Plan { .. }))
        .map(|s| s.id.as_str())
        .collect();
    let placeholder = Regex::new(r"\{report:([^}]+)\}").expect("static regex");
    for s in &def.steps {
        let name = &s.name;
        for (word, to) in s.next.lines() {
            if to != END && to != WAIT && def.step(to).is_none() {
                out.push(format!(
                    "{name}: its {word} line goes to a step that does not exist"
                ));
            }
        }
        if !reached.contains(&s.id) {
            out.push(format!("{name} is never reached"));
            continue;
        }
        if !(1..=10).contains(&s.max_runs) {
            out.push(format!("{name}: max_runs must be from 1 to 10"));
        }
        let shortest = match s.kind {
            StepKind::Command { .. } => 1,
            _ => 10,
        };
        if s.minutes.is_some_and(|m| !(shortest..=1440).contains(&m)) {
            out.push(format!("{name}: minutes must be from {shortest} to 1440"));
        }
        let earlier = before.get(&s.id).cloned().unwrap_or_default();
        let comes_before = |word: &str, other: &str, out: &mut Vec<String>| {
            if other == s.id || !earlier.contains(other) {
                out.push(format!(
                    "{name}: {word} names {}, which does not come before it on every path",
                    def.name_of(other)
                ));
            }
        };
        match &s.kind {
            StepKind::Agent {
                instructions,
                machine,
                workspace,
                session,
                mcp_servers,
                ..
            } => {
                for c in placeholder.captures_iter(instructions) {
                    let want = c[1].trim().to_lowercase();
                    if !def
                        .steps
                        .iter()
                        .any(|x| x.id == want || x.name.to_lowercase() == want)
                    {
                        out.push(format!("{name}: {} names no step", &c[0]));
                    }
                }
                match machine {
                    MachineChoice::Name(m) if !known(m) => {
                        out.push(format!("{name}: machine {m} does not exist"));
                    }
                    MachineChoice::SameAs(other) => comes_before("same_as", other, &mut out),
                    MachineChoice::Pick(list) => {
                        for m in list.iter().filter(|m| !known(m)) {
                            out.push(format!("{name}: machine {m} does not exist"));
                        }
                        if !earlier.iter().any(|e| plans.contains(e.as_str())) {
                            out.push(format!(
                                "{name}: pick needs a Plan step before it on every path"
                            ));
                        }
                    }
                    _ => {}
                }
                match workspace {
                    Workspace::SameAs { step } => comes_before("same_as", step, &mut out),
                    Workspace::Copy { from } => comes_before("copy", from, &mut out),
                    Workspace::NewWorktree
                        if !earlier.iter().any(|e| plans.contains(e.as_str())) =>
                    {
                        out.push(format!(
                            "{name}: a new worktree needs a Plan step before it on every path, to pick the folder"
                        ));
                    }
                    Workspace::NewWorktree => {}
                }
                if let SessionChoice::Continue(other) = session {
                    comes_before("continue", other, &mut out);
                }
                for m in mcp_servers {
                    if !cfg.mcp_servers.iter().any(|x| &x.name == m) {
                        out.push(format!("{name}: MCP server {m} is not set up"));
                    }
                }
            }
            StepKind::Plan { machines } => {
                for m in machines.iter().filter(|m| !known(m)) {
                    out.push(format!("{name}: machine {m} does not exist"));
                }
            }
            StepKind::Push => {
                let worktree = |id: &String| {
                    def.step(id).is_some_and(|x| {
                        matches!(
                            x.kind,
                            StepKind::Agent {
                                workspace: Workspace::NewWorktree,
                                ..
                            }
                        )
                    })
                };
                if !earlier.iter().any(worktree) {
                    out.push(format!(
                        "{name}: needs a step that works in a new worktree before it on every path"
                    ));
                }
            }
            StepKind::Command { command, .. } => {
                if let Some(problem) = command_problem(command) {
                    out.push(format!("{name}: {problem}"));
                }
                let worktree = |id: &String| {
                    def.step(id).is_some_and(|x| {
                        matches!(
                            x.kind,
                            StepKind::Agent {
                                workspace: Workspace::NewWorktree,
                                ..
                            }
                        )
                    })
                };
                if !earlier.iter().any(worktree) {
                    out.push(format!(
                        "{name}: a command runs in the run's worktree, so it needs a step that works in a new worktree before it on every path"
                    ));
                }
            }
            StepKind::Update {
                action: UpdateAction::Move,
                state,
            } if state.trim().is_empty() => {
                out.push(format!(
                    "{name}: moving the ticket needs the state to move it to"
                ));
            }
            _ => {}
        }
    }
    if out.is_empty() {
        Ok(())
    } else {
        Err(out)
    }
}

pub fn slug(name: &str, taken: &[String]) -> String {
    let words: Vec<String> = name
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    let base = if words.is_empty() {
        "step".to_string()
    } else {
        words.join("-")
    };
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken.contains(c))
        .expect("a free slug")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn cfg() -> Config {
        serde_yaml::from_str(
            "machines:\n  - name: hp\n    local: true\n    root: /r\n  - name: mini\n    ssh: mini\n    port_prefix: 2\n    root: /r\n  - name: devbox\n    ssh: devbox\n    port_prefix: 3\n    root: /r\npull_requests:\n  gitlab:\n    - host: git.commslayer.com\n      token: x\n",
        )
        .unwrap()
    }

    const EXAMPLE: &str = r#"{
      "id": "review", "name": "Review my merge requests", "enabled": true, "version": 3,
      "trigger": { "kind": "gitlab_reviewer", "host": "git.commslayer.com" },
      "start": "understand",
      "steps": [
        { "id": "understand", "name": "Understand", "kind": "agent",
          "instructions": "Read {ticket} and the merge request {pr}. Explain the issue.",
          "agent": "", "machine": { "pick": ["hp", "mini"] }, "workspace": { "kind": "new_worktree" },
          "session": "new", "read_only": true, "mcp_servers": [], "max_runs": 2, "minutes": 120,
          "next": { "pass": "report", "fail": "report", "needs_you": "wait" }, "x": 330, "y": 110 },
        { "id": "report", "name": "Report", "kind": "report", "next": { "pass": "end" } }
      ]
    }"#;

    fn example() -> Definition {
        serde_json::from_str(EXAMPLE).unwrap()
    }

    #[test]
    fn check_names_a_bad_call() {
        let mut cfg = cfg();
        cfg.connectors = vec![crate::connectors::template("trello").unwrap()];
        let mut def = crate::pipeline::templates::all().remove(1);
        def.enabled = true;
        def.steps.push(
            serde_json::from_value(serde_json::json!({
                "id": "update", "name": "Update Trello", "kind": "call",
                "connector": "trello", "call": "nope",
            }))
            .unwrap(),
        );
        let problems = check(&def, &cfg).err().unwrap_or_default();
        assert!(
            problems.contains(
                &"Update Trello names the call nope, which trello does not have".to_string()
            ),
            "{problems:?}"
        );
    }

    #[test]
    fn a_trigger_must_pick_what_its_list_needs() {
        let mut cfg = cfg();
        cfg.connectors = vec![crate::connectors::template("trello").unwrap()];
        let mut def = crate::pipeline::templates::all().remove(1);
        def.enabled = true;
        def.trigger = Trigger::Connector {
            connector: "trello".into(),
            params: Default::default(),
            states: vec![],
        };
        let problems = check(&def, &cfg).err().unwrap_or_default();
        assert!(
            problems.contains(&"Pick a Board for the trigger".to_string()),
            "{problems:?}"
        );
        def.trigger = Trigger::Connector {
            connector: "trello".into(),
            params: [("board".to_string(), "B1".to_string())].into(),
            states: vec![],
        };
        let problems = check(&def, &cfg).err().unwrap_or_default();
        assert!(
            !problems.iter().any(|p| p.contains("Pick a")),
            "{problems:?}"
        );
    }

    #[test]
    fn definition_check_knows_connectors() {
        let mut cfg = cfg();
        let mut def = crate::pipeline::templates::all().remove(0);
        def.enabled = true;
        def.trigger = Trigger::Connector {
            connector: "x".into(),
            params: Default::default(),
            states: vec![],
        };
        let problems = |d: &Definition, c: &Config| check(d, c).err().unwrap_or_default();
        assert!(problems(&def, &cfg)
            .contains(&"the trigger names connector x, which is not in Settings".to_string()));
        let mut trello = crate::connectors::template("trello").unwrap();
        trello.id = "x".into();
        trello.enabled = false;
        cfg.connectors = vec![trello];
        assert!(problems(&def, &cfg).contains(&"connector x is switched off".to_string()));
    }

    #[test]
    fn definitions_read_and_write_back() {
        let def = example();
        assert_eq!(def.steps[0].name, "Understand");
        assert!(
            matches!(&def.steps[0].kind, StepKind::Agent { machine: MachineChoice::Pick(m), read_only: true, .. } if m == &vec!["hp".to_string(), "mini".to_string()])
        );
        assert_eq!(def.steps[1].next.fail, "wait");
        assert_eq!(def.steps[1].max_runs, 2);
        let again: Definition =
            serde_json::from_value(serde_json::to_value(&def).unwrap()).unwrap();
        assert_eq!(again, def);
    }

    fn agent(id: &str, name: &str, machine: MachineChoice) -> Step {
        Step {
            id: id.into(),
            name: name.into(),
            kind: StepKind::Agent {
                instructions: "do it".into(),
                agent: String::new(),
                machine,
                workspace: Workspace::NewWorktree,
                session: SessionChoice::New,
                read_only: false,
                mcp_servers: vec![],
            },
            max_runs: 2,
            minutes: None,
            next: Next::default(),
            x: 0.0,
            y: 0.0,
        }
    }

    fn plan_step(id: &str) -> Step {
        Step {
            kind: StepKind::Plan { machines: vec![] },
            ..agent(id, "Plan", MachineChoice::Name("hp".into()))
        }
    }

    fn def(steps: Vec<Step>) -> Definition {
        Definition {
            id: "p".into(),
            name: "P".into(),
            enabled: true,
            version: 1,
            trigger: Trigger::Manual,
            start: steps[0].id.clone(),
            steps,
        }
    }

    fn problems(d: &Definition) -> Vec<String> {
        check(d, &cfg()).err().unwrap_or_default()
    }

    #[test]
    fn check_allows_an_empty_pipeline_while_off() {
        let mut empty = Definition {
            steps: vec![],
            start: String::new(),
            enabled: false,
            ..def(vec![agent("a", "A", MachineChoice::Name("hp".into()))])
        };
        assert_eq!(check(&empty, &cfg()), Ok(()));
        empty.enabled = true;
        assert_eq!(
            problems(&empty),
            vec!["the pipeline needs at least one step"]
        );
        let mut unstarted = def(vec![agent("a", "A", MachineChoice::Name("hp".into()))]);
        unstarted.start = String::new();
        assert!(problems(&unstarted).contains(&"the pipeline needs a first step".to_string()));
    }

    #[test]
    fn check_names_report_placeholders_that_name_no_step() {
        let mut steps = vec![
            plan_step("plan"),
            agent("a", "Understand", MachineChoice::Pick(vec![])),
            agent("b", "Root cause", MachineChoice::SameAs("a".into())),
        ];
        steps[0].next.pass = "a".into();
        steps[1].next.pass = "b".into();
        if let StepKind::Agent { instructions, .. } = &mut steps[2].kind {
            *instructions = "Check {report:Understand} and {report:Nope}".into();
        }
        assert_eq!(
            problems(&def(steps)),
            vec!["Root cause: {report:Nope} names no step"]
        );
    }

    #[test]
    fn a_new_worktree_and_a_push_need_a_plan_before_them() {
        let mut steps = vec![
            agent("a", "Implement", MachineChoice::Name("hp".into())),
            Step {
                kind: StepKind::Push,
                ..agent("push", "Push", MachineChoice::Name("hp".into()))
            },
        ];
        steps[0].next.pass = "push".into();
        assert_eq!(
            problems(&def(steps)),
            vec!["Implement: a new worktree needs a Plan step before it on every path, to pick the folder"]
        );
        let mut alone = vec![
            plan_step("plan"),
            Step {
                kind: StepKind::Push,
                ..agent("push", "Push", MachineChoice::Name("hp".into()))
            },
        ];
        alone[0].next.pass = "push".into();
        assert_eq!(
            problems(&def(alone)),
            vec!["Push: needs a step that works in a new worktree before it on every path"]
        );
    }

    #[test]
    fn check_names_each_problem() {
        let mut root = agent("root-cause", "Root cause", MachineChoice::Name("hp".into()));
        root.next.fail = "nowhere".into();
        assert!(problems(&def(vec![root]))
            .contains(&"Root cause: its fail line goes to a step that does not exist".to_string()));

        let test = agent("test", "Test", MachineChoice::Pick(vec![]));
        assert!(problems(&def(vec![test]))
            .contains(&"Test: pick needs a Plan step before it on every path".to_string()));
        let mut planned = plan_step("plan");
        planned.next.pass = "test".into();
        assert!(problems(&def(vec![
            planned,
            agent("test", "Test", MachineChoice::Pick(vec![]))
        ]))
        .is_empty());

        let mut fix = agent("fix", "Fix", MachineChoice::Name("hp".into()));
        fix.next.pass = "implement".into();
        let mut implement = agent("implement", "Implement", MachineChoice::Name("hp".into()));
        if let StepKind::Agent { session, .. } = &mut fix.kind {
            *session = SessionChoice::Continue("implement".into());
        }
        let _ = &mut implement;
        assert!(problems(&def(vec![fix, implement])).contains(
            &"Fix: continue names Implement, which does not come before it on every path"
                .to_string()
        ));

        let mut review = agent("review", "Review", MachineChoice::Name("hp".into()));
        review.max_runs = 11;
        assert!(problems(&def(vec![review]))
            .contains(&"Review: max_runs must be from 1 to 10".to_string()));

        let lonely = vec![
            agent("a", "Understand", MachineChoice::Name("hp".into())),
            agent("security", "Security", MachineChoice::Name("hp".into())),
        ];
        assert!(problems(&def(lonely)).contains(&"Security is never reached".to_string()));

        let report = Step {
            kind: StepKind::Report,
            ..agent("a", "A", MachineChoice::Name("hp".into()))
        };
        let mut gl = def(vec![report]);
        gl.trigger = Trigger::GitlabReviewer {
            host: "git.example.com".into(),
        };
        assert!(problems(&gl).contains(
            &"gitlab_reviewer names git.example.com, which is not under pull_requests.gitlab"
                .to_string()
        ));

        let unknown = def(vec![agent("a", "A", MachineChoice::Name("nope".into()))]);
        assert!(problems(&unknown).contains(&"A: machine nope does not exist".to_string()));
    }

    #[test]
    fn a_switched_off_pipeline_may_miss_its_trigger_host() {
        let report = Step {
            kind: StepKind::Report,
            ..agent("a", "A", MachineChoice::Name("hp".into()))
        };
        let mut gl = def(vec![report]);
        gl.trigger = Trigger::GitlabReviewer {
            host: String::new(),
        };
        assert!(problems(&gl).contains(&"gitlab_reviewer needs a host".to_string()));
        gl.enabled = false;
        assert!(problems(&gl).is_empty());
    }

    fn command_step(id: &str, command: &str) -> Step {
        Step {
            kind: StepKind::Command {
                command: command.into(),
                approved: command.into(),
            },
            ..agent(id, "Test", MachineChoice::Name("hp".into()))
        }
    }

    fn after_worktree(command: Step) -> Definition {
        let mut steps = vec![
            plan_step("plan"),
            agent("work", "Work", MachineChoice::SameAs("plan".into())),
            command,
        ];
        steps[1].kind = StepKind::Agent {
            instructions: "do it".into(),
            agent: String::new(),
            machine: MachineChoice::Pick(vec![]),
            workspace: Workspace::NewWorktree,
            session: SessionChoice::New,
            read_only: false,
            mcp_servers: vec![],
        };
        steps[0].next.pass = "work".into();
        steps[1].next.pass = steps[2].id.clone();
        def(steps)
    }

    #[test]
    fn a_saved_command_step_reads_back_and_needs_no_approval_field() {
        let step: Step = serde_json::from_value(serde_json::json!({
            "id": "test", "name": "Test", "kind": "command", "command": "make test",
        }))
        .unwrap();
        assert!(
            matches!(&step.kind, StepKind::Command { command, approved } if command == "make test" && approved.is_empty())
        );
        let again: Step = serde_json::from_value(serde_json::to_value(&step).unwrap()).unwrap();
        assert_eq!(again, step);
    }

    #[test]
    fn a_good_command_step_passes_the_checks() {
        for fine in [
            "make test",
            "cargo test\ncargo clippy",
            "docker inspect --format '{{.State}}' x",
            "echo ${branch} {a,b}",
        ] {
            assert_eq!(
                problems(&after_worktree(command_step("test", fine))),
                Vec::<String>::new(),
                "{fine}"
            );
        }
    }

    #[test]
    fn check_names_a_bad_command() {
        let cases: [(String, &str); 5] = [
            ("  ".into(), "Test: the command is empty"),
            (
                "x".repeat(COMMAND_MAX + 1),
                "Test: the command must be at most 4000 characters",
            ),
            (
                "make\u{1b}[2K test".into(),
                "Test: the command has control characters that would not show when you read it",
            ),
            (
                "git push origin {branch}".into(),
                "Test: a command does not fill in {branch}, because a ticket's text must never reach a shell",
            ),
            (
                "echo {report:Review}".into(),
                "Test: a command does not fill in {report:Review}, because a ticket's text must never reach a shell",
            ),
        ];
        for (command, message) in cases {
            assert_eq!(
                problems(&after_worktree(command_step("test", &command))),
                vec![message.to_string()]
            );
        }
    }

    #[test]
    fn a_command_needs_a_worktree_before_it_on_every_path() {
        let alone = def(vec![command_step("test", "make test")]);
        assert_eq!(
            problems(&alone),
            vec!["Test: a command runs in the run's worktree, so it needs a step that works in a new worktree before it on every path"]
        );
    }

    #[test]
    fn a_command_may_be_stopped_sooner_than_an_agent() {
        let mut quick = command_step("test", "make test");
        quick.minutes = Some(1);
        assert_eq!(
            problems(&after_worktree(quick.clone())),
            Vec::<String>::new()
        );
        quick.minutes = Some(0);
        assert_eq!(
            problems(&after_worktree(quick)),
            vec!["Test: minutes must be from 1 to 1440"]
        );
    }

    #[test]
    fn slugs_are_unique() {
        assert_eq!(slug("Root cause!", &[]), "root-cause");
        assert_eq!(slug("Root cause", &["root-cause".into()]), "root-cause-2");
        assert_eq!(
            slug("Root cause", &["root-cause".into(), "root-cause-2".into()]),
            "root-cause-3"
        );
    }
}
