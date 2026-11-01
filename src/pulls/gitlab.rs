use super::{
    last_lines, Check, Ci, Note, Pull, Unsettled, UnsettledCheck, LOG_BYTES, LOG_LINES, SEEN_NOTES,
};
use crate::config::PullRequests;
use crate::secrets::Secrets;
use crate::shell::{quote, Runner};
use crate::ssh::Ssh;
use regex::Regex;
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
const PAGE: &str = "100";
const PAGES: u32 = 5;
// Enough for the excerpt's last lines; a job log can run to many megabytes.
const TRACE_KEEP: usize = 256 * 1024;

#[derive(Clone)]
pub struct GitLabAccess {
    pub host: String,
    pub api: String,
    pub secret: String,
    pub token: Result<String, String>,
    pub glab: bool,
    pub machine: Option<crate::config::Machine>,
}

impl std::fmt::Debug for GitLabAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let token = match &self.token {
            Ok(_) => "Ok(<hidden>)".to_string(),
            Err(e) => format!("Err({e:?})"),
        };
        f.debug_struct("GitLabAccess")
            .field("host", &self.host)
            .field("api", &self.api)
            .field("secret", &self.secret)
            .field("token", &token)
            .field("glab", &self.glab)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mr {
    pub url: String,
    pub iid: u64,
    pub title: String,
    pub source_branch: String,
    pub project: String,
}

pub fn accesses_for(
    cfg: &crate::config::Config,
    secrets: &Result<Secrets, String>,
) -> Vec<GitLabAccess> {
    let here = cfg
        .machines
        .iter()
        .find(|m| m.is_local())
        .or(cfg.machines.first());
    let glab = cfg.pull_requests.gitlab_via == crate::config::GitlabVia::Glab;
    let mut list = accesses(&cfg.pull_requests, secrets);
    for access in &mut list {
        access.glab = glab;
        access.machine = here.cloned();
        if glab {
            access.token = Ok(String::new());
        }
    }
    list
}

pub fn accesses(cfg: &PullRequests, secrets: &Result<Secrets, String>) -> Vec<GitLabAccess> {
    cfg.gitlab
        .iter()
        .map(|g| {
            let named = crate::secrets::references(&g.token).unwrap_or_default();
            let token = if named.is_empty() {
                Ok(g.token.clone())
            } else {
                match secrets {
                    Ok(s) => s.resolve(&g.token).map_err(|e| e.to_string()),
                    Err(e) => Err(e.clone()),
                }
            };
            GitLabAccess {
                host: g.host.trim().to_ascii_lowercase(),
                api: g.api(),
                secret: named.first().map(|n| n.to_string()).unwrap_or_default(),
                token,
                glab: false,
                machine: None,
            }
        })
        .collect()
}

#[derive(Debug)]
pub enum Answer {
    Pull(Box<Pull>),
    // The merge request without its comments, which could not all be read this time.
    Partial(Box<Pull>),
    NoPull,
    Refused(String),
    Failed(String),
}

// A 401 means the token itself is refused, for every project on the host; a 403 only that this
// token may not read one thing, such as one project or its jobs.
pub(crate) enum Problem {
    Refused(String),
    Forbidden,
    NotFound,
    Failed(String),
}

impl From<Problem> for Answer {
    fn from(p: Problem) -> Answer {
        match p {
            Problem::Refused(m) => Answer::Refused(m),
            Problem::Failed(m) => Answer::Failed(m),
            Problem::Forbidden => Answer::Failed("GitLab answered 403".into()),
            Problem::NotFound => Answer::Failed("GitLab answered 404".into()),
        }
    }
}

fn the_token(access: &GitLabAccess) -> String {
    if access.glab {
        "the glab login".into()
    } else if access.secret.is_empty() {
        "its token".into()
    } else {
        format!("the token in secret {}", access.secret)
    }
}

const NO_GLAB: i32 = 127;
const GLAB_TIMEOUT: crate::shell::Duration = crate::shell::Duration::from_secs(30);

fn endpoint(segments: &[&str], query: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://glab.invalid/").expect("a static address");
    url.path_segments_mut()
        .expect("a static address")
        .pop_if_empty()
        .extend(segments);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    let path = url.path().trim_start_matches('/');
    match url.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.to_string(),
    }
}

pub(crate) async fn run_glab(
    runner: &dyn Runner,
    ssh: &Ssh,
    m: &crate::config::Machine,
    host: &str,
    endpoint: &str,
    post: &[(&str, &str)],
) -> crate::shell::Output {
    let mut cmd = format!(
        "GLAB_CHECK_UPDATE=false NO_COLOR=1 NO_PROMPT=1; export GLAB_CHECK_UPDATE NO_COLOR NO_PROMPT; command -v glab >/dev/null 2>&1 || exit {NO_GLAB}; glab api --hostname {} {}",
        quote(host),
        quote(endpoint)
    );
    if !post.is_empty() {
        cmd.push_str(" --method POST");
        for (key, value) in post {
            cmd.push_str(&format!(
                " --raw-field {}",
                quote(&format!("{key}={value}"))
            ));
        }
    }
    runner.run(ssh.command(m, &cmd), None, GLAB_TIMEOUT).await
}

pub(crate) fn glab_problem(
    status: Option<i32>,
    stderr: &str,
    host: &str,
    machine: &str,
) -> Problem {
    if status == Some(NO_GLAB) {
        return Problem::Refused(format!("glab is not installed on {machine}"));
    }
    let answered = |code: &str| stderr.contains(&format!("HTTP {code}"));
    if answered("401") {
        return Problem::Refused(format!(
            "glab is not signed in to {host} on {machine}. Run glab auth login there"
        ));
    }
    if answered("403") {
        return Problem::Forbidden;
    }
    if answered("404") {
        return Problem::NotFound;
    }
    let said = stderr.lines().next().unwrap_or("no reason given").trim();
    Problem::Failed(format!("glab failed on {machine}: {said}"))
}

pub(crate) fn glab_error(status: Option<i32>, stderr: &str, host: &str, machine: &str) -> String {
    match glab_problem(status, stderr, host, machine) {
        Problem::Refused(said) | Problem::Failed(said) => said,
        Problem::Forbidden => format!("the glab login on {machine} cannot do this on {host}"),
        Problem::NotFound => format!(
            "{host} does not have this project, or the glab login on {machine} cannot see it"
        ),
    }
}

fn refused(access: &GitLabAccess) -> String {
    format!("GitLab at {} refused {}", access.host, the_token(access))
}

fn forbidden(access: &GitLabAccess, what: &str) -> String {
    format!(
        "GitLab at {} does not let {} read {what}",
        access.host,
        the_token(access)
    )
}

// reqwest's own message is only "error sending request"; the reason (a name that does not resolve,
// a refused connection, a certificate) is in its sources.
fn unanswered(host: &str, e: reqwest::Error) -> Problem {
    let e = e.without_url();
    let mut said = vec![e.to_string()];
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        let text = s.to_string();
        if !said.contains(&text) {
            said.push(text);
        }
        source = s.source();
    }
    Problem::Failed(format!("{host} did not answer: {}", said.join(": ")))
}

fn unreadable(e: String) -> Problem {
    Problem::Failed(format!("unexpected GitLab answer: {e}"))
}

pub struct GitLab {
    http: reqwest::Client,
    me: Mutex<HashMap<String, String>>,
    runner: Option<(Arc<dyn Runner>, Ssh)>,
}

impl Default for GitLab {
    fn default() -> GitLab {
        GitLab::new()
    }
}

impl GitLabAccess {
    pub fn on(&self, m: &crate::config::Machine) -> GitLabAccess {
        let mut access = self.clone();
        access.machine = Some(m.clone());
        access
    }
}

impl GitLab {
    pub fn new() -> GitLab {
        GitLab {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("an HTTP client"),
            me: Mutex::new(HashMap::new()),
            runner: None,
        }
    }

    pub fn with_runner(mut self, runner: Arc<dyn Runner>, ssh: Ssh) -> GitLab {
        self.runner = Some((runner, ssh));
        self
    }

    async fn through_glab(
        &self,
        access: &GitLabAccess,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<String, Problem> {
        let (Some((runner, ssh)), Some(m)) = (&self.runner, &access.machine) else {
            return Err(Problem::Failed(
                "glab cannot be asked from here, so check the connection's settings".into(),
            ));
        };
        let out = run_glab(
            runner.as_ref(),
            ssh,
            m,
            &access.host,
            &endpoint(segments, query),
            &[],
        )
        .await;
        if out.ok() {
            return Ok(out.stdout);
        }
        if out.timed_out {
            return Err(Problem::Failed(format!("glab timed out on {}", m.name)));
        }
        Err(glab_problem(out.status, &out.stderr, &access.host, &m.name))
    }

    async fn get(
        &self,
        access: &GitLabAccess,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<reqwest::Response, Problem> {
        let token = access
            .token
            .as_ref()
            .map_err(|e| Problem::Refused(e.clone()))?;
        let bad = || {
            Problem::Failed(format!(
                "{} has an address Yardbell cannot read",
                access.host
            ))
        };
        let mut url = Url::parse(&access.api).map_err(|_| bad())?;
        url.path_segments_mut()
            .map_err(|_| bad())?
            .pop_if_empty()
            .extend(segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let res = self
            .http
            .get(url)
            .header("PRIVATE-TOKEN", token)
            .send()
            .await
            .map_err(|e| unanswered(&access.host, e))?;
        match res.status() {
            s if s.is_success() => Ok(res),
            StatusCode::UNAUTHORIZED => Err(Problem::Refused(refused(access))),
            StatusCode::FORBIDDEN => Err(Problem::Forbidden),
            StatusCode::NOT_FOUND => Err(Problem::NotFound),
            s => Err(Problem::Failed(format!(
                "GitLab at {} answered {s}",
                access.host
            ))),
        }
    }

    async fn text(
        &self,
        access: &GitLabAccess,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<String, Problem> {
        if access.glab {
            return self.through_glab(access, segments, query).await;
        }
        let res = self.get(access, segments, query).await?;
        res.text().await.map_err(|e| unanswered(&access.host, e))
    }

    // A part the badge can do without: a failure leaves it out, but a refused token still stops
    // the whole check.
    async fn optional(
        &self,
        access: &GitLabAccess,
        segments: &[&str],
    ) -> Result<Option<String>, Problem> {
        match self.text(access, segments, &[]).await {
            Ok(body) => Ok(Some(body)),
            Err(Problem::Refused(m)) => Err(Problem::Refused(m)),
            Err(_) => Ok(None),
        }
    }

    async fn me(&self, access: &GitLabAccess) -> String {
        if let Some(name) = self.me.lock().expect("gitlab lock").get(&access.host) {
            return name.clone();
        }
        let Ok(name) = self.whoami(access).await else {
            return String::new();
        };
        self.me
            .lock()
            .expect("gitlab lock")
            .insert(access.host.clone(), name.clone());
        name
    }

    pub async fn whoami(&self, access: &GitLabAccess) -> Result<String, String> {
        #[derive(Deserialize)]
        struct User {
            username: String,
        }
        let not_gitlab = || format!("{} did not answer as GitLab does", access.host);
        let body = self
            .text(access, &["user"], &[])
            .await
            .map_err(|p| match p {
                Problem::Refused(m) | Problem::Failed(m) => m,
                Problem::Forbidden => forbidden(access, "its account"),
                Problem::NotFound => not_gitlab(),
            })?;
        serde_json::from_str::<User>(&body)
            .map(|u| u.username)
            .map_err(|_| not_gitlab())
    }

    // The open merge requests that list the token's account as a reviewer, on any project.
    pub async fn reviewing(&self, access: &GitLabAccess) -> Result<Vec<Mr>, String> {
        #[derive(Deserialize)]
        struct Raw {
            iid: u64,
            #[serde(default)]
            title: String,
            #[serde(default)]
            web_url: String,
            #[serde(default)]
            source_branch: String,
        }
        let me = self.whoami(access).await?;
        let body = self
            .text(
                access,
                &["merge_requests"],
                &[
                    ("reviewer_username", me.as_str()),
                    ("state", "opened"),
                    ("scope", "all"),
                    ("per_page", "100"),
                ],
            )
            .await
            .map_err(|p| match p {
                Problem::Refused(m) | Problem::Failed(m) => m,
                Problem::Forbidden => forbidden(access, "merge requests"),
                Problem::NotFound => format!("{} did not answer as GitLab does", access.host),
            })?;
        let raw: Vec<Raw> = serde_json::from_str(&body).map_err(|_| {
            format!(
                "{} sent a merge request list Yardbell cannot read",
                access.host
            )
        })?;
        Ok(raw
            .into_iter()
            .map(|r| Mr {
                project: r
                    .web_url
                    .split_once("://")
                    .and_then(|(_, rest)| rest.split_once('/'))
                    .and_then(|(_, path)| path.split_once("/-/merge_requests"))
                    .map(|(project, _)| project.to_string())
                    .unwrap_or_default(),
                url: r.web_url,
                iid: r.iid,
                title: r.title,
                source_branch: r.source_branch,
            })
            .collect())
    }

    pub async fn fetch(&self, access: &GitLabAccess, project: &str, branch: &str) -> Answer {
        match self.fetch_pull(access, project, branch).await {
            Ok(Some((pull, true))) => Answer::Pull(Box::new(pull)),
            Ok(Some((pull, false))) => Answer::Partial(Box::new(pull)),
            Ok(None) => Answer::NoPull,
            Err(Problem::NotFound) => Answer::Failed(format!(
                "project {project} not found on {}, or {} cannot see it",
                access.host,
                the_token(access)
            )),
            Err(Problem::Forbidden) => Answer::Failed(forbidden(access, project)),
            Err(p) => p.into(),
        }
    }

    async fn fetch_pull(
        &self,
        access: &GitLabAccess,
        project: &str,
        branch: &str,
    ) -> Result<Option<(Pull, bool)>, Problem> {
        let list = self
            .text(
                access,
                &["projects", project, "merge_requests"],
                &[
                    ("source_branch", branch),
                    ("state", "all"),
                    ("order_by", "updated_at"),
                    ("sort", "desc"),
                    ("per_page", "20"),
                ],
            )
            .await?;
        let Some(iid) = pick_mr(&list).map_err(unreadable)? else {
            return Ok(None);
        };
        let iid = iid.to_string();
        let mr = ["projects", project, "merge_requests", iid.as_str()];
        let gone = |p| match p {
            Problem::NotFound => Problem::Failed("GitLab no longer has that merge request".into()),
            p => p,
        };
        let one = self.text(access, &mr, &[]).await.map_err(gone)?;
        let mut pull = parse_mr(&one).map_err(unreadable)?;
        if pull.ci == Ci::Failing {
            if let Some((id, web)) = pipeline(&one) {
                pull.failed = self.jobs_in(access, project, id, &web, "failed").await?;
            }
        }
        if was_cancelled(&one) {
            if let Some((id, web)) = pipeline(&one) {
                let jobs = self.jobs_in(access, project, id, &web, "canceled").await?;
                pull.unsettled = jobs
                    .into_iter()
                    .map(|check| UnsettledCheck {
                        check,
                        how: Unsettled::Cancelled,
                    })
                    .collect();
            }
        }
        let part = |name: &'static str| [&mr[..], &[name]].concat();
        let reviewers = self.optional(access, &part("reviewers")).await?;
        let approvals = if review_of(reviewers.as_deref(), None) == "changes_requested" {
            None
        } else {
            self.optional(access, &part("approvals")).await?
        };
        pull.review = review_of(reviewers.as_deref(), approvals.as_deref());
        pull.approvers = approvers_of(reviewers.as_deref(), approvals.as_deref());
        // Without the token's own account its comments cannot be told apart, so none are read.
        let me = self.me(access).await;
        if me.is_empty() {
            return Ok(Some((pull, false)));
        }
        match self
            .discussions(access, &part("discussions"), &pull, &me)
            .await?
        {
            Some((notes, resolved)) => {
                pull.notes = notes;
                pull.resolved = resolved;
                Ok(Some((pull, true)))
            }
            None => Ok(Some((pull, false))),
        }
    }

    // Only whole: a page that fails leaves the comments unread, so none is marked seen before it
    // is read. GitLab lists them oldest first, and only as many of the newest as are remembered
    // are kept, or the oldest would turn new again each time.
    async fn discussions(
        &self,
        access: &GitLabAccess,
        segments: &[&str],
        pull: &Pull,
        me: &str,
    ) -> Result<Option<(Vec<Note>, Vec<String>)>, Problem> {
        let mut out = Vec::new();
        let mut resolved = Vec::new();
        for page in 1..=PAGES {
            let page = page.to_string();
            let res = match self
                .get(
                    access,
                    segments,
                    &[("per_page", PAGE), ("page", page.as_str())],
                )
                .await
            {
                Ok(res) => res,
                Err(Problem::Refused(m)) => return Err(Problem::Refused(m)),
                Err(_) => return Ok(None),
            };
            let next = res
                .headers()
                .get("x-next-page")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| !v.trim().is_empty());
            let Ok(body) = res.text().await else {
                return Ok(None);
            };
            out.extend(notes(&body, &pull.url, &pull.author, me));
            resolved.extend(resolved_notes(&body));
            if !next {
                break;
            }
        }
        out.drain(..out.len().saturating_sub(SEEN_NOTES));
        Ok(Some((out, resolved)))
    }

    // A pipeline can fail through a downstream pipeline, which shows as a failed bridge rather
    // than a job, or before any job ran; the card then names what it can, down to the pipeline.
    async fn jobs_in(
        &self,
        access: &GitLabAccess,
        project: &str,
        id: u64,
        web: &str,
        scope: &str,
    ) -> Result<Vec<Check>, Problem> {
        let id = id.to_string();
        let failed = [("scope[]", scope), ("per_page", PAGE)];
        let list = |what: &'static str| ["projects", project, "pipelines", id.as_str(), what];
        let mut checks = match self.text(access, &list("jobs"), &failed).await {
            Ok(jobs) => failed_checks(&jobs).map_err(unreadable)?,
            Err(Problem::Forbidden | Problem::NotFound) => Vec::new(),
            Err(p) => return Err(p),
        };
        if checks.is_empty() {
            match self.text(access, &list("bridges"), &failed).await {
                Ok(bridges) => checks = failed_checks(&bridges).unwrap_or_default(),
                Err(Problem::Refused(m)) => return Err(Problem::Refused(m)),
                Err(_) => {}
            }
        }
        if checks.is_empty() {
            checks.push(Check {
                name: format!("pipeline #{id}"),
                url: web.to_string(),
                log: String::new(),
            });
        }
        Ok(checks)
    }

    pub async fn failure_log(&self, access: &GitLabAccess, project: &str, check: &Check) -> String {
        let Some(id) = job_id(&check.url) else {
            return String::new();
        };
        let id = id.to_string();
        let Ok(mut res) = self
            .get(
                access,
                &["projects", project, "jobs", id.as_str(), "trace"],
                &[],
            )
            .await
        else {
            return String::new();
        };
        let mut kept: Vec<u8> = Vec::new();
        loop {
            let chunk = match res.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                // Its end is the part worth quoting, and a log cut off mid-way has none.
                Err(_) => return String::new(),
            };
            kept.extend_from_slice(&chunk);
            if kept.len() > 2 * TRACE_KEEP {
                kept.drain(..kept.len() - TRACE_KEEP);
            }
        }
        if kept.len() > TRACE_KEEP {
            kept.drain(..kept.len() - TRACE_KEEP);
        }
        excerpt(&String::from_utf8_lossy(&kept))
    }
}

fn was_cancelled(mr_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(mr_json).is_ok_and(|mr| {
        matches!(
            mr["head_pipeline"]["status"].as_str(),
            Some("canceled" | "canceling")
        )
    })
}

pub(super) fn pipeline(mr_json: &str) -> Option<(u64, String)> {
    let mr = serde_json::from_str::<serde_json::Value>(mr_json).ok()?;
    let p = mr.get("head_pipeline")?;
    Some((
        p.get("id")?.as_u64()?,
        p.get("web_url")
            .and_then(|w| w.as_str())
            .unwrap_or_default()
            .to_string(),
    ))
}

#[derive(Deserialize, Default)]
struct Who {
    #[serde(default)]
    username: String,
}

fn name(who: &Option<Who>) -> String {
    who.as_ref().map(|w| w.username.clone()).unwrap_or_default()
}

#[derive(Deserialize)]
struct Listed {
    iid: u64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    source_project_id: Option<u64>,
    #[serde(default)]
    target_project_id: Option<u64>,
}

#[derive(Deserialize)]
struct RawPipeline {
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct RawMr {
    iid: u64,
    web_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    author: Option<Who>,
    #[serde(default)]
    head_pipeline: Option<RawPipeline>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct RawReviewer {
    #[serde(default)]
    state: String,
    #[serde(default)]
    user: Option<Who>,
}

#[derive(Deserialize)]
// `approved` also means "no approval is required", so only an actual approver counts.
struct RawApprovals {
    #[serde(default)]
    approved_by: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawJob {
    #[serde(default)]
    name: String,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    allow_failure: bool,
    #[serde(default)]
    web_url: String,
}

#[derive(Deserialize)]
struct RawPosition {
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    new_line: Option<u64>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    old_line: Option<u64>,
}

#[derive(Deserialize)]
struct RawNote {
    id: u64,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Option<Who>,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    position: Option<RawPosition>,
    #[serde(default)]
    resolved: bool,
}

#[derive(Deserialize)]
struct RawDiscussion {
    #[serde(default)]
    notes: Vec<RawNote>,
}

// A merge request opened from a fork can share the branch's name; it is someone else's. An open
// one wins over a newer merged or closed one, as gh does.
pub(super) fn pick_mr(list_json: &str) -> Result<Option<u64>, String> {
    let list: Vec<Listed> = serde_json::from_str(list_json).map_err(|e| e.to_string())?;
    let ours: Vec<&Listed> = list
        .iter()
        .filter(|m| m.source_project_id == m.target_project_id)
        .collect();
    Ok(ours
        .iter()
        .find(|m| m.state == "opened")
        .or(ours.first())
        .map(|m| m.iid))
}

pub(super) fn ci_of(status: Option<&str>) -> Ci {
    match status {
        Some("failed") => Ci::Failing,
        Some(
            "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "scheduled",
        ) => Ci::Pending,
        Some("success") => Ci::Passing,
        _ => Ci::None,
    }
}

pub(super) fn parse_mr(json: &str) -> Result<Pull, String> {
    let raw: RawMr = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let state = match raw.state.as_str() {
        "opened" | "locked" => "open".to_string(),
        other => other.to_string(),
    };
    Ok(Pull {
        forge: "gitlab".into(),
        number: raw.iid,
        url: raw.web_url,
        title: raw.title,
        state,
        draft: raw.draft,
        review: String::new(),
        ci: ci_of(raw.head_pipeline.as_ref().and_then(|p| p.status.as_deref())),
        failed: Vec::new(),
        head: raw.sha.unwrap_or_default(),
        author: name(&raw.author),
        notes: Vec::new(),
        created: raw.created_at.unwrap_or_default(),
        approvers: Vec::new(),
        asking: Vec::new(),
        resolved: Vec::new(),
        unsettled: Vec::new(),
    })
}

pub(super) fn review_of(reviewers_json: Option<&str>, approvals_json: Option<&str>) -> String {
    let reviewers: Vec<RawReviewer> = reviewers_json
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    if reviewers.iter().any(|r| r.state == "requested_changes") {
        return "changes_requested".into();
    }
    let approved = reviewers.iter().any(|r| r.state == "approved")
        || approvals_json
            .and_then(|j| serde_json::from_str::<RawApprovals>(j).ok())
            .is_some_and(|a| !a.approved_by.is_empty());
    if approved {
        "approved".into()
    } else {
        String::new()
    }
}

pub(super) fn approvers_of(
    reviewers_json: Option<&str>,
    approvals_json: Option<&str>,
) -> Vec<String> {
    let approved: Vec<String> = approvals_json
        .and_then(|j| serde_json::from_str::<RawApprovals>(j).ok())
        .map(|a| {
            a.approved_by
                .iter()
                .filter_map(|v| v["user"]["username"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let reviewed: Vec<String> = reviewers_json
        .and_then(|j| serde_json::from_str::<Vec<RawReviewer>>(j).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.state == "approved")
        .map(|r| name(&r.user))
        .collect();
    let mut out: Vec<String> = Vec::new();
    for who in approved.into_iter().chain(reviewed) {
        if !who.is_empty() && !out.contains(&who) {
            out.push(who);
        }
    }
    out
}

pub(super) fn failed_checks(jobs_json: &str) -> Result<Vec<Check>, String> {
    let jobs: Vec<RawJob> = serde_json::from_str(jobs_json).map_err(|e| e.to_string())?;
    Ok(jobs
        .into_iter()
        .filter(|j| !j.allow_failure)
        .map(|j| Check {
            name: if j.stage.is_empty() {
                j.name
            } else {
                format!("{} / {}", j.stage, j.name)
            },
            url: j.web_url,
            log: String::new(),
        })
        .collect())
}

fn place(p: &RawPosition) -> String {
    let at = |path: &Option<String>, line: Option<u64>| match (path, line) {
        (Some(path), Some(line)) => Some(format!("{path}:{line}")),
        _ => None,
    };
    at(&p.new_path, p.new_line)
        .or_else(|| at(&p.old_path, p.old_line))
        .or_else(|| p.new_path.clone().or_else(|| p.old_path.clone()))
        .unwrap_or_default()
}

pub(super) fn notes(discussions_json: &str, web_url: &str, author: &str, me: &str) -> Vec<Note> {
    let Ok(discussions) = serde_json::from_str::<Vec<RawDiscussion>>(discussions_json) else {
        return Vec::new();
    };
    discussions
        .into_iter()
        .flat_map(|d| d.notes)
        .filter_map(|n| {
            let who = name(&n.author);
            if n.system || who.is_empty() || who == author || (!me.is_empty() && who == me) {
                return None;
            }
            Some(Note {
                id: format!("gitlab:{}", n.id),
                kind: if n.position.is_some() {
                    "inline"
                } else {
                    "comment"
                }
                .into(),
                author: who,
                body: n.body,
                url: format!("{web_url}#note_{}", n.id),
                place: n.position.as_ref().map(place).unwrap_or_default(),
            })
        })
        .collect()
}

pub(super) fn resolved_notes(discussions_json: &str) -> Vec<String> {
    let Ok(discussions) = serde_json::from_str::<Vec<RawDiscussion>>(discussions_json) else {
        return Vec::new();
    };
    discussions
        .into_iter()
        .flat_map(|d| d.notes)
        .filter(|n| n.resolved)
        .map(|n| format!("gitlab:{}", n.id))
        .collect()
}

pub(super) fn job_id(check_url: &str) -> Option<u64> {
    let (_, tail) = check_url.split_once("/-/jobs/")?;
    tail.split(['/', '?', '#']).next()?.parse().ok()
}

fn noise() -> &'static (Regex, Regex) {
    static RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    RE.get_or_init(|| {
        (
            Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("static regex"),
            Regex::new(r"section_(start|end):\d+:\S*").expect("static regex"),
        )
    })
}

// A runner redraws a line with carriage returns and wraps each step in section markers; only
// what the line finally said is worth reading.
pub(super) fn excerpt(trace: &str) -> String {
    let (ansi, section) = noise();
    let lines: Vec<String> = trace
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .map(|l| l.rsplit('\r').next().unwrap_or(l))
        .map(|l| section.replace_all(l, "").to_string())
        .map(|l| ansi.replace_all(&l, "").trim_end().to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();
    last_lines(&lines, LOG_LINES, LOG_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MRS: &str = include_str!("../../tests/fixtures/gitlab_mrs.json");
    const MR: &str = include_str!("../../tests/fixtures/gitlab_mr.json");
    const REVIEWERS: &str = include_str!("../../tests/fixtures/gitlab_reviewers.json");
    const APPROVALS: &str = include_str!("../../tests/fixtures/gitlab_approvals.json");
    const JOBS: &str = include_str!("../../tests/fixtures/gitlab_jobs.json");
    const DISCUSSIONS: &str = include_str!("../../tests/fixtures/gitlab_discussions.json");
    const TRACE: &str = include_str!("../../tests/fixtures/gitlab_trace.txt");
    const WEB: &str = "https://git.commslayer.com/commslayer/app/-/merge_requests/12";

    #[test]
    fn the_merge_request_from_this_project_is_picked() {
        assert_eq!(pick_mr(MRS).unwrap(), Some(12));
        let merged_later = r#"[
            {"iid": 5, "state": "merged", "source_project_id": 17, "target_project_id": 17},
            {"iid": 12, "state": "opened", "source_project_id": 17, "target_project_id": 17}
        ]"#;
        assert_eq!(
            pick_mr(merged_later).unwrap(),
            Some(12),
            "an open one first"
        );
        let only_closed =
            r#"[{"iid": 5, "state": "closed", "source_project_id": 17, "target_project_id": 17}]"#;
        assert_eq!(pick_mr(only_closed).unwrap(), Some(5));
        assert_eq!(pick_mr("[]").unwrap(), None);
        assert!(pick_mr("{").is_err());
    }

    #[test]
    fn a_merge_request_is_read() {
        let p = parse_mr(MR).unwrap();
        assert_eq!(p.forge, "gitlab");
        assert_eq!(p.number, 12);
        assert_eq!(p.url, WEB);
        assert_eq!(p.title, "Fix the login redirect");
        assert_eq!(p.state, "open");
        assert!(!p.draft);
        assert_eq!(p.head, format!("abc123{}", "0".repeat(34)));
        assert_eq!(p.author, "hb");
        assert_eq!(p.created, "2026-09-03T19:03:36.713Z");
        assert_eq!(p.ci, Ci::Failing);
        for (state, want) in [
            ("opened", "open"),
            ("locked", "open"),
            ("merged", "merged"),
            ("closed", "closed"),
        ] {
            let mut v: serde_json::Value = serde_json::from_str(MR).unwrap();
            v["state"] = state.into();
            assert_eq!(parse_mr(&v.to_string()).unwrap().state, want, "{state}");
        }
    }

    #[test]
    fn pipeline_statuses_add_up_to_one_ci_state() {
        assert_eq!(ci_of(Some("failed")), Ci::Failing);
        for s in [
            "created",
            "waiting_for_resource",
            "preparing",
            "pending",
            "running",
            "scheduled",
        ] {
            assert_eq!(ci_of(Some(s)), Ci::Pending, "{s}");
        }
        assert_eq!(ci_of(Some("success")), Ci::Passing);
        for s in [Some("canceled"), Some("skipped"), Some("manual"), None] {
            assert_eq!(ci_of(s), Ci::None, "{s:?}");
        }
    }

    #[test]
    fn review_state_comes_from_reviewers_then_approvals() {
        assert_eq!(
            review_of(Some(REVIEWERS), Some(APPROVALS)),
            "changes_requested"
        );
        let approved = r#"[{"user":{"username":"rev2"},"state":"approved"}]"#;
        assert_eq!(review_of(Some(approved), Some(APPROVALS)), "approved");
        assert_eq!(review_of(None, Some(APPROVALS)), "approved");
        assert_eq!(review_of(None, Some(r#"{"approved":false}"#)), "");
        assert_eq!(review_of(None, None), "");
        assert_eq!(approvers_of(Some(REVIEWERS), Some(APPROVALS)), ["rev2"]);
        assert_eq!(
            approvers_of(
                Some(r#"[{"user":{"username":"rev3"},"state":"approved"}]"#),
                Some(APPROVALS)
            ),
            ["rev2", "rev3"],
            "an approving reviewer and an approver, once each"
        );
        assert!(approvers_of(None, None).is_empty());
        let no_rules =
            r#"{"approved":true,"approvals_required":0,"approvals_left":0,"approved_by":[]}"#;
        assert_eq!(
            review_of(None, Some(no_rules)),
            "",
            "approved by nobody is not approved"
        );
        let reviewed = r#"[{"user":{"username":"rev2"},"state":"approved"}]"#;
        assert_eq!(review_of(Some(reviewed), Some(no_rules)), "approved");
    }

    #[test]
    fn failed_jobs_that_may_fail_are_left_out() {
        assert_eq!(
            failed_checks(JOBS).unwrap(),
            [Check {
                name: "test / rspec".into(),
                url: "https://git.commslayer.com/commslayer/app/-/jobs/9001".into(),
                log: String::new(),
            }]
        );
        assert!(failed_checks("nope").is_err());
    }

    #[test]
    fn notes_leave_out_system_author_and_own_comments() {
        let got = notes(DISCUSSIONS, WEB, "hb", "me-bot");
        let short: Vec<(&str, &str, &str, &str)> = got
            .iter()
            .map(|n| {
                (
                    n.id.as_str(),
                    n.kind.as_str(),
                    n.author.as_str(),
                    n.place.as_str(),
                )
            })
            .collect();
        assert_eq!(
            short,
            [
                ("gitlab:301", "comment", "rev1", ""),
                ("gitlab:303", "inline", "rev1", "app/models/user.rb:42"),
                (
                    "gitlab:305",
                    "inline",
                    "rev2",
                    "app/controllers/sessions_controller.rb:17"
                ),
            ]
        );
        assert_eq!(got[0].url, format!("{WEB}#note_301"));
        assert_eq!(got[0].body, "Please add a test for the redirect.");
        assert!(notes("not json", WEB, "hb", "").is_empty());
    }

    #[test]
    fn resolved_notes_are_named_and_stay_in_the_list() {
        let body = r#"[{"notes":[
            {"id":1,"body":"done","author":{"username":"a"},"resolved":true,"position":{"new_path":"x.rs","new_line":2}},
            {"id":2,"body":"open","author":{"username":"a"},"resolved":false,"position":{"new_path":"x.rs","new_line":3}},
            {"id":3,"body":"plain","author":{"username":"a"}}
        ]}]"#;
        assert_eq!(resolved_notes(body), vec!["gitlab:1"]);
        assert_eq!(notes(body, "u", "me", "me").len(), 3, "cards are unchanged");
    }

    #[test]
    fn a_job_id_is_read_from_its_url() {
        assert_eq!(job_id("https://git.x/g/app/-/jobs/123"), Some(123));
        assert_eq!(
            job_id("https://github.com/acme/app/actions/runs/111/job/222"),
            None
        );
    }

    #[test]
    fn the_trace_excerpt_is_the_readable_end() {
        let e = excerpt(TRACE);
        assert!(!e.contains('\u{1b}'), "{e:?}");
        assert!(!e.contains("section_"), "{e:?}");
        assert!(!e.contains('\r'), "{e:?}");
        assert!(
            e.contains("Downloading 100%") && !e.contains("Downloading 10%"),
            "{e:?}"
        );
        assert!(e.lines().count() <= 30);
        assert!(e.ends_with("ERROR: Job failed: exit code 1"), "{e:?}");
        assert_eq!(super::super::telling_line(&e), "2 examples, 1 failure");
    }
}

#[cfg(test)]
pub(crate) mod stub {
    use super::GitLabAccess;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, Uri};
    use axum::response::{IntoResponse, Response};
    use std::sync::{Arc, Mutex};

    pub struct Answers {
        pub mrs: (u16, String),
        pub mr: (u16, String),
        pub reviewers: (u16, String),
        pub approvals: (u16, String),
        pub jobs: (u16, String),
        pub discussions: (u16, String),
        pub trace: (u16, String),
        pub user: (u16, String),
        pub bridges: (u16, String),
        pub next_page: bool,
    }

    impl Default for Answers {
        fn default() -> Answers {
            let ok = |body: &str| (200, body.to_string());
            Answers {
                mrs: ok(include_str!("../../tests/fixtures/gitlab_mrs.json")),
                mr: ok(include_str!("../../tests/fixtures/gitlab_mr.json")),
                reviewers: ok(include_str!("../../tests/fixtures/gitlab_reviewers.json")),
                approvals: ok(include_str!("../../tests/fixtures/gitlab_approvals.json")),
                jobs: ok(include_str!("../../tests/fixtures/gitlab_jobs.json")),
                discussions: ok(include_str!("../../tests/fixtures/gitlab_discussions.json")),
                trace: ok(include_str!("../../tests/fixtures/gitlab_trace.txt")),
                user: ok(r#"{"id":1,"username":"me-bot"}"#),
                bridges: ok("[]"),
                next_page: false,
            }
        }
    }

    #[derive(Clone)]
    struct Shared {
        answers: Arc<Mutex<Answers>>,
        log: Arc<Mutex<Vec<String>>>,
    }

    pub struct Stub {
        pub base: String,
        pub answers: Arc<Mutex<Answers>>,
        pub log: Arc<Mutex<Vec<String>>>,
    }

    impl Stub {
        pub fn access(&self, token: &str) -> GitLabAccess {
            GitLabAccess {
                host: "git.commslayer.com".into(),
                api: format!("{}/api/v4", self.base),
                secret: "gitlab".into(),
                token: Ok(token.into()),
                glab: false,
                machine: None,
            }
        }

        pub fn asked(&self, part: &str) -> usize {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter(|l| l.contains(part))
                .count()
        }
    }

    async fn answer(State(s): State<Shared>, headers: HeaderMap, uri: Uri) -> Response {
        let path = uri.path().to_string();
        let query = uri.query().unwrap_or_default().to_string();
        s.log.lock().unwrap().push(format!("{path}?{query}"));
        match headers.get("private-token").and_then(|v| v.to_str().ok()) {
            Some("glpat-good") => {}
            Some("glpat-forbidden") => {
                return (StatusCode::FORBIDDEN, r#"{"message":"403 Forbidden"}"#).into_response()
            }
            _ => {
                return (
                    StatusCode::UNAUTHORIZED,
                    r#"{"message":"401 Unauthorized"}"#,
                )
                    .into_response()
            }
        }
        let a = s.answers.lock().unwrap();
        let (status, body) = if path.ends_with("/trace") {
            &a.trace
        } else if path.ends_with("/bridges") {
            &a.bridges
        } else if path.ends_with("/jobs") {
            &a.jobs
        } else if path.ends_with("/reviewers") {
            &a.reviewers
        } else if path.ends_with("/approvals") {
            &a.approvals
        } else if path.ends_with("/discussions") {
            &a.discussions
        } else if path.ends_with("/api/v4/user") {
            &a.user
        } else if path.ends_with("/merge_requests") {
            &a.mrs
        } else if path.contains("/merge_requests/") {
            &a.mr
        } else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let mut resp = (StatusCode::from_u16(*status).unwrap(), body.clone()).into_response();
        if path.ends_with("/discussions") && a.next_page {
            let page: u32 = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("page="))
                .and_then(|p| p.parse().ok())
                .unwrap_or(1);
            resp.headers_mut()
                .insert("x-next-page", (page + 1).to_string().parse().unwrap());
        }
        resp
    }

    pub async fn serve(answers: Answers) -> Stub {
        let shared = Shared {
            answers: Arc::new(Mutex::new(answers)),
            log: Arc::new(Mutex::new(Vec::new())),
        };
        let app = axum::Router::new()
            .fallback(answer)
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        Stub {
            base: format!("http://{addr}"),
            answers: shared.answers,
            log: shared.log,
        }
    }
}

#[cfg(test)]
mod http_tests {
    use super::stub::{serve, Answers};
    use super::*;

    fn failing_ci() -> Answers {
        Answers::default()
    }

    fn pipeline_status(status: &str) -> Answers {
        let mut answers = Answers::default();
        let mut mr: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/gitlab_mr.json")).unwrap();
        mr["head_pipeline"]["status"] = status.into();
        answers.mr = (200, mr.to_string());
        answers
    }

    #[tokio::test]
    async fn a_cancelled_pipeline_names_its_jobs_and_badges_stay_as_they_were() {
        for status in ["canceled", "canceling"] {
            let stub = serve(pipeline_status(status)).await;
            let access = stub.access("glpat-good");
            let Answer::Pull(p) = GitLab::new()
                .fetch(&access, "commslayer/app", "eng-2")
                .await
            else {
                panic!("no pull");
            };
            assert_eq!(p.ci, Ci::None, "{status}");
            assert!(!p.unsettled.is_empty(), "{status}");
            assert!(p.failed.is_empty(), "{status}");
            assert!(stub.asked("=canceled") > 0, "{status}");
        }
    }

    #[tokio::test]
    async fn other_pipeline_statuses_read_no_cancelled_jobs() {
        for status in ["skipped", "manual", "success", "running"] {
            let stub = serve(pipeline_status(status)).await;
            let access = stub.access("glpat-good");
            let Answer::Pull(p) = GitLab::new()
                .fetch(&access, "commslayer/app", "eng-2")
                .await
            else {
                panic!("no pull");
            };
            assert!(p.unsettled.is_empty(), "{status}");
            assert_eq!(stub.asked("=canceled"), 0, "{status}");
        }
    }

    #[tokio::test]
    async fn gitlab_reviewing_lists_my_merge_requests() {
        let stub = serve(failing_ci()).await;
        let gl = GitLab::new();
        let mrs = gl.reviewing(&stub.access("glpat-good")).await.unwrap();
        assert_eq!(mrs.len(), 2);
        assert_eq!(mrs[0].iid, 99);
        assert_eq!(
            mrs[0].url,
            "https://git.commslayer.com/commslayer/app/-/merge_requests/99"
        );
        assert_eq!(mrs[0].source_branch, "eng-2");
        assert_eq!(mrs[0].project, "commslayer/app");
        assert_eq!(stub.asked("reviewer_username=me-bot"), 1);
        assert_eq!(stub.asked("state=opened"), 1);
        let err = gl.reviewing(&stub.access("glpat-bad")).await.unwrap_err();
        assert!(!err.contains("glpat-bad"), "{err}");
    }

    #[tokio::test]
    async fn a_merge_request_is_fetched_with_its_pipeline_jobs_review_and_notes() {
        let stub = serve(failing_ci()).await;
        let gl = GitLab::new();
        let access = stub.access("glpat-good");
        let Answer::Pull(p) = gl.fetch(&access, "commslayer/app", "eng-2").await else {
            panic!("no pull");
        };
        assert_eq!(p.number, 12);
        assert_eq!(p.ci, Ci::Failing);
        assert_eq!(p.failed.len(), 1);
        assert_eq!(p.failed[0].name, "test / rspec");
        assert_eq!(p.review, "changes_requested");
        let ids: Vec<&str> = p.notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["gitlab:301", "gitlab:303", "gitlab:305"]);
        assert!(stub.asked("/pipelines/501/jobs") == 1);
        let again = gl.fetch(&access, "commslayer/app", "eng-2").await;
        assert!(matches!(again, Answer::Pull(_)));
        assert_eq!(
            stub.asked("/api/v4/user?"),
            1,
            "the token's owner is asked once"
        );
    }

    #[tokio::test]
    async fn the_branch_and_project_are_percent_encoded() {
        let stub = serve(Answers::default()).await;
        GitLab::new()
            .fetch(
                &stub.access("glpat-good"),
                "commslayer/app",
                "feature/eng-12#fix",
            )
            .await;
        let first = stub.log.lock().unwrap()[0].clone();
        assert!(
            first.starts_with("/api/v4/projects/commslayer%2Fapp/merge_requests?"),
            "{first}"
        );
        assert!(
            first.contains("source_branch=feature%2Feng-12%23fix"),
            "{first}"
        );
        assert!(first.contains("state=all"), "{first}");
    }

    #[tokio::test]
    async fn discussions_are_read_five_pages_at_most() {
        let stub = serve(Answers {
            next_page: true,
            ..Answers::default()
        })
        .await;
        GitLab::new()
            .fetch(&stub.access("glpat-good"), "commslayer/app", "eng-2")
            .await;
        assert_eq!(stub.asked("/discussions?"), 5);
    }

    #[tokio::test]
    async fn no_merge_request_is_no_pull() {
        let stub = serve(Answers::default()).await;
        let gl = GitLab::new();
        let access = stub.access("glpat-good");
        let got = gl.fetch(&access, "commslayer/app", "eng-2").await;
        assert!(matches!(got, Answer::Pull(_)), "{got:?}");
        stub.answers.lock().unwrap().mrs = (200, "[]".into());
        let got = gl.fetch(&access, "commslayer/app", "eng-2").await;
        assert!(matches!(got, Answer::NoPull), "{got:?}");
    }

    #[tokio::test]
    async fn a_refused_token_is_named_without_the_token() {
        let stub = serve(Answers::default()).await;
        let got = GitLab::new()
            .fetch(&stub.access("glpat-bad"), "commslayer/app", "eng-2")
            .await;
        let Answer::Refused(msg) = got else {
            panic!("{got:?}");
        };
        assert_eq!(
            msg,
            "GitLab at git.commslayer.com refused the token in secret gitlab"
        );
        assert!(!msg.contains("glpat"));
    }

    #[tokio::test]
    async fn a_forbidden_project_fails_only_that_branch() {
        let stub = serve(Answers::default()).await;
        let got = GitLab::new()
            .fetch(&stub.access("glpat-forbidden"), "commslayer/app", "eng-2")
            .await;
        assert!(
            matches!(&got, Answer::Failed(m) if m == "GitLab at git.commslayer.com does not let the token in secret gitlab read commslayer/app"),
            "{got:?}"
        );
        assert_eq!(
            GitLab::new().whoami(&stub.access("glpat-forbidden")).await,
            Err("GitLab at git.commslayer.com does not let the token in secret gitlab read its account".into())
        );
    }

    #[tokio::test]
    async fn jobs_hidden_from_the_token_name_the_pipeline() {
        let stub = serve(Answers {
            jobs: (403, r#"{"message":"403 Forbidden"}"#.into()),
            ..Answers::default()
        })
        .await;
        let got = GitLab::new()
            .fetch(&stub.access("glpat-good"), "commslayer/app", "eng-2")
            .await;
        let Answer::Pull(p) = got else {
            panic!("{got:?}");
        };
        assert_eq!(p.failed[0].name, "pipeline #501");
    }

    #[tokio::test]
    async fn a_pipeline_failed_downstream_names_its_bridge_or_itself() {
        let stub = serve(Answers {
            jobs: (200, "[]".into()),
            bridges: (
                200,
                r#"[{"id":9100,"name":"deploy-child","stage":"deploy","status":"failed","allow_failure":false,"web_url":"https://git.commslayer.com/commslayer/app/-/pipelines/777"}]"#.into(),
            ),
            ..Answers::default()
        })
        .await;
        let gl = GitLab::new();
        let access = stub.access("glpat-good");
        let Answer::Pull(p) = gl.fetch(&access, "commslayer/app", "eng-2").await else {
            panic!("no pull");
        };
        assert_eq!(
            p.failed,
            [Check {
                name: "deploy / deploy-child".into(),
                url: "https://git.commslayer.com/commslayer/app/-/pipelines/777".into(),
                log: String::new(),
            }]
        );
        stub.answers.lock().unwrap().bridges = (200, "[]".into());
        let Answer::Pull(p) = gl.fetch(&access, "commslayer/app", "eng-2").await else {
            panic!("no pull");
        };
        assert_eq!(
            p.failed,
            [Check {
                name: "pipeline #501".into(),
                url: "https://git.commslayer.com/commslayer/app/-/pipelines/501".into(),
                log: String::new(),
            }]
        );
    }

    #[tokio::test]
    async fn a_trace_cut_off_mid_way_gives_no_log() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\nthe middle of a log\n",
                )
                .await;
        });
        let access = GitLabAccess {
            host: "git.commslayer.com".into(),
            api: format!("http://{addr}/api/v4"),
            secret: "gitlab".into(),
            token: Ok("glpat-good".into()),
            glab: false,
            machine: None,
        };
        let check = Check {
            name: "test / rspec".into(),
            url: "https://git.commslayer.com/commslayer/app/-/jobs/9001".into(),
            log: String::new(),
        };
        let log = GitLab::new()
            .failure_log(&access, "commslayer/app", &check)
            .await;
        assert_eq!(
            log, "",
            "a log cut off mid-way is not quoted from its middle"
        );
    }

    #[tokio::test]
    async fn an_answer_that_is_not_gitlab_says_so() {
        let stub = serve(Answers {
            user: (200, "<html>sign in</html>".into()),
            ..Answers::default()
        })
        .await;
        assert_eq!(
            GitLab::new().whoami(&stub.access("glpat-good")).await,
            Err("git.commslayer.com did not answer as GitLab does".into())
        );
    }

    #[tokio::test]
    async fn a_missing_secret_is_refused_before_asking() {
        let stub = serve(Answers::default()).await;
        let mut access = stub.access("glpat-good");
        access.token = Err("the secret gitlab is not set".into());
        let got = GitLab::new()
            .fetch(&access, "commslayer/app", "eng-2")
            .await;
        assert!(
            matches!(&got, Answer::Refused(m) if m == "the secret gitlab is not set"),
            "{got:?}"
        );
        assert!(stub.log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_missing_project_says_so() {
        let stub = serve(Answers {
            mrs: (404, r#"{"message":"404 Project Not Found"}"#.into()),
            ..Answers::default()
        })
        .await;
        let got = GitLab::new()
            .fetch(&stub.access("glpat-good"), "commslayer/app", "eng-2")
            .await;
        assert!(
            matches!(&got, Answer::Failed(m) if m == "project commslayer/app not found on git.commslayer.com, or the token in secret gitlab cannot see it"),
            "{got:?}"
        );
    }

    #[tokio::test]
    async fn a_failing_call_after_the_merge_request_leaves_out_only_its_part() {
        let stub = serve(Answers {
            reviewers: (404, "{}".into()),
            discussions: (500, "{}".into()),
            ..Answers::default()
        })
        .await;
        let got = GitLab::new()
            .fetch(&stub.access("glpat-good"), "commslayer/app", "eng-2")
            .await;
        let Answer::Partial(p) = got else {
            panic!("unread comments make a partial answer: {got:?}");
        };
        assert_eq!(p.review, "approved");
        assert!(p.notes.is_empty());

        let stub = serve(Answers {
            jobs: (500, "{}".into()),
            ..Answers::default()
        })
        .await;
        let got = GitLab::new()
            .fetch(&stub.access("glpat-good"), "commslayer/app", "eng-2")
            .await;
        assert!(matches!(got, Answer::Failed(_)), "{got:?}");
    }

    #[tokio::test]
    async fn a_long_trace_keeps_only_its_end() {
        let mut trace = "x".repeat(99).repeat(50_000);
        trace.push_str("\nassertion failed: expected 3\n");
        let stub = serve(Answers {
            trace: (200, trace),
            ..Answers::default()
        })
        .await;
        let check = Check {
            name: "test / rspec".into(),
            url: format!("{}/commslayer/app/-/jobs/9001", stub.base),
            log: String::new(),
        };
        let log = GitLab::new()
            .failure_log(&stub.access("glpat-good"), "commslayer/app", &check)
            .await;
        assert!(log.ends_with("assertion failed: expected 3"), "{log:?}");
        assert!(log.len() <= 3000);
    }

    #[tokio::test]
    async fn whoami_names_the_account_or_the_problem() {
        let stub = serve(Answers::default()).await;
        let gl = GitLab::new();
        assert_eq!(
            gl.whoami(&stub.access("glpat-good")).await,
            Ok("me-bot".into())
        );
        assert_eq!(
            gl.whoami(&stub.access("glpat-bad")).await,
            Err("GitLab at git.commslayer.com refused the token in secret gitlab".into())
        );
        let mut missing = stub.access("x");
        missing.token = Err("the secret gitlab is not set".into());
        assert_eq!(
            gl.whoami(&missing).await,
            Err("the secret gitlab is not set".into())
        );
        let mut away = stub.access("glpat-good");
        away.api = "http://127.0.0.1:1/api/v4".into();
        let err = gl.whoami(&away).await.unwrap_err();
        assert!(
            err.starts_with("git.commslayer.com did not answer"),
            "{err}"
        );
        assert!(err.to_lowercase().contains("refused"), "says why: {err}");
    }

    #[test]
    fn accesses_fill_the_token_from_its_secret_and_hide_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.yml");
        std::fs::write(&path, "gitlab: glpat-good\n").unwrap();
        let secrets = Ok(crate::secrets::Secrets::load(&path).unwrap());
        let cfg = crate::config::PullRequests {
            gitlab: vec![
                crate::config::GitLabHost {
                    host: "Git.Commslayer.com".into(),
                    url: String::new(),
                    token: "${secret:gitlab}".into(),
                },
                crate::config::GitLabHost {
                    host: "gl.example.com".into(),
                    url: String::new(),
                    token: "${secret:gone}".into(),
                },
            ],
            ..Default::default()
        };
        let got = accesses(&cfg, &secrets);
        assert_eq!(got[0].host, "git.commslayer.com");
        assert_eq!(got[0].api, "https://Git.Commslayer.com/api/v4");
        assert_eq!(got[0].secret, "gitlab");
        assert_eq!(got[0].token, Ok("glpat-good".into()));
        assert!(!format!("{:?}", got[0]).contains("glpat"));
        assert_eq!(got[1].token, Err("the secret gone is not set".into()));
        let broken = accesses(&cfg, &Err("cannot read secrets.yml".into()));
        assert_eq!(broken[0].token, Err("cannot read secrets.yml".into()));
    }
}
