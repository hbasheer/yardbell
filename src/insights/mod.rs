pub mod runs;
#[cfg(test)]
mod tests;

use crate::snapshot::{Activity, Snapshot};
use chrono::{DateTime, FixedOffset, Local};
use runs::{Run, RunKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

// A session keeps this many marks, its first one always among them.
pub const MAX_MARKS: usize = 300;
// Sessions kept at once; the ones seen longest ago go first.
pub const MAX_SESSIONS: usize = 100;
// A blip of another state this short between two stretches of the same state is part of them.
const BLIP_SECS: i64 = 15;
// Runs of the same text recorded this recently are the same run seen again after a restart.
const RECENT_RUNS: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Started,
    Seen,
    Active,
    Idle,
    Blocked,
    Ended,
    Tool,
    Test,
}

impl Kind {
    fn of(activity: Activity) -> Kind {
        match activity {
            Activity::Active => Kind::Active,
            Activity::Idle => Kind::Idle,
            Activity::Blocked => Kind::Blocked,
        }
    }

    fn is_state(self) -> bool {
        !matches!(self, Kind::Tool | Kind::Test)
    }

    fn word(self) -> Option<&'static str> {
        match self {
            Kind::Active => Some("working"),
            Kind::Blocked => Some("waiting"),
            Kind::Idle => Some("idle"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mark {
    pub at: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub machine: String,
    pub name: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub branch: String,
    pub marks: Vec<Mark>,
    // Marks pruned since the first one, so the timeline can say it is not complete.
    #[serde(default)]
    pub dropped: usize,
}

impl Record {
    fn last_state(&self) -> Option<Kind> {
        self.marks
            .iter()
            .rev()
            .map(|m| m.kind)
            .find(|k| k.is_state())
    }

    fn last_at(&self) -> &str {
        self.marks.last().map_or("", |m| m.at.as_str())
    }

    fn push(&mut self, at: &str, kind: Kind, run: Option<&Run>) {
        self.marks.push(Mark {
            at: at.to_string(),
            kind,
            text: run.map(|r| r.text.clone()).unwrap_or_default(),
            ok: run.and_then(|r| r.ok),
        });
        if self.marks.len() > MAX_MARKS {
            let over = self.marks.len() - MAX_MARKS;
            self.marks.drain(1..=over);
            self.dropped += over;
        }
    }

    fn recent_runs(&self) -> HashSet<&str> {
        self.marks
            .iter()
            .rev()
            .filter(|m| !m.kind.is_state())
            .take(RECENT_RUNS)
            .map(|m| m.text.as_str())
            .collect()
    }
}

// What Yardbell saw of each session while it ran: when it appeared, each change between working,
// waiting and idle, the tool calls and test runs its screen showed, and when it went away. Kept in
// a file so a restart carries on with the same timelines.
pub struct Insights {
    file: PathBuf,
    records: Mutex<BTreeMap<String, Record>>,
    watched: Mutex<HashSet<String>>,
    screens: Mutex<HashMap<String, Vec<String>>>,
}

impl Insights {
    pub fn load(file: PathBuf) -> Insights {
        let records = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Insights {
            file,
            records: Mutex::new(records),
            watched: Mutex::new(HashSet::new()),
            screens: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Record>> {
        self.records.lock().expect("insights lock")
    }

    pub fn record(&self, machine: &str, name: &str) -> Option<Record> {
        self.lock().get(&format!("{machine}:{name}")).cloned()
    }

    // One check of a machine. Sessions on the first check after Yardbell started were already
    // running, so they count as seen rather than started, unless their timeline carries on from
    // before the restart.
    pub fn observe(&self, machine: &str, snap: &Snapshot, now: DateTime<Local>) {
        let at = now.to_rfc3339();
        let first = self
            .watched
            .lock()
            .expect("insights lock")
            .insert(machine.to_string());
        let mut screens = self.screens.lock().expect("insights lock");
        let mut records = self.lock();
        let mut changed = false;
        let mut live = HashSet::new();
        for s in &snap.sessions {
            let id = s.id();
            live.insert(id.clone());
            let name = s.tmux.clone().unwrap_or_else(|| s.pid.to_string());
            let rec = records.entry(id.clone()).or_default();
            if rec.marks.is_empty() || rec.last_state() == Some(Kind::Ended) {
                *rec = Record {
                    machine: s.machine.clone(),
                    name,
                    ..Record::default()
                };
                rec.push(&at, if first { Kind::Seen } else { Kind::Started }, None);
                screens.remove(&id);
                changed = true;
            }
            if (&rec.agent, &rec.folder, &rec.branch) != (&s.agent, &s.folder, &s.branch) {
                rec.agent = s.agent.clone();
                rec.folder = s.folder.clone();
                rec.branch = s.branch.clone();
                changed = true;
            }
            let state = Kind::of(s.activity);
            if rec.last_state() != Some(state) {
                rec.push(&at, state, None);
                changed = true;
            }
            let shown = snap.runs.get(&id).map(Vec::as_slice).unwrap_or_default();
            let before: HashSet<String> = match screens.get(&id) {
                Some(seen) => seen.iter().cloned().collect(),
                None => rec.recent_runs().into_iter().map(str::to_string).collect(),
            };
            for run in shown.iter().filter(|r| !before.contains(&r.text)) {
                let kind = match run.kind {
                    RunKind::Tool => Kind::Tool,
                    RunKind::Test => Kind::Test,
                };
                rec.push(&at, kind, Some(run));
                changed = true;
            }
            screens.insert(id, shown.iter().map(|r| r.text.clone()).collect());
        }
        for (id, rec) in records.iter_mut() {
            if rec.machine == machine && !live.contains(id) && rec.last_state() != Some(Kind::Ended)
            {
                rec.push(&at, Kind::Ended, None);
                screens.remove(id);
                changed = true;
            }
        }
        while records.len() > MAX_SESSIONS {
            let Some(oldest) = records
                .iter()
                .filter(|(id, _)| !live.contains(*id))
                .min_by(|a, b| a.1.last_at().cmp(b.1.last_at()))
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            records.remove(&oldest);
            changed = true;
        }
        if changed {
            self.save(&records);
        }
    }

    fn save(&self, records: &BTreeMap<String, Record>) {
        let bytes = serde_json::to_vec(records).unwrap_or_default();
        if let Err(e) = crate::dispatch::write_private(&self.file, &bytes) {
            tracing::warn!(error = %e, "could not save {}", self.file.display());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Period {
    pub state: &'static str,
    pub from: String,
    // None while it lasts.
    pub to: Option<String>,
    pub seconds: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Totals {
    pub working: i64,
    pub waiting: i64,
    pub idle: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Timeline {
    pub machine: String,
    pub name: String,
    pub agent: String,
    pub folder: String,
    pub branch: String,
    // When Yardbell first saw it, and whether it saw it start or found it running.
    pub since: String,
    pub started: bool,
    pub ended: Option<String>,
    pub periods: Vec<Period>,
    pub totals: Totals,
    pub runs: Vec<Mark>,
    pub dropped: usize,
}

fn parse(at: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(at).ok()
}

fn seconds(from: &str, to: &str) -> i64 {
    match (parse(from), parse(to)) {
        (Some(a), Some(b)) => (b - a).num_seconds().max(0),
        _ => 0,
    }
}

impl Record {
    pub fn timeline(&self, now: DateTime<Local>) -> Timeline {
        let now = now.to_rfc3339();
        let mut periods: Vec<Period> = Vec::new();
        let mut ended = None;
        for m in self.marks.iter().filter(|m| m.kind.is_state()) {
            if let Some(open) = periods.last_mut().filter(|p| p.to.is_none()) {
                open.to = Some(m.at.clone());
            }
            match m.kind.word() {
                Some(state) => periods.push(Period {
                    state,
                    from: m.at.clone(),
                    to: None,
                    seconds: 0,
                }),
                None if m.kind == Kind::Ended => ended = Some(m.at.clone()),
                None => {}
            }
        }
        for p in periods.iter_mut() {
            p.seconds = seconds(&p.from, p.to.as_deref().unwrap_or(&now));
        }
        let periods = settled(periods);
        let mut totals = Totals::default();
        for p in &periods {
            match p.state {
                "working" => totals.working += p.seconds,
                "waiting" => totals.waiting += p.seconds,
                _ => totals.idle += p.seconds,
            }
        }
        let first = self.marks.first();
        Timeline {
            machine: self.machine.clone(),
            name: self.name.clone(),
            agent: self.agent.clone(),
            folder: self.folder.clone(),
            branch: self.branch.clone(),
            since: first.map(|m| m.at.clone()).unwrap_or_default(),
            started: first.is_some_and(|m| m.kind == Kind::Started),
            ended,
            periods,
            totals,
            runs: self
                .marks
                .iter()
                .filter(|m| !m.kind.is_state())
                .cloned()
                .collect(),
            dropped: self.dropped,
        }
    }
}

// Screen and CPU readings flicker: a few seconds of another state inside a long stretch are
// folded into it, so the timeline shows the stretches a person would name.
fn settled(periods: Vec<Period>) -> Vec<Period> {
    let mut out: Vec<Period> = Vec::new();
    let mut rest = periods.into_iter().peekable();
    while let Some(p) = rest.next() {
        let blip = p.to.is_some() && p.seconds < BLIP_SECS;
        let between = out
            .last()
            .is_some_and(|prev| blip && rest.peek().is_some_and(|next| next.state == prev.state));
        if between {
            let next = rest.next().expect("peeked");
            let prev = out.last_mut().expect("checked");
            prev.to = next.to;
            prev.seconds += p.seconds + next.seconds;
            continue;
        }
        match out.last_mut() {
            Some(prev) if prev.state == p.state => {
                prev.to = p.to;
                prev.seconds += p.seconds;
            }
            _ => out.push(p),
        }
    }
    out
}

pub struct Ask<'a> {
    pub machine: &'a str,
    pub name: &'a str,
    pub live: bool,
    pub task: &'a str,
    pub from: Option<(&'a str, u32)>,
    pub timeline: Option<&'a Timeline>,
}

fn minutes(secs: i64) -> String {
    match secs / 60 {
        0 => "under a minute".into(),
        1 => "1 minute".into(),
        n => format!("{n} minutes"),
    }
}

// The message "Suggest a better prompt" sends to Dispatch as a normal turn. The proposal comes
// back in a fenced block marked prompt, which the page offers to save as a task.
pub fn suggest_message(ask: &Ask) -> String {
    let mut parts = vec![format!(
        "Suggest a better prompt for the session {} on {}.",
        ask.name, ask.machine
    )];
    parts.push(if ask.live {
        "Read it with read_session, with lines 2000 to see as far back as its scrollback goes."
            .into()
    } else {
        "It has ended, so read_session cannot read it; work from what follows.".into()
    });
    parts.push(match ask.task.trim() {
        "" => "Yardbell does not know the task it started with, so work it out from its screen."
            .into(),
        task => format!("It started with this task:\n\n{task}\n"),
    });
    if let Some((name, version)) = ask.from {
        parts.push(format!(
            "That task came from my saved task \"{name}\", version {version}."
        ));
    }
    if let Some(t) = ask.timeline {
        let waits = t.periods.iter().filter(|p| p.state == "waiting").count();
        let failed = t.runs.iter().filter(|r| r.ok == Some(false)).count();
        let waited = match waits {
            0 => "never wait for an answer".to_string(),
            n => format!(
                "wait for an answer {n} time{} ({} in all)",
                if n == 1 { "" } else { "s" },
                minutes(t.totals.waiting)
            ),
        };
        let failing = match failed {
            0 => String::new(),
            1 => ", with 1 failing test run".to_string(),
            n => format!(", with {n} failing test runs"),
        };
        parts.push(format!(
            "Yardbell saw it work for {}, {waited} and sit idle for {}{failing}.",
            minutes(t.totals.working),
            minutes(t.totals.idle),
        ));
    }
    parts.push(
        "Look at where it got stuck, what it had to ask me, what it had to work out on its own and \
what it got wrong, then propose a clearer, more complete prompt that would have avoided that, \
written so I can reuse it for this kind of work. Change nothing and start nothing. End your reply \
with the proposed prompt alone in a fenced code block that starts with ```prompt."
            .into(),
    );
    parts.join("\n\n")
}
