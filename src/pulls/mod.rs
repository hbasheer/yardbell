mod github;
mod gitlab;
mod remote;

pub use github::GitHub;
pub use gitlab::{accesses, Answer, GitLab, GitLabAccess};
pub use remote::{Remotes, Repo};

use crate::config::{Config, Machine};
use crate::dispatch::Dispatch;
use crate::secrets::Secrets;
use crate::state::State;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_secs(5);
// A machine without gh, or with gh logged out, is asked again only this often.
const AWAY: Duration = Duration::from_secs(600);
const LOG_LINES: usize = 30;
const LOG_BYTES: usize = 3000;
const LOGS_PER_CARD: usize = 2;
const REVIEWS_PER_CARD: usize = 5;
const NOTES_PER_CARD: usize = 12;
const NOTE_CHARS: usize = 1200;
const QUOTE_CHARS: usize = 200;
const INSTRUCTION_CHARS: usize = 1200;
const SEEN_NOTES: usize = 500;
const SEEN_FAILURES: usize = 20;
const KEEP_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ci {
    #[default]
    None,
    Pending,
    Passing,
    Failing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub log: String,
}

// A comment, a review, or a review's comment on a line, by someone other than the pull request's
// author.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub kind: String,
    pub author: String,
    pub body: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub place: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pull {
    pub forge: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub review: String,
    pub ci: Ci,
    pub failed: Vec<Check>,
    pub head: String,
    pub author: String,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullView {
    pub forge: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub review: String,
    pub ci: Ci,
    #[serde(default)]
    pub failed: Vec<String>,
}

impl From<&Pull> for PullView {
    fn from(p: &Pull) -> PullView {
        PullView {
            forge: p.forge.clone(),
            number: p.number,
            url: p.url.clone(),
            title: p.title.clone(),
            state: p.state.clone(),
            draft: p.draft,
            review: p.review.clone(),
            ci: p.ci,
            failed: p.failed.iter().map(|c| c.name.clone()).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Fetched {
    Found(Box<Pull>),
    NoPull,
    NoTool,
    Failed(String),
}

// Where a branch's pull request lives. GitHub through gh is the only one so far.
pub trait Forge: Send + Sync {
    fn fetch<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, Fetched>;
    fn failure_log<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        check: &'a Check,
    ) -> BoxFuture<'a, String>;
    fn review_comments<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        review: &'a Note,
    ) -> BoxFuture<'a, Vec<Note>>;
}

pub type Key = (String, String, String);

// A branch checked out in a folder on a machine, and the tmux sessions working in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub machine: String,
    pub path: String,
    pub branch: String,
    pub sessions: Vec<String>,
}

impl Target {
    fn key(&self) -> Key {
        (self.machine.clone(), self.path.clone(), self.branch.clone())
    }
}

pub fn targets(cfg: &Config, state: &State) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    for m in &cfg.machines {
        if !state.status(&m.name).is_some_and(|s| s.up) {
            continue;
        }
        let Some(snap) = state.snapshot(&m.name) else {
            continue;
        };
        for s in &snap.sessions {
            let Some(path) = snap.folder_paths.get(&s.folder) else {
                continue;
            };
            if s.branch.is_empty() {
                continue;
            }
            let i = match out
                .iter()
                .position(|t| t.machine == m.name && t.path == *path && t.branch == s.branch)
            {
                Some(i) => i,
                None => {
                    out.push(Target {
                        machine: m.name.clone(),
                        path: path.clone(),
                        branch: s.branch.clone(),
                        sessions: Vec::new(),
                    });
                    out.len() - 1
                }
            };
            if let Some(name) = &s.tmux {
                out[i].sessions.push(name.clone());
                out[i].sessions.sort();
            }
        }
    }
    out
}

// What has been seen of one pull request, kept across restarts so nothing is posted twice.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Seen {
    #[serde(default)]
    pub ci: Ci,
    #[serde(default)]
    pub failures: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub day: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Failed(Vec<Check>),
    Reviewed(Vec<Note>),
}

fn failure_of(pull: &Pull) -> String {
    if !pull.head.is_empty() {
        return pull.head.clone();
    }
    pull.failed
        .iter()
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

fn keep_last(list: &mut Vec<String>, most: usize) {
    if list.len() > most {
        list.drain(..list.len() - most);
    }
}

// The first sighting only sets what is known: a pull request found already failing, or with
// comments, says nothing. After that a failing commit is reported once, and so is each comment or
// review, while the pull request is open.
pub fn observe(seen: Option<&Seen>, pull: &Pull, day: &str) -> (Seen, Vec<Change>) {
    let failure = failure_of(pull);
    let Some(seen) = seen else {
        let next = Seen {
            ci: pull.ci,
            failures: if pull.ci == Ci::Failing {
                vec![failure]
            } else {
                Vec::new()
            },
            notes: pull.notes.iter().map(|n| n.id.clone()).collect(),
            day: day.to_string(),
        };
        return (next, Vec::new());
    };
    let open = pull.state == "open";
    let mut next = seen.clone();
    next.ci = pull.ci;
    next.day = day.to_string();
    let mut changes = Vec::new();
    if pull.ci == Ci::Failing && !seen.failures.contains(&failure) {
        next.failures.push(failure);
        keep_last(&mut next.failures, SEEN_FAILURES);
        if open {
            changes.push(Change::Failed(pull.failed.clone()));
        }
    }
    let new: Vec<Note> = pull
        .notes
        .iter()
        .filter(|n| !seen.notes.contains(&n.id))
        .cloned()
        .collect();
    if !new.is_empty() {
        next.notes.extend(new.iter().map(|n| n.id.clone()));
        keep_last(&mut next.notes, SEEN_NOTES);
        if open {
            changes.push(Change::Reviewed(new));
        }
    }
    (next, changes)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub machine: String,
    pub session: String,
    pub path: String,
    pub branch: String,
    pub pull: Pull,
    pub change: Change,
}

fn last_lines(lines: &[String], count: usize, bytes: usize) -> String {
    let text = lines[lines.len().saturating_sub(count)..].join("\n");
    if text.len() <= bytes {
        return text;
    }
    let mut cut = text.len() - bytes;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    let rest = &text[cut..];
    rest.split_once('\n')
        .map_or(rest, |(_, after)| after)
        .to_string()
}

fn clip(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(chars).collect();
    cut.push('…');
    cut
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// The line most likely to say what broke: the last one that mentions an error or a failure,
// other than the runner's own closing line.
pub fn telling_line(log: &str) -> String {
    let lines: Vec<&str> = log
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let said = |l: &&&str| {
        let low = l.to_ascii_lowercase();
        ["error", "fail", "panic", "assert"]
            .iter()
            .any(|w| low.contains(w))
            && !low.starts_with("process completed with exit code")
            && !low.starts_with("error: job failed: exit code")
    };
    lines
        .iter()
        .rev()
        .find(said)
        .or(lines.last())
        .map(|l| clip(l, QUOTE_CHARS))
        .unwrap_or_default()
}

fn what_failed(checks: &[Check]) -> String {
    let names: Vec<&str> = checks.iter().map(|c| c.name.as_str()).collect();
    match names.as_slice() {
        [] => "a check".into(),
        [one] => one.to_string(),
        [first, second] => format!("{first} and {second}"),
        [first, second, rest @ ..] => {
            format!("{first}, {second} and {} more", rest.len())
        }
    }
}

fn kind(p: &Pull) -> &'static str {
    if p.forge == "gitlab" {
        "merge request"
    } else {
        "pull request"
    }
}

pub fn noun(p: &Pull) -> String {
    let mark = if p.forge == "gitlab" { '!' } else { '#' };
    format!("{} {mark}{}", kind(p), p.number)
}

pub fn ci_instruction(pull: &Pull, checks: &[Check]) -> String {
    let line = checks
        .iter()
        .map(|c| telling_line(&c.log))
        .find(|l| !l.is_empty());
    let said = line.map(|l| format!(": {l}")).unwrap_or_default();
    format!(
        "CI failed on {} for {}{said}. Fix it and push.",
        what_failed(checks),
        noun(pull)
    )
}

fn said_by(n: &Note) -> String {
    let who = if n.author.is_empty() {
        "A reviewer"
    } else {
        &n.author
    };
    match n.kind.as_str() {
        "changes_requested" => format!("{who} requested changes"),
        "inline" if !n.place.is_empty() => format!("{who} on {}", n.place),
        _ => who.to_string(),
    }
}

pub fn review_instruction(pull: &Pull, notes: &[Note]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut used = 0;
    for n in notes {
        let body = clip(&one_line(&n.body), QUOTE_CHARS);
        let part = if body.is_empty() {
            format!("{}.", said_by(n))
        } else {
            format!("{}: \"{body}\"", said_by(n))
        };
        if used + part.len() > INSTRUCTION_CHARS {
            break;
        }
        used += part.len();
        parts.push(part);
    }
    let left = notes.len() - parts.len();
    let more = if left > 0 {
        format!(" And {left} more on the {}.", kind(pull))
    } else {
        String::new()
    };
    format!(
        "New review comments on {}. {}{more} Address them and push.",
        noun(pull),
        parts.join(" ")
    )
}

fn card_key(n: &Notice) -> String {
    match &n.change {
        Change::Failed(_) => format!("ci:{}:{}", n.pull.url, failure_of(&n.pull)),
        Change::Reviewed(notes) => format!(
            "review:{}:{}",
            n.pull.url,
            notes.first().map(|n| n.id.as_str()).unwrap_or_default()
        ),
    }
}

pub fn card(n: &Notice, checks: &[Check], notes: &[Note]) -> Value {
    let (kind, instruction) = match &n.change {
        Change::Failed(_) => ("ci", ci_instruction(&n.pull, checks)),
        Change::Reviewed(_) => ("review", review_instruction(&n.pull, notes)),
    };
    let more = notes.len().saturating_sub(NOTES_PER_CARD);
    let notes: Vec<Note> = notes
        .iter()
        .take(NOTES_PER_CARD)
        .map(|note| Note {
            body: clip(note.body.trim(), NOTE_CHARS),
            ..note.clone()
        })
        .collect();
    json!({
        "role": "pull",
        "kind": kind,
        "key": card_key(n),
        "machine": n.machine,
        "name": n.session,
        "path": n.path,
        "branch": n.branch,
        "pull": PullView::from(&n.pull),
        "checks": checks,
        "notes": notes,
        "more": more,
        "instruction": instruction,
        "at": chrono::Local::now().to_rfc3339(),
    })
}

struct Entry {
    next: Instant,
    pull: Option<Pull>,
    host: Option<String>,
}

// gh missing or logged out is a machine's problem; a refused token is a GitLab host's.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Away {
    Machine(String),
    Host(String),
}

enum Got {
    Fetched(Fetched),
    Refused(String, String),
}

#[derive(Default)]
struct Inner {
    entries: HashMap<Key, Entry>,
    away: HashMap<Away, Instant>,
    seen: BTreeMap<String, Seen>,
    remotes: HashMap<Key, (Instant, Option<Repo>)>,
}

pub struct Pulls {
    github: Arc<dyn Forge>,
    gitlab: Arc<GitLab>,
    remotes: Remotes,
    file: PathBuf,
    inner: Mutex<Inner>,
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

impl Pulls {
    pub fn new(
        github: Arc<dyn Forge>,
        gitlab: Arc<GitLab>,
        remotes: Remotes,
        file: PathBuf,
    ) -> Pulls {
        let seen = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Pulls {
            github,
            gitlab,
            remotes,
            file,
            inner: Mutex::new(Inner {
                seen,
                ..Inner::default()
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("pulls lock")
    }

    fn save(&self) {
        let oldest = (chrono::Local::now() - chrono::Duration::days(KEEP_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        let bytes = {
            let mut inner = self.lock();
            inner.seen.retain(|_, s| s.day >= oldest);
            serde_json::to_vec(&inner.seen).unwrap_or_default()
        };
        let tmp = self.file.with_extension("tmp");
        let written = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = written {
            tracing::warn!(error = %e, "could not save {}", self.file.display());
        }
    }

    pub fn views(&self) -> HashMap<Key, PullView> {
        self.lock()
            .entries
            .iter()
            .filter_map(|(k, e)| e.pull.as_ref().map(|p| (k.clone(), PullView::from(p))))
            .collect()
    }

    fn forget(&self) {
        let mut inner = self.lock();
        inner.entries.clear();
        inner.away.clear();
        inner.remotes.clear();
    }

    fn is_away(&self, away: &Away) -> bool {
        self.lock().away.contains_key(away)
    }

    async fn repo(&self, m: &Machine, t: &Target, now: Instant) -> Option<Repo> {
        if let Some((until, repo)) = self.lock().remotes.get(&t.key()) {
            if *until > now {
                return repo.clone();
            }
        }
        let repo = self.remotes.read(m, &t.path, &t.branch).await;
        self.lock()
            .remotes
            .insert(t.key(), (now + AWAY, repo.clone()));
        repo
    }

    // Only a host listed under pull_requests.gitlab goes to GitLab, so without one no remote is
    // read and GitHub is asked exactly as before.
    async fn on_gitlab<'a>(
        &self,
        m: &Machine,
        t: &Target,
        hosts: &'a [GitLabAccess],
        now: Instant,
    ) -> Option<(&'a GitLabAccess, Repo)> {
        if hosts.is_empty() {
            return None;
        }
        let repo = self.repo(m, t, now).await?;
        let access = hosts.iter().find(|a| a.host == repo.host)?;
        Some((access, repo))
    }

    fn gitlab_place<'a>(
        &self,
        n: &Notice,
        hosts: &'a [GitLabAccess],
    ) -> Option<(&'a GitLabAccess, String)> {
        let key = (n.machine.clone(), n.path.clone(), n.branch.clone());
        let repo = self.lock().remotes.get(&key)?.1.clone()?;
        let access = hosts.iter().find(|a| a.host == repo.host)?;
        Some((access, repo.project))
    }

    // Each branch is asked about at most once per poll interval, the branches of one machine one
    // after the other, and the machines at the same time.
    pub async fn poll(
        &self,
        cfg: &Config,
        hosts: &[GitLabAccess],
        targets: &[Target],
        now: Instant,
    ) -> Vec<Notice> {
        let every = Duration::from_secs(cfg.pull_requests.poll_seconds);
        let due: Vec<&Target> = {
            let mut inner = self.lock();
            let live: HashSet<Key> = targets.iter().map(Target::key).collect();
            inner.entries.retain(|k, _| live.contains(k));
            inner.remotes.retain(|k, _| live.contains(k));
            inner.away.retain(|_, until| *until > now);
            let inner = &*inner;
            targets
                .iter()
                .filter(|t| inner.entries.get(&t.key()).is_none_or(|e| e.next <= now))
                .collect()
        };
        let mut by_machine: BTreeMap<&str, Vec<&Target>> = BTreeMap::new();
        for t in due {
            by_machine.entry(&t.machine).or_default().push(t);
        }
        let fetched =
            futures::future::join_all(by_machine.into_iter().map(|(name, list)| async move {
                let Some(m) = cfg.machine(name) else {
                    return Vec::new();
                };
                let mut out = Vec::new();
                let mut no_gh = self.is_away(&Away::Machine(m.name.clone()));
                let mut refused: HashSet<String> = HashSet::new();
                for t in list {
                    match self.on_gitlab(m, t, hosts, now).await {
                        Some((access, repo)) => {
                            let host = access.host.clone();
                            if refused.contains(&host) || self.is_away(&Away::Host(host.clone())) {
                                continue;
                            }
                            let got =
                                match self.gitlab.fetch(access, &repo.project, &t.branch).await {
                                    Answer::Pull(pull) => Got::Fetched(Fetched::Found(pull)),
                                    Answer::NoPull => Got::Fetched(Fetched::NoPull),
                                    Answer::Failed(why) => Got::Fetched(Fetched::Failed(why)),
                                    Answer::Refused(why) => {
                                        refused.insert(host.clone());
                                        Got::Refused(host.clone(), why)
                                    }
                                };
                            out.push((t, Some(host), got));
                        }
                        None => {
                            if no_gh {
                                continue;
                            }
                            let got = self.github.fetch(m, &t.path, &t.branch).await;
                            no_gh = got == Fetched::NoTool;
                            out.push((t, None, Got::Fetched(got)));
                        }
                    }
                }
                out
            }))
            .await;
        let day = today();
        let mut notices = Vec::new();
        let mut changed = false;
        {
            let mut inner = self.lock();
            for (t, host, got) in fetched.into_iter().flatten() {
                let (next, pull) = match got {
                    Got::Fetched(Fetched::Found(pull)) => (now + every, Some(*pull)),
                    Got::Fetched(Fetched::NoPull) => (now + every, None),
                    Got::Fetched(Fetched::NoTool) => {
                        inner
                            .away
                            .insert(Away::Machine(t.machine.clone()), now + AWAY);
                        for (k, e) in inner.entries.iter_mut() {
                            if k.0 == t.machine && e.host.is_none() {
                                e.pull = None;
                            }
                        }
                        (now + AWAY, None)
                    }
                    Got::Fetched(Fetched::Failed(why)) => {
                        tracing::debug!(machine = %t.machine, branch = %t.branch, "no pull request status: {why}");
                        (now + AWAY, None)
                    }
                    Got::Refused(refused, why) => {
                        let first = inner
                            .away
                            .insert(Away::Host(refused.clone()), now + AWAY)
                            .is_none();
                        if first {
                            tracing::warn!(
                                "no merge requests from {refused} for 10 minutes: {why}"
                            );
                        }
                        for e in inner.entries.values_mut() {
                            if e.host.as_deref() == Some(refused.as_str()) {
                                e.pull = None;
                            }
                        }
                        (now + AWAY, None)
                    }
                };
                if let Some(p) = &pull {
                    let before = inner.seen.get(&p.url);
                    let (seen, changes) = observe(before, p, &day);
                    if before != Some(&seen) {
                        changed = true;
                        inner.seen.insert(p.url.clone(), seen);
                    }
                    if let Some(session) = t.sessions.first() {
                        notices.extend(changes.into_iter().map(|change| Notice {
                            machine: t.machine.clone(),
                            session: session.clone(),
                            path: t.path.clone(),
                            branch: t.branch.clone(),
                            pull: p.clone(),
                            change,
                        }));
                    }
                }
                inner.entries.insert(t.key(), Entry { next, pull, host });
            }
        }
        if changed {
            self.save();
        }
        notices
    }

    // The failed log, or a review's comments on lines, are asked for only when a card is made.
    pub async fn card(&self, m: &Machine, n: &Notice, hosts: &[GitLabAccess]) -> Value {
        let gitlab = n.pull.forge == "gitlab";
        match &n.change {
            Change::Failed(checks) => {
                let mut with_logs = checks.clone();
                let place = self.gitlab_place(n, hosts);
                for c in with_logs.iter_mut().take(LOGS_PER_CARD) {
                    c.log = match (&place, gitlab) {
                        (Some((access, project)), _) => {
                            self.gitlab.failure_log(access, project, c).await
                        }
                        (None, true) => String::new(),
                        (None, false) => self.github.failure_log(m, &n.path, c).await,
                    };
                }
                card(n, &with_logs, &[])
            }
            Change::Reviewed(notes) => {
                let mut all = Vec::new();
                let mut asked = 0;
                for note in notes {
                    let review = note.kind != "comment";
                    if !review || !note.body.trim().is_empty() {
                        all.push(note.clone());
                    }
                    if review && !gitlab && asked < REVIEWS_PER_CARD {
                        asked += 1;
                        all.extend(self.github.review_comments(m, &n.path, note).await);
                    }
                }
                if all.is_empty() {
                    all = notes.clone();
                }
                card(n, &[], &all)
            }
        }
    }

    pub async fn round(
        &self,
        cfg: &Config,
        secrets: &Result<Secrets, String>,
        state: &State,
        dispatch: &Dispatch,
        now: Instant,
    ) {
        if !cfg.pull_requests.enabled {
            self.forget();
            state.set_pulls(HashMap::new());
            return;
        }
        let hosts = accesses(&cfg.pull_requests, secrets);
        let notices = self.poll(cfg, &hosts, &targets(cfg, state), now).await;
        state.set_pulls(self.views());
        if !cfg.pull_requests.cards {
            return;
        }
        for n in notices {
            let Some(m) = cfg.machine(&n.machine) else {
                continue;
            };
            let card = self.card(m, &n, &hosts).await;
            let named = noun(&n.pull);
            let title = format!(
                "{}{}: {}",
                named[..1].to_uppercase(),
                &named[1..],
                n.pull.title
            );
            if dispatch
                .post_pull(&n.machine, &n.session, &n.path, &title, card)
                .is_some()
            {
                state.touch();
            }
        }
    }

    pub fn start(
        self: Arc<Self>,
        cfg_path: PathBuf,
        state: State,
        dispatch: Arc<Dispatch>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut every = tokio::time::interval(TICK);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                match Config::load(&cfg_path) {
                    Ok(cfg) => {
                        let secrets = if cfg.pull_requests.gitlab.is_empty() {
                            Err(String::new())
                        } else {
                            Secrets::for_config(&cfg_path).map_err(|e| e.to_string())
                        };
                        self.round(&cfg, &secrets, &state, &dispatch, Instant::now())
                            .await
                    }
                    Err(e) => tracing::debug!(error = %e, "pull requests not checked"),
                }
            }
        })
    }
}

#[cfg(test)]
mod tests;
