use super::definition::{Definition, Outcome};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TicketRef {
    pub linear_id: String,
    pub id: String,
    pub title: String,
    pub url: String,
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

impl Subject {
    // One run of a pipeline per item: a pull or merge request when there is one, else the ticket.
    pub fn key(&self) -> String {
        match (&self.pr, &self.ticket) {
            (Some(pr), _) => format!("pr:{}", pr.url),
            (None, Some(t)) => format!("ticket:{}", t.id),
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
    pub questions: Vec<Question>,
    pub pull: Option<PullRef>,
    pub notes: Vec<String>,
    pub report: String,
}

impl Run {
    pub fn def(&self) -> &Definition {
        self.definition
            .as_ref()
            .expect("a run carries its definition")
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
    Plan { step: String },
    Agent { step: String },
    Answer { step: String, text: String },
    Push { step: String },
    OpenPull { step: String },
    Linear { step: String },
    Report { step: String },
    Notify { text: String },
    StopSessions,
}

// What the watcher, the runner or the person saw happen to one run.
#[derive(Debug, Clone, PartialEq)]
pub enum Seen {
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
    Answer(String),
    Retry,
    Continue(Outcome),
    Drop,
}
