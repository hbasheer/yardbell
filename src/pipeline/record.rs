use super::definition::{Definition, Outcome};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TicketRef {
    pub source: String,
    #[serde(alias = "linear_id")]
    pub item_id: String,
    pub id: String,
    pub title: String,
    pub url: String,
    // Only a source with nothing to read it back from, such as a webhook, keeps it here.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    // What a later call on this item needs, such as the repository it was found in.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

impl TicketRef {
    pub fn vars(&self) -> crate::connectors::client::Vars {
        let mut vars = self.fields.clone();
        vars.insert("item_id".to_string(), self.item_id.clone());
        crate::connectors::client::Vars(vars)
    }

    pub fn is_linear(&self) -> bool {
        self.source.is_empty() || self.source == "linear"
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PrRef {
    pub url: String,
    pub number: u64,
    pub branch: String,
    pub host: String,
    pub project: String,
    pub forge: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Subject {
    pub ticket: Option<TicketRef>,
    pub pr: Option<PrRef>,
}

impl PrRef {
    // A GitHub pull request or GitLab merge request link, as pasted from the browser.
    pub fn parse(url: &str) -> Option<PrRef> {
        let rest = url.trim().strip_prefix("https://")?;
        let (host, path) = rest.split_once('/')?;
        let (project, number, forge, mark) = match path.split_once("/-/merge_requests/") {
            Some((project, tail)) => (project, tail, "gitlab", "/-/merge_requests/"),
            None => {
                let (project, tail) = path.split_once("/pull/")?;
                (project, tail, "github", "/pull/")
            }
        };
        let number: u64 = number.split(['/', '?', '#']).next()?.parse().ok()?;
        if project.split('/').filter(|p| !p.is_empty()).count() < 2 {
            return None;
        }
        Some(PrRef {
            url: format!("https://{host}/{project}{mark}{number}"),
            number,
            branch: String::new(),
            host: host.to_string(),
            project: project.to_string(),
            forge: forge.into(),
        })
    }
}

impl Subject {
    // One run of a pipeline per item: a pull or merge request when there is one, else the ticket.
    pub fn key(&self) -> String {
        match (&self.pr, &self.ticket) {
            (Some(pr), _) => format!("pr:{}", pr.url),
            (None, Some(t)) if t.is_linear() => format!("ticket:{}", t.id),
            (None, Some(t)) => format!("ticket:{}:{}", t.source, t.item_id),
            (None, None) => "none".into(),
        }
    }

    pub fn label(&self) -> String {
        let pr = self.pr.as_ref().map(|p| {
            if p.forge == "gitlab" {
                format!("!{}", p.number)
            } else {
                format!("#{}", p.number)
            }
        });
        let ticket = self
            .ticket
            .as_ref()
            .map(|t| format!("{} {}", t.id, t.title).trim().to_string());
        match (pr, ticket) {
            (Some(p), Some(t)) => format!("{p} {t}"),
            (Some(p), None) => p,
            (None, Some(t)) => t,
            (None, None) => "a run".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Place {
    pub machine: String,
    pub folder: String,
    pub branch: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct StepState {
    pub runs: u32,
    pub session: String,
    pub machine: String,
    pub path: String,
    // The worktree this step's start made, and the repository it belongs to. A run only tears
    // down what it made.
    pub made: String,
    pub repo: String,
    pub outcome: Option<Outcome>,
    pub report: String,
    pub details: Vec<String>,
    pub started: String,
    pub ended: String,
    pub answer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    #[default]
    Queued,
    Running,
    Waiting,
    Done,
    Dropped,
}

impl RunState {
    pub fn active(&self) -> bool {
        !matches!(self, RunState::Done | RunState::Dropped)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitKind {
    Asking,
    NeedsYou,
    Stopped,
    RunLimit,
    TimeLimit,
    NoResult,
    Refused,
    Offline,
    Closed,
    WaitStep,
    Questions,
    Push,
    ToolChanged,
    TokenLimit,
    TokenUnknown,
}

impl WaitKind {
    pub fn answerable(&self) -> bool {
        matches!(
            self,
            WaitKind::NeedsYou | WaitKind::Asking | WaitKind::Questions | WaitKind::NoResult
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Waiting {
    pub kind: WaitKind,
    pub step: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub screen: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tool_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Entry {
    pub step: String,
    pub outcome: Option<Outcome>,
    pub at: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Question {
    pub asked: String,
    pub answer: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullRef {
    pub url: String,
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Run {
    pub id: String,
    pub pipeline: String,
    pub pipeline_name: String,
    pub version: u32,
    pub definition: Option<Definition>,
    pub subject: Subject,
    pub key: String,
    pub started_by: String,
    pub started: String,
    pub place: Place,
    pub state: RunState,
    pub step: String,
    pub step_since: String,
    pub steps: BTreeMap<String, StepState>,
    pub history: Vec<Entry>,
    pub waiting: Option<Waiting>,
    pub pending: Option<Effect>,
    pub conversation: String,
    pub retried: bool,
    pub tries: u32,
    pub next_try: Option<String>,
    pub slot: Option<String>,
    pub offline_since: Option<String>,
    pub teardown_problem: String,
    pub deleting: bool,
    pub questions: Vec<Question>,
    pub pull: Option<PullRef>,
    pub notes: Vec<String>,
    pub report: String,
    pub tokens: super::tokens::TokenUse,
}

impl Run {
    pub fn def(&self) -> &Definition {
        self.definition
            .as_ref()
            .expect("a run carries its definition")
    }

    // The end of the run's id, which its session names and result markers carry.
    pub fn tag(&self) -> &str {
        &self.id[self.id.len().saturating_sub(6)..]
    }

    pub fn state_of(&mut self, step: &str) -> &mut StepState {
        self.steps.entry(step.to_string()).or_default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub machine: String,
    pub folder: String,
    pub branch: String,
    pub reason: String,
    pub questions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "effect", rename_all = "snake_case")]
pub enum Effect {
    Plan {
        step: String,
    },
    Agent {
        step: String,
    },
    Answer {
        step: String,
        text: String,
    },
    Push {
        step: String,
    },
    OpenPull {
        step: String,
    },
    Linear {
        step: String,
    },
    Report {
        step: String,
    },
    Call {
        step: String,
    },
    Tool {
        step: String,
    },
    Notify {
        text: String,
    },
    #[serde(alias = "stop_read_only")]
    StopSessions,
}

// What the watcher, the runner or the person saw happen to one run.
#[derive(Debug, Clone, PartialEq)]
pub enum Seen {
    TornDown(Option<String>),
    WorktreeMade {
        step: String,
        path: String,
        repo: String,
    },
    PersonStopped(String),
    Tick,
    Admitted,
    Offline,
    Closed(String),
    Refused(String),
    Planned(Result<Plan, String>),
    Started {
        step: String,
        result: Result<(String, String, String), String>,
    },
    Ended {
        step: String,
        outcome: Outcome,
        report: String,
        details: Vec<String>,
    },
    NoResult {
        step: String,
        screen: String,
    },
    Waiting {
        step: String,
        screen: String,
    },
    Sent(Result<(), String>),
    Pushed(Result<(), String>),
    Opened(Result<PullRef, String>),
    Linear(Result<(), String>),
    Reported(Result<String, String>),
    Called(Result<String, String>),
    ToolDone(Result<String, String>),
    ToolChanged {
        hash: String,
        reason: String,
        shown: String,
    },
    TokensRead {
        found: Vec<(String, super::tokens::Tokens)>,
        known: Vec<String>,
        unknown: Vec<(String, String)>,
        ending: bool,
    },
    TokenBlind {
        step: String,
        why: String,
    },
    RaiseLimit(u64),
    AcceptTool,
    Answer(String),
    Retry,
    Continue(Outcome),
    Drop,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(source: &str, item_id: &str, id: &str) -> Subject {
        Subject {
            ticket: Some(TicketRef {
                source: source.into(),
                item_id: item_id.into(),
                id: id.into(),
                ..TicketRef::default()
            }),
            pr: None,
        }
    }

    #[test]
    fn a_saved_ticket_with_linear_id_still_loads() {
        let t: TicketRef =
            serde_json::from_str(r#"{"linear_id":"u-1","id":"COM-1","title":"t","url":"u"}"#)
                .unwrap();
        assert_eq!(t.item_id, "u-1");
        assert!(t.is_linear());
    }

    #[test]
    fn a_linear_ticket_keeps_its_key() {
        assert_eq!(item("", "u-1", "COM-1").key(), "ticket:COM-1");
        assert_eq!(item("linear", "u-1", "COM-1").key(), "ticket:COM-1");
    }

    #[test]
    fn another_sources_key_names_the_source() {
        assert_eq!(item("trello", "abc", "12").key(), "ticket:trello:abc");
    }

    #[test]
    fn pull_request_links_are_read() {
        let mr =
            PrRef::parse("https://git.commslayer.com/commslayer/app/-/merge_requests/87/diffs")
                .unwrap();
        assert_eq!(
            (
                mr.host.as_str(),
                mr.project.as_str(),
                mr.number,
                mr.forge.as_str()
            ),
            ("git.commslayer.com", "commslayer/app", 87, "gitlab")
        );
        assert_eq!(
            mr.url,
            "https://git.commslayer.com/commslayer/app/-/merge_requests/87"
        );
        let pr = PrRef::parse(" https://github.com/acme/api/pull/9 ").unwrap();
        assert_eq!(
            (
                pr.host.as_str(),
                pr.project.as_str(),
                pr.number,
                pr.forge.as_str()
            ),
            ("github.com", "acme/api", 9, "github")
        );
        assert_eq!(PrRef::parse("https://example.com/nothing"), None);
        assert_eq!(PrRef::parse("https://github.com/acme/pull/x"), None);
    }
}
