use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    #[default]
    Queued,
    Triage,
    Implement,
    Review,
    Fix,
    Qa,
    Finish,
    Done,
    Parked,
    Failed,
    Dropped,
}

impl Stage {
    pub fn active(&self) -> bool {
        !matches!(self, Stage::Done | Stage::Failed | Stage::Dropped)
    }

    pub fn on_machine(&self) -> bool {
        matches!(self, Stage::Implement | Stage::Review | Stage::Fix)
    }

    pub fn word(&self) -> &'static str {
        match self {
            Stage::Queued => "Queued",
            Stage::Triage => "Triage",
            Stage::Implement => "Implement",
            Stage::Review => "Review",
            Stage::Fix => "Fix",
            Stage::Qa => "QA",
            Stage::Finish => "Finish",
            Stage::Done => "Done",
            Stage::Parked => "Needs you",
            Stage::Failed => "Failed",
            Stage::Dropped => "Dropped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkKind {
    Questions,
    Asked,
    Findings,
    QaFailed,
    Push,
    Offline,
    TooLong,
    Closed,
    Refused,
}

impl ParkKind {
    pub fn answerable(&self) -> bool {
        matches!(
            self,
            ParkKind::Questions | ParkKind::Asked | ParkKind::Findings | ParkKind::QaFailed
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Parked {
    pub kind: ParkKind,
    pub reason: String,
    pub from: Stage,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub screen: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Question {
    pub asked: String,
    pub answer: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Entry {
    pub stage: Stage,
    pub at: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullRef {
    pub url: String,
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Sessions {
    pub implement: String,
    pub review: String,
    pub qa: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Record {
    pub id: String,
    pub linear_id: String,
    pub title: String,
    pub url: String,
    pub run: String,
    pub started_by: String,
    pub stage: Stage,
    pub fix_for: Option<Stage>,
    pub round: u32,
    pub qa_tries: u32,
    pub retried: bool,
    pub tries: u32,
    pub stage_since: String,
    pub next_try: Option<String>,
    pub waiting: Option<String>,
    pub history: Vec<Entry>,
    pub machine: String,
    pub folder: String,
    pub branch: String,
    pub reason: String,
    pub conversation: String,
    pub sessions: Sessions,
    pub questions: Vec<Question>,
    pub parked: Option<Parked>,
    pub failed: String,
    pub failed_at: Option<Stage>,
    pub sent: String,
    pub pending: Option<Effect>,
    pub findings: Vec<String>,
    pub qa_report: String,
    pub outcome: String,
    pub pull: Option<PullRef>,
    pub finished: Vec<String>,
    pub notes: Vec<String>,
    pub summary: String,
    pub linear_comment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ticket {
    pub linear_id: String,
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub state: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Triage {
    pub machine: String,
    pub folder: String,
    pub branch: String,
    pub reason: String,
    pub questions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub severity: String,
    pub place: String,
    pub text: String,
}

// What the watcher, the runner or the person saw happen to one ticket.
#[derive(Debug, Clone, PartialEq)]
pub enum Seen {
    Tick,
    Admitted,
    Triaged(Result<Triage, String>),
    Started(Result<String, String>),
    Idle {
        outcome: crate::dispatch::GroupOutcome,
        verdict: Option<bool>,
    },
    NoResult(String),
    Waiting(String),
    Reviewed {
        findings: Vec<Finding>,
    },
    Sent(Result<(), String>),
    Pushed(Result<(), String>),
    Opened(Result<PullRef, String>),
    Moved(Result<(), String>),
    Summarised(Result<(String, String), String>),
    Answer(String),
    Retry,
    Drop,
    Closed(String),
    Offline,
    Refused(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "effect", content = "text", rename_all = "snake_case")]
pub enum Effect {
    Triage,
    Implement,
    Review,
    Send(String),
    Answer(String),
    MoveToTest,
    Push,
    OpenPull,
    MoveLinear,
    Summarise,
    Notify(String),
    StopSessions,
}
