use super::checks::Read;
use super::record::PullRef;
use crate::config::Machine;
use crate::pulls::{Answer, Fetched, Forge as _, GitHub, GitLab, GitLabAccess, Pull, Remotes};
use crate::shell::{quote, Duration, Runner};
use crate::ssh::Ssh;
use serde_json::{json, Value};
use std::sync::Arc;

const GH_TIMEOUT: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const NO_GH: i32 = 127;
const CHECKS_WITH_LOGS: usize = 4;
const NOT_LOGGED_IN: i32 = 4;
const QUIET: &str = "GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat NO_COLOR=1; \
export GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER GH_PAGER NO_COLOR; ";

pub struct Forge {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
    http: reqwest::Client,
}

// What a draft pull or merge request is opened with.
pub struct Draft {
    pub branch: String,
    pub title: String,
    pub body: String,
}

fn number(url: &str) -> Option<u64> {
    url.trim_end_matches('/').rsplit('/').next()?.parse().ok()
}

impl Forge {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> Forge {
        Forge {
            runner,
            ssh,
            http: reqwest::Client::new(),
        }
    }

    pub fn remotes(&self) -> Remotes {
        Remotes::new(self.runner.clone(), self.ssh.clone())
    }

    fn gitlab(&self) -> GitLab {
        GitLab::new().with_runner(self.runner.clone(), self.ssh.clone())
    }

    // Only a host listed under pull_requests.gitlab goes to GitLab; the switches for badges and
    // cards do not stop a step someone put in a pipeline.
    async fn gitlab_place(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
        gitlab: &[GitLabAccess],
    ) -> Option<(GitLabAccess, String)> {
        if gitlab.is_empty() {
            return None;
        }
        let repo = self.remotes().read(m, path, branch).await?;
        let access = gitlab.iter().find(|g| g.host == repo.host)?;
        Some((access.on(m), repo.project))
    }

    pub async fn read_pull(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
        gitlab: &[GitLabAccess],
        github: Option<&crate::pulls::github_api::GitHubApi>,
    ) -> Read {
        if let Some((access, project)) = self.gitlab_place(m, path, branch, gitlab).await {
            let host = &access.host;
            return match self.gitlab().fetch(&access, &project, branch).await {
                Answer::Pull(pull) | Answer::Partial(pull) => Read::Found(pull),
                Answer::NoPull => Read::NoPull,
                Answer::Failed(why) => Read::Problem(format!("{host} could not be read: {why}")),
                Answer::Refused(why) => Read::Blocked(format!("{host} refused the token: {why}")),
            };
        }
        let fetched = match github {
            Some(api) => api.fetch(m, path, branch).await,
            None => {
                let gh = GitHub::new(self.runner.clone(), self.ssh.clone());
                gh.fetch(m, path, branch).await
            }
        };
        match fetched {
            Fetched::Found(pull) => Read::Found(pull),
            Fetched::NoPull => Read::NoPull,
            Fetched::NoTool => Read::Blocked(crate::pulls::no_gh(&m.name)),
            Fetched::Failed(why) => Read::Problem(crate::pulls::gh_failed(&why)),
        }
    }

    // The failed logs, the comments on lines and which of them are resolved cost a call each, so
    // only a reading that will say something asks for them.
    pub async fn pull_detail(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
        mut pull: Pull,
        gitlab: &[GitLabAccess],
        github: Option<&crate::pulls::github_api::GitHubApi>,
    ) -> Pull {
        if let Some((access, project)) = self.gitlab_place(m, path, branch, gitlab).await {
            let reader = self.gitlab();
            for check in pull.failed.iter_mut().take(CHECKS_WITH_LOGS) {
                check.log = reader.failure_log(&access, &project, check).await;
            }
            return pull;
        }
        let gh = GitHub::new(self.runner.clone(), self.ssh.clone());
        let forge: &dyn crate::pulls::Forge = match github {
            Some(api) => api,
            None => &gh,
        };
        for check in pull.failed.iter_mut().take(CHECKS_WITH_LOGS) {
            check.log = forge.failure_log(m, path, check).await;
        }
        pull.notes = crate::pulls::with_comments_on_lines(forge, m, path, &pull.notes, false).await;
        pull.resolved = forge.resolved_comments(m, path, pull.number).await;
        pull
    }

    // GitHub through gh on the machine the branch was pushed from; a host listed under
    // pull_requests.gitlab through GitLab's API from here, with the token the watcher uses.
    pub async fn open_draft(
        &self,
        m: &Machine,
        path: &str,
        d: &Draft,
        gitlab: &[GitLabAccess],
        github: Option<&crate::pulls::github_api::GitHubApi>,
    ) -> Result<PullRef, String> {
        let repo = Remotes::new(self.runner.clone(), self.ssh.clone())
            .read(m, path, &d.branch)
            .await
            .ok_or_else(|| format!("the branch {} has no remote Yardbell can read", d.branch))?;
        match gitlab.iter().find(|g| g.host == repo.host) {
            Some(access) if access.glab => {
                self.merge_request_glab(m, access, &repo.project, d).await
            }
            Some(access) => self.merge_request(access, &repo.project, d).await,
            None => match github {
                Some(api) => api
                    .create_draft(m, path, &d.branch, &d.title, &d.body)
                    .await
                    .map(|(url, number)| PullRef { url, number }),
                None => self.pull_request(m, path, d).await,
            },
        }
    }

    async fn pull_request(&self, m: &Machine, path: &str, d: &Draft) -> Result<PullRef, String> {
        let script = format!(
            "{QUIET}cd {} 2>/dev/null || exit 1; command -v gh >/dev/null 2>&1 || exit {NO_GH}; \
gh pr create --draft --head {} --title {} --body-file -",
            quote(path),
            quote(&d.branch),
            quote(&d.title.clone())
        );
        let out = self
            .runner
            .run(
                self.ssh.command(m, &script),
                Some(d.body.clone()),
                GH_TIMEOUT,
            )
            .await;
        match out.status {
            Some(0) => {}
            Some(NO_GH) => return Err(format!("gh is not installed on {}", m.name)),
            Some(NOT_LOGGED_IN) => return Err(format!("gh is not logged in on {}", m.name)),
            _ => {
                let said = out
                    .stderr
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("no reason given");
                return Err(format!("gh pr create failed on {}: {said}", m.name));
            }
        }
        let url = out
            .stdout
            .lines()
            .map(str::trim)
            .rfind(|l| l.starts_with("https://") && l.contains("/pull/"))
            .ok_or("gh did not print the new pull request's address")?;
        Ok(PullRef {
            url: url.to_string(),
            number: number(url).unwrap_or_default(),
        })
    }

    async fn merge_request_glab(
        &self,
        m: &Machine,
        access: &GitLabAccess,
        project: &str,
        d: &Draft,
    ) -> Result<PullRef, String> {
        use crate::pulls::{glab_error, run_glab};
        let base = format!("projects/{}", encode(project));
        let about = run_glab(self.runner.as_ref(), &self.ssh, m, &access.host, &base, &[]).await;
        if !about.ok() {
            return Err(glab_error(
                about.status,
                &about.stderr,
                &access.host,
                &m.name,
            ));
        }
        let cannot_read = || format!("glab on {} sent an answer Yardbell cannot read", m.name);
        let about: Value = serde_json::from_str(&about.stdout).map_err(|_| cannot_read())?;
        let target = about["default_branch"].as_str().unwrap_or("main");
        let title = format!("Draft: {}", d.title);
        let fields = [
            ("source_branch", d.branch.as_str()),
            ("target_branch", target),
            ("title", title.as_str()),
            ("description", d.body.as_str()),
        ];
        let made = run_glab(
            self.runner.as_ref(),
            &self.ssh,
            m,
            &access.host,
            &format!("{base}/merge_requests"),
            &fields,
        )
        .await;
        if !made.ok() {
            return Err(glab_error(made.status, &made.stderr, &access.host, &m.name));
        }
        let made: Value = serde_json::from_str(&made.stdout).map_err(|_| cannot_read())?;
        Ok(PullRef {
            url: made["web_url"].as_str().unwrap_or_default().to_string(),
            number: made["iid"].as_u64().unwrap_or_default(),
        })
    }

    async fn merge_request(
        &self,
        access: &GitLabAccess,
        project: &str,
        d: &Draft,
    ) -> Result<PullRef, String> {
        let token = access.token.as_ref().map_err(Clone::clone)?;
        let base = format!(
            "{}/projects/{}",
            access.api.trim_end_matches('/'),
            encode(project)
        );
        let refused = |status: reqwest::StatusCode| match status {
            reqwest::StatusCode::UNAUTHORIZED => {
                format!(
                    "GitLab at {} refused the token in the secret {}",
                    access.host, access.secret
                )
            }
            reqwest::StatusCode::FORBIDDEN => format!(
                "the GitLab token for {} needs the api scope to open a merge request",
                access.host
            ),
            reqwest::StatusCode::CONFLICT => {
                format!("a merge request for {} is already open", d.branch)
            }
            s => format!("GitLab at {} answered {s}", access.host),
        };
        let unanswered = |_| format!("GitLab at {} did not answer", access.host);
        let res = self
            .http
            .get(&base)
            .header("PRIVATE-TOKEN", token)
            .timeout(HTTP_TIMEOUT)
            .send()
            .await
            .map_err(unanswered)?;
        if !res.status().is_success() {
            return Err(refused(res.status()));
        }
        let project: Value = res.json().await.map_err(|_| {
            format!(
                "GitLab at {} sent an answer Yardbell cannot read",
                access.host
            )
        })?;
        let target = project["default_branch"]
            .as_str()
            .unwrap_or("main")
            .to_string();
        let res = self
            .http
            .post(format!("{base}/merge_requests"))
            .header("PRIVATE-TOKEN", token)
            .timeout(HTTP_TIMEOUT)
            .json(&json!({
                "source_branch": d.branch,
                "target_branch": target,
                "title": format!("Draft: {}", d.title.clone()),
                "description": d.body.clone(),
            }))
            .send()
            .await
            .map_err(unanswered)?;
        if !res.status().is_success() {
            return Err(refused(res.status()));
        }
        let made: Value = res.json().await.map_err(|_| {
            format!(
                "GitLab at {} sent an answer Yardbell cannot read",
                access.host
            )
        })?;
        Ok(PullRef {
            url: made["web_url"].as_str().unwrap_or_default().to_string(),
            number: made["iid"].as_u64().unwrap_or_default(),
        })
    }
}

fn encode(project: &str) -> String {
    project
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use crate::worktrees::testing::machine;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use std::sync::Mutex;

    fn draft() -> Draft {
        Draft {
            branch: "com-1-fix".into(),
            title: "COM-1 Fix".into(),
            body: "Fixed the redirect.\nTested on Safari.".into(),
        }
    }

    fn forge(runner: &Arc<FakeRunner>) -> Forge {
        let dir = tempfile::tempdir().unwrap();
        Forge::new(runner.clone(), Ssh::new(dir.keep()))
    }

    #[tokio::test]
    async fn github_runs_gh_pr_create_draft() {
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "remote get-url",
            Output::ok_with("git@github.com:acme/app.git\n"),
        );
        runner.stub(
            "gh pr create",
            Output::ok_with("Creating draft...\nhttps://github.com/acme/app/pull/12\n"),
        );
        let pull = forge(&runner)
            .open_draft(&machine("hp"), "/r/acme/app", &draft(), &[], None)
            .await
            .unwrap();
        assert_eq!(
            pull,
            PullRef {
                url: "https://github.com/acme/app/pull/12".into(),
                number: 12
            }
        );
        let calls = runner.calls();
        let create = calls
            .iter()
            .map(|c| c.join(" "))
            .find(|c| c.contains("gh pr create"))
            .unwrap();
        assert!(
            create.contains("--draft") && create.contains("--head 'com-1-fix'"),
            "{create}"
        );
        assert!(
            create.contains("--title 'COM-1 Fix'") && create.contains("--body-file -"),
            "{create}"
        );
        let inputs = runner.inputs();
        assert!(inputs
            .iter()
            .flatten()
            .any(|i| i.contains("Tested on Safari.")));
    }

    #[tokio::test]
    async fn github_without_gh_says_so() {
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "remote get-url",
            Output::ok_with("https://github.com/acme/app.git\n"),
        );
        runner.stub(
            "gh pr create",
            Output::failed(
                4,
                "To get started with GitHub CLI, please run: gh auth login",
            ),
        );
        let err = forge(&runner)
            .open_draft(&machine("hp"), "/r/acme/app", &draft(), &[], None)
            .await
            .unwrap_err();
        assert_eq!(err, "gh is not logged in on hp");
    }

    const VIEW: &str = r#"{"number":12,"url":"https://github.com/acme/app/pull/12","state":"OPEN","headRefOid":"abc","author":{"login":"me"},
        "statusCheckRollup":[{"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/acme/app/actions/runs/5/job/6"}],
        "reviews":[{"id":"r1","author":{"login":"alice"},"state":"CHANGES_REQUESTED","body":""}],
        "comments":[{"id":"c1","author":{"login":"alice"},"body":"Rename it","url":"cu"}]}"#;

    #[tokio::test]
    async fn a_github_pull_is_read_with_its_logs_lines_and_resolved_comments() {
        let runner = Arc::new(FakeRunner::default());
        runner.stub("gh pr view", Output::ok_with(VIEW));
        runner.stub("gh run view", Output::ok_with("step\tjob\terror: boom\n"));
        runner.stub(
            "PullRequestReview",
            Output::ok_with(
                r#"{"data":{"node":{"comments":{"nodes":[{"id":"i1","path":"a.rs","line":3,"body":"Wrong","url":"iu"},{"id":"i2","path":"b.rs","line":4,"body":"Fixed","url":"iu2"}]}}}}"#,
            ),
        );
        runner.stub(
            "reviewThreads",
            Output::ok_with(
                r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":true,"comments":{"nodes":[{"id":"i2"}]}}]}}}}}"#,
            ),
        );
        let f = forge(&runner);
        let m = machine("hp");
        let Read::Found(pull) = f.read_pull(&m, "/r/w", "b", &[], None).await else {
            panic!("no pull")
        };
        assert_eq!(pull.failed[0].log, "", "logs only when asked for");
        let pull = f.pull_detail(&m, "/r/w", "b", *pull, &[], None).await;
        assert_eq!(pull.failed[0].log, "error: boom");
        assert_eq!(pull.asking, vec!["r1"]);
        assert_eq!(pull.resolved, vec!["i2"]);
        let ids: Vec<&str> = pull.notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "i1", "i2"]);
    }

    #[tokio::test]
    async fn no_gh_blocks_the_wait_and_a_failure_is_asked_again() {
        let runner = Arc::new(FakeRunner::default());
        runner.stub("gh pr view", Output::failed(4, "log in"));
        let f = forge(&runner);
        assert_eq!(
            f.read_pull(&machine("hp"), "/r/w", "b", &[], None).await,
            Read::Blocked("gh is not installed or not signed in on hp".into())
        );
        let runner = Arc::new(FakeRunner::default());
        runner.stub("gh pr view", Output::failed(1, "network down"));
        assert_eq!(
            forge(&runner)
                .read_pull(&machine("hp"), "/r/w", "b", &[], None)
                .await,
            Read::Problem("gh could not read this branch: network down".into())
        );
    }

    #[tokio::test]
    async fn a_gitlab_merge_request_is_read_with_its_failed_job_log() {
        use crate::pulls::gitlab_stub::{serve, Answers};
        let stub = serve(Answers::default()).await;
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "remote get-url",
            Output::ok_with("git@git.commslayer.com:commslayer/app.git\n"),
        );
        let f = forge(&runner);
        let hosts = [stub.access("glpat-good")];
        let m = machine("hp");
        let read = f.read_pull(&m, "/r/w", "b", &hosts, None).await;
        let Read::Found(pull) = read else {
            panic!("no merge request: {read:?}")
        };
        assert_eq!(pull.forge, "gitlab");
        let pull = f.pull_detail(&m, "/r/w", "b", *pull, &hosts, None).await;
        assert!(
            !pull.failed.is_empty() && !pull.failed[0].log.is_empty(),
            "{pull:?}"
        );
        assert!(!runner.calls().iter().any(|c| c.join(" ").contains("gh ")));
    }

    type Requests = Arc<Mutex<Vec<(String, String, String, String)>>>;

    async fn fake_gitlab(status: StatusCode, seen: Requests) -> String {
        let app = axum::Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            async move {
                let method = req.method().to_string();
                let path = req.uri().path().to_string();
                let token = req
                    .headers()
                    .get("PRIVATE-TOKEN")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap();
                seen.lock().unwrap().push((method.clone(), path.clone(), token, String::from_utf8_lossy(&body).to_string()));
                if method == "GET" {
                    return (StatusCode::OK, json!({"default_branch": "develop"}).to_string());
                }
                if status != StatusCode::CREATED {
                    return (status, "{}".to_string());
                }
                (status, json!({"web_url": "https://git.example.com/acme/app/-/merge_requests/87", "iid": 87}).to_string())
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}/api/v4")
    }

    fn access(api: &str) -> GitLabAccess {
        GitLabAccess {
            host: "git.example.com".into(),
            api: api.into(),
            secret: "gitlab".into(),
            token: Ok("glpat-secret".into()),
            glab: false,
            machine: None,
        }
    }

    #[tokio::test]
    async fn gitlab_opens_a_draft_merge_request() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let api = fake_gitlab(StatusCode::CREATED, seen.clone()).await;
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "remote get-url",
            Output::ok_with("git@git.example.com:acme/app.git\n"),
        );
        let pull = forge(&runner)
            .open_draft(
                &machine("hp"),
                "/r/acme/app",
                &draft(),
                &[access(&api)],
                None,
            )
            .await
            .unwrap();
        assert_eq!(pull.number, 87);
        let seen = seen.lock().unwrap();
        let (method, path, token, body) = seen.last().unwrap();
        assert_eq!(
            (method.as_str(), path.as_str()),
            ("POST", "/api/v4/projects/acme%2Fapp/merge_requests")
        );
        assert_eq!(token, "glpat-secret");
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["title"], "Draft: COM-1 Fix");
        assert_eq!(body["source_branch"], "com-1-fix");
        assert_eq!(body["target_branch"], "develop");
        assert!(body["description"]
            .as_str()
            .unwrap()
            .contains("Tested on Safari."));
        assert!(runner.calls().iter().all(|c| !c.join(" ").contains("gh ")));
    }

    #[tokio::test]
    async fn gitlab_without_api_scope_says_so() {
        let api = fake_gitlab(StatusCode::FORBIDDEN, Arc::default()).await;
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "remote get-url",
            Output::ok_with("git@git.example.com:acme/app.git\n"),
        );
        let err = forge(&runner)
            .open_draft(
                &machine("hp"),
                "/r/acme/app",
                &draft(),
                &[access(&api)],
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(
            err,
            "the GitLab token for git.example.com needs the api scope to open a merge request"
        );
        assert!(!err.contains("glpat"));
    }

    #[tokio::test]
    async fn glab_opens_a_draft_merge_request_on_the_machine() {
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "remote get-url",
            Output::ok_with("git@git.example.com:acme/app.git\n"),
        );
        runner.stub(
            "merge_requests",
            Output::ok_with(
                r#"{"web_url":"https://git.example.com/acme/app/-/merge_requests/7","iid":7}"#,
            ),
        );
        runner.stub("glab api", Output::ok_with(r#"{"default_branch":"trunk"}"#));
        let mut one = access("https://git.example.com/api/v4");
        one.glab = true;
        one.token = Ok(String::new());
        let pull = forge(&runner)
            .open_draft(&machine("hp"), "/r/acme/app", &draft(), &[one], None)
            .await
            .unwrap();
        assert_eq!(pull.number, 7);
        let calls = runner.calls().concat().join(" ");
        assert!(
            calls.contains("--raw-field") && calls.contains("target_branch=trunk"),
            "{calls}"
        );
        assert!(calls.contains("Draft: COM-1 Fix"), "{calls}");
    }
}
