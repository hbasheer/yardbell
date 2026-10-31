use super::github::{
    actions_url, excerpt, parse_review_comments, parse_view, review_comments_query,
};
use super::{Check, Fetched, Forge, Note, Remotes};
use crate::config::{GithubVia, Machine, PullRequests};
use crate::secrets::Secrets;
use futures::future::BoxFuture;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const BASE: &str = "https://api.github.com";
const HOST: &str = "github.com";
const TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = "yardbell";
const QUERY: &str = "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number url title state isDraft reviewDecision headRefOid createdAt author { login } comments(last: 50) { nodes { id author { login } body url viewerDidAuthor isMinimized } } reviews(last: 50) { nodes { id author { login } body state } } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state targetUrl } } } } } } } } } } }";

fn nodes(value: &Value) -> Value {
    value["nodes"].clone()
}

fn as_gh_prints(pull: &Value) -> Value {
    let contexts = &pull["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"];
    let checks: Vec<Value> = contexts
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let mut check = c.clone();
            check["workflowName"] = c["checkSuite"]["workflowRun"]["workflow"]["name"].clone();
            check
        })
        .collect();
    let mut out = pull.clone();
    out["comments"] = nodes(&pull["comments"]);
    out["reviews"] = nodes(&pull["reviews"]);
    out["statusCheckRollup"] = json!(checks);
    out
}

pub struct GitHubApi {
    http: reqwest::Client,
    base: String,
    remotes: Remotes,
    token: Mutex<Result<String, String>>,
    problem: Mutex<Option<String>>,
    checked: AtomicBool,
}

impl GitHubApi {
    pub fn new(remotes: Remotes) -> GitHubApi {
        GitHubApi {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent(USER_AGENT)
                .build()
                .expect("an HTTP client"),
            base: BASE.to_string(),
            remotes,
            token: Mutex::new(Err("no GitHub token is set".into())),
            problem: Mutex::new(None),
            checked: AtomicBool::new(false),
        }
    }

    pub fn with_base(mut self, base: &str) -> GitHubApi {
        self.base = base.trim_end_matches('/').to_string();
        self
    }

    pub fn set_token(&self, token: Result<String, String>) {
        *self.token.lock().expect("github token") = token;
    }

    fn token(&self) -> Result<String, String> {
        self.token.lock().expect("github token").clone()
    }

    fn note(&self, problem: Option<String>) {
        self.checked.store(true, Ordering::Relaxed);
        *self.problem.lock().expect("github problem") = problem;
    }

    fn refused(status: StatusCode) -> String {
        match status {
            StatusCode::UNAUTHORIZED => "GitHub refused the token".to_string(),
            StatusCode::FORBIDDEN => "GitHub does not let the token read this".to_string(),
            s => format!("GitHub answered {s}"),
        }
    }

    async fn repo_of(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
    ) -> Result<(String, String), String> {
        let repo = self
            .remotes
            .read(m, path, branch)
            .await
            .ok_or_else(|| format!("the branch {branch} has no remote Yardbell can read"))?;
        if repo.host != HOST {
            return Err(format!(
                "{} is not github.com, so the GitHub token is not sent there",
                repo.host
            ));
        }
        repo.project
            .split_once('/')
            .map(|(owner, name)| (owner.to_string(), name.to_string()))
            .ok_or_else(|| format!("{} is not an owner and a repository", repo.project))
    }

    async fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        let token = self.token()?;
        let res = self
            .http
            .post(format!("{}/graphql", self.base))
            .bearer_auth(&token)
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| format!("GitHub did not answer: {}", e.without_url()))?;
        if !res.status().is_success() {
            return Err(Self::refused(res.status()));
        }
        let answer: Value = res
            .json()
            .await
            .map_err(|_| "GitHub sent an answer Yardbell cannot read".to_string())?;
        if let Some(said) = answer["errors"][0]["message"].as_str() {
            return Err(format!("GitHub said: {said}"));
        }
        Ok(answer)
    }

    async fn rest(&self, path: &str) -> Result<reqwest::Response, String> {
        let token = self.token()?;
        let res = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("GitHub did not answer: {}", e.without_url()))?;
        if res.status().is_success() {
            Ok(res)
        } else {
            Err(Self::refused(res.status()))
        }
    }

    pub async fn create_draft(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
        title: &str,
        body: &str,
    ) -> Result<(String, u64), String> {
        let (owner, name) = self.repo_of(m, path, branch).await?;
        let about: Value = self
            .rest(&format!("/repos/{owner}/{name}"))
            .await?
            .json()
            .await
            .map_err(|_| "GitHub sent an answer Yardbell cannot read".to_string())?;
        let token = self.token()?;
        let res = self
            .http
            .post(format!("{}/repos/{owner}/{name}/pulls", self.base))
            .bearer_auth(&token)
            .json(&json!({
                "head": branch,
                "base": about["default_branch"].as_str().unwrap_or("main"),
                "title": title,
                "body": body,
                "draft": true,
            }))
            .send()
            .await
            .map_err(|e| format!("GitHub did not answer: {}", e.without_url()))?;
        match res.status() {
            s if s.is_success() => {}
            StatusCode::UNPROCESSABLE_ENTITY => {
                return Err(format!(
                    "a pull request for {branch} is already open, or the branch was not pushed"
                ))
            }
            s => return Err(Self::refused(s)),
        }
        let made: Value = res
            .json()
            .await
            .map_err(|_| "GitHub sent an answer Yardbell cannot read".to_string())?;
        Ok((
            made["html_url"].as_str().unwrap_or_default().to_string(),
            made["number"].as_u64().unwrap_or_default(),
        ))
    }

    async fn job_of_run(&self, owner: &str, name: &str, run: &str) -> Option<String> {
        let jobs: Value = self
            .rest(&format!(
                "/repos/{owner}/{name}/actions/runs/{run}/jobs?filter=latest"
            ))
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        jobs["jobs"]
            .as_array()?
            .iter()
            .find(|j| j["conclusion"] == "failure")
            .and_then(|j| j["id"].as_u64())
            .map(|id| id.to_string())
    }
}

impl Forge for GitHubApi {
    fn fetch<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, Fetched> {
        Box::pin(async move {
            let answer = async {
                let (owner, name) = self.repo_of(m, path, branch).await?;
                self.graphql(
                    QUERY,
                    json!({ "owner": owner, "name": name, "branch": branch }),
                )
                .await
            }
            .await;
            let answer = match answer {
                Ok(answer) => answer,
                Err(why) => {
                    self.note(Some(why.clone()));
                    return Fetched::Failed(why);
                }
            };
            self.note(None);
            let list = &answer["data"]["repository"]["pullRequests"]["nodes"];
            let all = list.as_array().map(Vec::as_slice).unwrap_or_default();
            let Some(pull) = all.iter().find(|p| p["state"] == "OPEN").or(all.first()) else {
                return Fetched::NoPull;
            };
            match parse_view(&as_gh_prints(pull).to_string()) {
                Ok(found) => Fetched::Found(Box::new(found)),
                Err(e) => Fetched::Failed(format!("unexpected answer from GitHub: {e}")),
            }
        })
    }

    fn failure_log<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        check: &'a Check,
    ) -> BoxFuture<'a, String> {
        Box::pin(async move {
            let Some(found) = actions_url().captures(&check.url) else {
                return String::new();
            };
            let Ok((owner, name)) = self.repo_of(m, path, "HEAD").await else {
                return String::new();
            };
            let job = match found.get(2) {
                Some(job) => Some(job.as_str().to_string()),
                None => self.job_of_run(&owner, &name, &found[1]).await,
            };
            let Some(job) = job else {
                return String::new();
            };
            match self
                .rest(&format!("/repos/{owner}/{name}/actions/jobs/{job}/logs"))
                .await
            {
                Ok(res) => excerpt(&res.text().await.unwrap_or_default()),
                Err(_) => String::new(),
            }
        })
    }

    fn review_comments<'a>(
        &'a self,
        _m: &'a Machine,
        _path: &'a str,
        review: &'a Note,
    ) -> BoxFuture<'a, Vec<Note>> {
        Box::pin(async move {
            match self
                .graphql(&review_comments_query(), json!({ "id": review.id }))
                .await
            {
                Ok(answer) => parse_review_comments(&answer.to_string(), &review.author),
                Err(_) => Vec::new(),
            }
        })
    }

    fn problem(&self) -> Option<String> {
        self.problem.lock().expect("github problem").clone()
    }

    fn checked(&self) -> bool {
        self.checked.load(Ordering::Relaxed)
    }
}

// GitHub through gh on each machine, or with a token from here, as the settings say.
pub struct GitHubEither {
    gh: Arc<dyn Forge>,
    api: Arc<GitHubApi>,
    use_token: AtomicBool,
}

impl GitHubEither {
    pub fn new(gh: Arc<dyn Forge>, api: Arc<GitHubApi>) -> GitHubEither {
        GitHubEither {
            gh,
            api,
            use_token: AtomicBool::new(false),
        }
    }

    fn current(&self) -> &dyn Forge {
        if self.use_token.load(Ordering::Relaxed) {
            self.api.as_ref()
        } else {
            self.gh.as_ref()
        }
    }
}

impl Forge for GitHubEither {
    fn fetch<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, Fetched> {
        self.current().fetch(m, path, branch)
    }

    fn failure_log<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        check: &'a Check,
    ) -> BoxFuture<'a, String> {
        self.current().failure_log(m, path, check)
    }

    fn review_comments<'a>(
        &'a self,
        m: &'a Machine,
        path: &'a str,
        review: &'a Note,
    ) -> BoxFuture<'a, Vec<Note>> {
        self.current().review_comments(m, path, review)
    }

    fn configure(&self, cfg: &PullRequests, secrets: &Result<Secrets, String>) {
        let token = cfg.github_via == GithubVia::Token;
        self.use_token.store(token, Ordering::Relaxed);
        if token {
            self.api.set_token(match secrets {
                Ok(s) => s.resolve(&cfg.github_token).map_err(|e| e.to_string()),
                Err(e) => Err(e.clone()),
            });
        }
    }

    fn problem(&self) -> Option<String> {
        self.current().problem()
    }

    fn checked(&self) -> bool {
        self.current().checked()
    }
}
