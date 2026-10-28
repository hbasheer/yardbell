use super::{Check, Ci, Fetched, Forge, Note, Pull};
use crate::config::Machine;
use crate::shell::{quote, Duration, Output, Runner};
use crate::ssh::Ssh;
use futures::future::BoxFuture;
use regex::Regex;
use serde::Deserialize;
use std::sync::{Arc, OnceLock};

const FIELDS: &str = "number,url,title,state,isDraft,reviewDecision,headRefOid,author,statusCheckRollup,comments,reviews";
const VIEW_TIMEOUT: Duration = Duration::from_secs(20);
const LOG_TIMEOUT: Duration = Duration::from_secs(30);
const NO_GH: i32 = 127;
const NOT_LOGGED_IN: i32 = 4;
const LOG_TAIL: usize = 400;
const INLINE_MAX: usize = 20;

// gh must never wait for an answer or a pager, and its colors and update notices are noise.
const QUIET: &str = "GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat NO_COLOR=1; \
export GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER GH_PAGER NO_COLOR; ";

pub struct GitHub {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
}

impl GitHub {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> GitHub {
        GitHub { runner, ssh }
    }

    async fn gh(&self, m: &Machine, path: &str, cmd: &str, timeout: Duration) -> Output {
        self.runner
            .run(self.ssh.command(m, &in_folder(path, cmd)), None, timeout)
            .await
    }
}

fn in_folder(path: &str, cmd: &str) -> String {
    format!(
        "{QUIET}cd {} 2>/dev/null || exit 1; command -v gh >/dev/null 2>&1 || exit {NO_GH}; {cmd}",
        quote(path)
    )
}

pub fn view_command(branch: &str) -> String {
    format!("gh pr view {} --json {FIELDS}", quote(branch))
}

impl Forge for GitHub {
    fn fetch<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, Fetched> {
        Box::pin(async move {
            let out = self.gh(m, path, &view_command(branch), VIEW_TIMEOUT).await;
            classify(&out)
        })
    }

    fn failure_log<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        check: &'a Check,
    ) -> BoxFuture<'a, String> {
        Box::pin(async move {
            let Some(cmd) = log_command(&check.url) else {
                return String::new();
            };
            let out = self.gh(m, path, &cmd, LOG_TIMEOUT).await;
            if !out.ok() {
                return String::new();
            }
            excerpt(&out.stdout)
        })
    }

    fn review_comments<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        review: &'a Note,
    ) -> BoxFuture<'a, Vec<Note>> {
        Box::pin(async move {
            let out = self
                .gh(m, path, &review_comments_command(&review.id), VIEW_TIMEOUT)
                .await;
            if !out.ok() {
                return Vec::new();
            }
            parse_review_comments(&out.stdout, &review.author)
        })
    }
}

pub fn classify(out: &Output) -> Fetched {
    if out.timed_out {
        return Fetched::Failed("gh timed out".into());
    }
    match out.status {
        Some(0) => match parse_view(&out.stdout) {
            Ok(pull) => Fetched::Found(Box::new(pull)),
            Err(e) => Fetched::Failed(format!("unexpected gh output: {e}")),
        },
        Some(NO_GH) | Some(NOT_LOGGED_IN) => Fetched::NoTool,
        _ if out.stderr.contains("no pull requests found") => Fetched::NoPull,
        _ => Fetched::Failed(
            out.stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("gh failed")
                .to_string(),
        ),
    }
}

#[derive(Deserialize)]
struct Login {
    #[serde(default)]
    login: Option<String>,
}

fn login(author: &Option<Login>) -> String {
    author
        .as_ref()
        .and_then(|a| a.login.clone())
        .unwrap_or_default()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCheck {
    #[serde(rename = "__typename", default)]
    typename: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    workflow_name: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    details_url: Option<String>,
    #[serde(default)]
    target_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    author: Option<Login>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    viewer_did_author: bool,
    #[serde(default)]
    is_minimized: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    author: Option<Login>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPull {
    number: u64,
    url: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    head_ref_oid: Option<String>,
    #[serde(default)]
    author: Option<Login>,
    #[serde(default)]
    status_check_rollup: Option<Vec<RawCheck>>,
    #[serde(default)]
    comments: Option<Vec<RawComment>>,
    #[serde(default)]
    reviews: Option<Vec<RawReview>>,
}

#[derive(PartialEq)]
enum Outcome {
    Pass,
    Pending,
    Fail,
}

// A cancelled or stale run is usually one a newer push replaced, and a run waiting for a
// maintainer's approval is nothing the agent can fix, so neither counts as a failure.
fn outcome(c: &RawCheck) -> Outcome {
    let word = |v: &Option<String>| v.as_deref().unwrap_or_default().to_ascii_uppercase();
    if c.typename.as_deref() == Some("StatusContext") || c.context.is_some() {
        return match word(&c.state).as_str() {
            "FAILURE" | "ERROR" => Outcome::Fail,
            "PENDING" | "EXPECTED" | "" => Outcome::Pending,
            _ => Outcome::Pass,
        };
    }
    if word(&c.status) != "COMPLETED" {
        return Outcome::Pending;
    }
    match word(&c.conclusion).as_str() {
        "FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" => Outcome::Fail,
        _ => Outcome::Pass,
    }
}

fn check_name(c: &RawCheck) -> String {
    let name = c.name.clone().or(c.context.clone()).unwrap_or_default();
    match c.workflow_name.as_deref() {
        Some(flow) if !flow.is_empty() && flow != name => format!("{flow} / {name}"),
        _ => name,
    }
}

pub fn parse_view(json: &str) -> Result<Pull, String> {
    let raw: RawPull = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let author = login(&raw.author);
    let checks = raw.status_check_rollup.unwrap_or_default();
    let outcomes: Vec<Outcome> = checks.iter().map(outcome).collect();
    let ci = if outcomes.is_empty() {
        Ci::None
    } else if outcomes.contains(&Outcome::Fail) {
        Ci::Failing
    } else if outcomes.contains(&Outcome::Pending) {
        Ci::Pending
    } else {
        Ci::Passing
    };
    let failed = checks
        .iter()
        .zip(&outcomes)
        .filter(|(_, o)| **o == Outcome::Fail)
        .map(|(c, _)| Check {
            name: check_name(c),
            url: c
                .details_url
                .clone()
                .or(c.target_url.clone())
                .unwrap_or_default(),
            log: String::new(),
        })
        .collect();
    let theirs = |who: &str| !who.is_empty() && who != author;
    let mut notes = Vec::new();
    for c in raw.comments.unwrap_or_default() {
        let who = login(&c.author);
        if c.viewer_did_author || c.is_minimized || !theirs(&who) {
            continue;
        }
        let Some(id) = c.id.filter(|id| !id.is_empty()) else {
            continue;
        };
        notes.push(Note {
            id,
            kind: "comment".into(),
            author: who,
            body: c.body.unwrap_or_default(),
            url: c.url.unwrap_or_else(|| raw.url.clone()),
            place: String::new(),
        });
    }
    for r in raw.reviews.unwrap_or_default() {
        let who = login(&r.author);
        let kind = match r.state.as_deref().unwrap_or_default() {
            "CHANGES_REQUESTED" => "changes_requested",
            "COMMENTED" => "review",
            _ => continue,
        };
        let Some(id) = r.id.filter(|id| !id.is_empty()) else {
            continue;
        };
        if !theirs(&who) {
            continue;
        }
        notes.push(Note {
            id,
            kind: kind.into(),
            author: who,
            body: r.body.unwrap_or_default(),
            url: raw.url.clone(),
            place: String::new(),
        });
    }
    Ok(Pull {
        forge: "github".into(),
        number: raw.number,
        title: raw.title.unwrap_or_default(),
        state: raw.state.unwrap_or_default().to_ascii_lowercase(),
        draft: raw.is_draft,
        review: raw.review_decision.unwrap_or_default().to_ascii_lowercase(),
        ci,
        failed,
        head: raw.head_ref_oid.unwrap_or_default(),
        author,
        notes,
        url: raw.url,
    })
}

fn actions_url() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/actions/runs/(\d+)(?:/jobs?/(\d+))?").expect("static regex"))
}

// Only GitHub Actions keeps its logs where gh can read them; other CI services link elsewhere.
pub fn log_command(url: &str) -> Option<String> {
    let found = actions_url().captures(url)?;
    let target = match found.get(2) {
        Some(job) => format!("--job {}", job.as_str()),
        None => found[1].to_string(),
    };
    Some(format!(
        "gh run view {target} --log-failed 2>/dev/null | tail -n {LOG_TAIL}"
    ))
}

fn noise() -> &'static (Regex, Regex) {
    static RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    RE.get_or_init(|| {
        (
            Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("static regex"),
            Regex::new(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ?").expect("static regex"),
        )
    })
}

// gh prints each line of a failed step as job, step and the line, each line stamped with the
// time, and the log can open with a byte order mark. Only the line is worth reading.
pub fn excerpt(log: &str) -> String {
    let (ansi, stamp) = noise();
    let lines: Vec<String> = log
        .lines()
        .map(|l| l.rsplit('\t').next().unwrap_or(l))
        .map(|l| l.trim_start_matches('\u{feff}'))
        .map(|l| ansi.replace_all(l, "").to_string())
        .map(|l| stamp.replace(&l, "").trim_end().to_string())
        .filter(|l| !l.trim().is_empty())
        .filter(|l| !l.starts_with("##[group]") && !l.starts_with("##[endgroup]"))
        .map(|l| l.strip_prefix("##[error]").map(str::to_string).unwrap_or(l))
        .collect();
    super::last_lines(&lines, super::LOG_LINES, super::LOG_BYTES)
}

pub fn review_comments_command(review: &str) -> String {
    let query = format!(
        "query($id: ID!) {{ node(id: $id) {{ ... on PullRequestReview {{ comments(first: {INLINE_MAX}) {{ nodes {{ id path line originalLine body url author {{ login }} }} }} }} }} }}"
    );
    format!(
        "gh api graphql -f query={} -f id={}",
        quote(&query),
        quote(review)
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInline {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u64>,
    #[serde(default)]
    original_line: Option<u64>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    author: Option<Login>,
}

pub fn parse_review_comments(json: &str, reviewer: &str) -> Vec<Note> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let nodes = value["data"]["node"]["comments"]["nodes"].clone();
    let Ok(raw) = serde_json::from_value::<Vec<RawInline>>(nodes) else {
        return Vec::new();
    };
    raw.into_iter()
        .filter_map(|c| {
            let path = c.path.unwrap_or_default();
            let place = match c.line.or(c.original_line) {
                Some(line) if !path.is_empty() => format!("{path}:{line}"),
                _ => path,
            };
            let author = login(&c.author);
            Some(Note {
                id: c.id?,
                kind: "inline".into(),
                author: if author.is_empty() {
                    reviewer.to_string()
                } else {
                    author
                },
                body: c.body.unwrap_or_default(),
                url: c.url.unwrap_or_default(),
                place,
            })
        })
        .collect()
}
