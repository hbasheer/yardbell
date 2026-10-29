use super::legacy::{PullRef, Record};
use crate::config::Machine;
use crate::pulls::{GitLabAccess, Remotes};
use crate::shell::{quote, Duration, Runner};
use crate::ssh::Ssh;
use serde_json::{json, Value};
use std::sync::Arc;

const GH_TIMEOUT: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const NO_GH: i32 = 127;
const NOT_LOGGED_IN: i32 = 4;
const QUIET: &str = "GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat NO_COLOR=1; \
export GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER GH_PAGER NO_COLOR; ";

pub struct Forge {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
    http: reqwest::Client,
}

fn body(r: &Record) -> String {
    if r.summary.trim().is_empty() {
        r.outcome.clone()
    } else {
        r.summary.clone()
    }
}

fn title(r: &Record) -> String {
    format!("{} {}", r.id, r.title)
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

    // GitHub through gh on the machine the branch was pushed from; a host listed under
    // pull_requests.gitlab through GitLab's API from here, with the token the watcher uses.
    pub async fn open_draft(
        &self,
        m: &Machine,
        path: &str,
        r: &Record,
        gitlab: &[GitLabAccess],
    ) -> Result<PullRef, String> {
        let repo = Remotes::new(self.runner.clone(), self.ssh.clone())
            .read(m, path, &r.branch)
            .await
            .ok_or_else(|| format!("the branch {} has no remote Yardbell can read", r.branch))?;
        match gitlab.iter().find(|g| g.host == repo.host) {
            Some(access) => self.merge_request(access, &repo.project, r).await,
            None => self.pull_request(m, path, r).await,
        }
    }

    async fn pull_request(&self, m: &Machine, path: &str, r: &Record) -> Result<PullRef, String> {
        let script = format!(
            "{QUIET}cd {} 2>/dev/null || exit 1; command -v gh >/dev/null 2>&1 || exit {NO_GH}; \
gh pr create --draft --head {} --title {} --body-file -",
            quote(path),
            quote(&r.branch),
            quote(&title(r))
        );
        let out = self
            .runner
            .run(self.ssh.command(m, &script), Some(body(r)), GH_TIMEOUT)
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

    async fn merge_request(
        &self,
        access: &GitLabAccess,
        project: &str,
        r: &Record,
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
                format!("a merge request for {} is already open", r.branch)
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
                "source_branch": r.branch,
                "target_branch": target,
                "title": format!("Draft: {}", title(r)),
                "description": body(r),
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
    use crate::pipeline::legacy::Stage;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use crate::worktrees::testing::machine;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use std::sync::Mutex;

    fn record() -> Record {
        Record {
            id: "COM-1".into(),
            title: "Fix".into(),
            branch: "com-1-fix".into(),
            machine: "hp".into(),
            stage: Stage::Finish,
            summary: "Fixed the redirect.\nTested on Safari.".into(),
            ..Record::default()
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
            .open_draft(&machine("hp"), "/r/acme/app", &record(), &[])
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
            .open_draft(&machine("hp"), "/r/acme/app", &record(), &[])
            .await
            .unwrap_err();
        assert_eq!(err, "gh is not logged in on hp");
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
            .open_draft(&machine("hp"), "/r/acme/app", &record(), &[access(&api)])
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
            .open_draft(&machine("hp"), "/r/acme/app", &record(), &[access(&api)])
            .await
            .unwrap_err();
        assert_eq!(
            err,
            "the GitLab token for git.example.com needs the api scope to open a merge request"
        );
        assert!(!err.contains("glpat"));
    }
}
