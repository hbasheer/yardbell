use crate::shell::{Duration, Output, Runner};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

pub const LINEAR_API: &str = "https://api.linear.app/graphql";
pub const LINEAR_SECRET: &str = "linear";
const LINEAR_TIMEOUT: Duration = Duration::from_secs(20);
const GH_TIMEOUT: Duration = Duration::from_secs(30);
const NO_GH: i32 = 127;
const NOT_LOGGED_IN: i32 = 4;
const LIMIT: usize = 100;

// Open issues only: done and canceled ones cannot start anything.
pub(crate) const LINEAR_QUERY: &str =
    "query { viewer { assignedIssues(first: 100, orderBy: updatedAt, \
filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }) { nodes { id identifier \
title url state { name } } } } }";

const LINEAR_WHERE: &str = "query($filter: IssueFilter) { viewer { assignedIssues(first: 100, \
orderBy: updatedAt, filter: $filter) { nodes { id identifier title url state { name } } } } }";

// Several names in one list mean any of them; different lists must all match.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LinearFilter {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub teams: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

fn any_of(names: &[String], fields: &[&str]) -> Option<Value> {
    let or: Vec<Value> = names
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .flat_map(|n| {
            fields
                .iter()
                .map(move |f| json!({ *f: { "eqIgnoreCase": n } }))
        })
        .collect();
    (!or.is_empty()).then(|| json!({ "or": or }))
}

impl LinearFilter {
    pub fn is_empty(&self) -> bool {
        [&self.labels, &self.teams, &self.projects]
            .iter()
            .all(|list| list.iter().all(|n| n.trim().is_empty()))
    }

    // Names travel as GraphQL variables, so a name can never change the query.
    pub(crate) fn request(&self) -> (&'static str, Value) {
        if self.is_empty() {
            return (LINEAR_QUERY, json!({}));
        }
        let mut filter = json!({ "state": { "type": { "nin": ["completed", "canceled"] } } });
        if let Some(labels) = any_of(&self.labels, &["name"]) {
            filter["labels"] = json!({ "some": labels });
        }
        if let Some(teams) = any_of(&self.teams, &["key", "name"]) {
            filter["team"] = teams;
        }
        if let Some(projects) = any_of(&self.projects, &["name"]) {
            filter["project"] = projects;
        }
        (LINEAR_WHERE, json!({ "filter": filter }))
    }
}

const QUIET: &str = "GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat NO_COLOR=1; \
export GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER GH_PAGER NO_COLOR; ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub id: String,
    pub ticket: String,
    pub title: String,
    pub url: String,
    pub state: String,
    pub repo: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum GhList {
    Assigned,
    ReviewRequested,
}

pub trait Feeds: Send + Sync {
    fn linear<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<Ticket>, String>>;
    fn linear_where<'a>(
        &'a self,
        key: &'a str,
        filter: &'a LinearFilter,
    ) -> BoxFuture<'a, Result<Vec<Ticket>, String>>;
    fn github(&self, list: GhList) -> BoxFuture<'_, Result<Vec<Ticket>, String>>;
}

pub struct Live {
    http: reqwest::Client,
    linear_url: String,
    runner: Arc<dyn Runner>,
}

impl Live {
    pub fn new(runner: Arc<dyn Runner>) -> Live {
        Live::with_linear_url(runner, LINEAR_API)
    }

    pub fn with_linear_url(runner: Arc<dyn Runner>, url: &str) -> Live {
        Live {
            http: reqwest::Client::new(),
            linear_url: url.to_string(),
            runner,
        }
    }
}

impl Feeds for Live {
    fn linear<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<Ticket>, String>> {
        Box::pin(async move { self.ask_linear(key, &LinearFilter::default()).await })
    }

    fn linear_where<'a>(
        &'a self,
        key: &'a str,
        filter: &'a LinearFilter,
    ) -> BoxFuture<'a, Result<Vec<Ticket>, String>> {
        Box::pin(self.ask_linear(key, filter))
    }

    fn github(&self, list: GhList) -> BoxFuture<'_, Result<Vec<Ticket>, String>> {
        Box::pin(async move {
            let out = self
                .runner
                .run(
                    vec!["bash".into(), "-c".into(), gh_command(list)],
                    None,
                    GH_TIMEOUT,
                )
                .await;
            read_gh(&out)
        })
    }
}

impl Live {
    async fn ask_linear(&self, key: &str, filter: &LinearFilter) -> Result<Vec<Ticket>, String> {
        let (query, variables) = filter.request();
        let res = self
            .http
            .post(&self.linear_url)
            .header("Authorization", key)
            .timeout(LINEAR_TIMEOUT)
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| format!("Linear did not answer: {e}"))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|e| format!("Linear's answer could not be read: {e}"))?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(format!(
                    "Linear refused the API key in the secret {LINEAR_SECRET}. Replace it under Settings, MCP servers, Secrets"
                ));
        }
        if !status.is_success() && !body.trim_start().starts_with('{') {
            return Err(format!("Linear answered {status}"));
        }
        parse_linear(&body)
    }
}

#[derive(Deserialize)]
struct Named {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct LinearIssue {
    id: String,
    #[serde(default)]
    identifier: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: Option<Named>,
}

pub fn parse_linear(body: &str) -> Result<Vec<Ticket>, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|_| "Linear's answer was not JSON".to_string())?;
    if let Some(first) = v["errors"].as_array().and_then(|e| e.first()) {
        let said = first["message"].as_str().unwrap_or("an error");
        let auth = first["extensions"]["type"] == "authentication error"
            || first["extensions"]["code"] == "AUTHENTICATION_ERROR";
        return Err(if auth {
            format!(
                "Linear refused the API key in the secret {LINEAR_SECRET}. Replace it under Settings, MCP servers, Secrets"
            )
        } else {
            format!("Linear said: {said}")
        });
    }
    let nodes = v["data"]["viewer"]["assignedIssues"]["nodes"]
        .as_array()
        .ok_or("Linear's answer has no issues list")?;
    Ok(nodes
        .iter()
        .filter_map(|n| serde_json::from_value::<LinearIssue>(n.clone()).ok())
        .map(|i| Ticket {
            id: i.id,
            ticket: i.identifier,
            title: i.title,
            url: i.url,
            state: i.state.map(|s| s.name).unwrap_or_default(),
            repo: String::new(),
        })
        .collect())
}

pub fn gh_command(list: GhList) -> String {
    let search = match list {
        GhList::Assigned => "issues --assignee=@me",
        GhList::ReviewRequested => "prs --review-requested=@me",
    };
    format!(
        "{QUIET}cd \"$HOME\" 2>/dev/null; command -v gh >/dev/null 2>&1 || exit {NO_GH}; \
gh search {search} --state=open --json number,title,url,repository --limit {LIMIT}"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repo {
    #[serde(default)]
    name_with_owner: String,
}

#[derive(Deserialize)]
struct GhItem {
    number: u64,
    #[serde(default)]
    title: String,
    url: String,
    #[serde(default)]
    repository: Option<Repo>,
}

pub fn read_gh(out: &Output) -> Result<Vec<Ticket>, String> {
    if out.timed_out {
        return Err("gh took too long to answer".into());
    }
    match out.status {
        Some(0) => {}
        Some(NO_GH) => return Err("gh is not installed on this machine".into()),
        Some(NOT_LOGGED_IN) => {
            return Err("gh is not logged in on this machine. Run gh auth login there".into())
        }
        _ => {
            let said = out
                .stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("gh failed");
            return Err(format!("gh said: {said}"));
        }
    }
    let items: Vec<GhItem> = serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("unexpected gh output: {e}"))?;
    Ok(items
        .into_iter()
        .map(|i| {
            let repo = i.repository.map(|r| r.name_with_owner).unwrap_or_default();
            Ticket {
                id: i.url.clone(),
                ticket: format!("{repo}#{}", i.number),
                title: i.title,
                url: i.url,
                state: "open".into(),
                repo,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRunner;
    use axum::http::HeaderMap;
    use axum::routing::post;
    use axum::Json;

    const ANSWER: &str = r#"{"data":{"viewer":{"assignedIssues":{"nodes":[
        {"id":"i-1","identifier":"ENG-12","title":"Fix login","url":"https://linear.app/acme/issue/ENG-12","state":{"name":"Todo"}},
        {"id":"i-2","identifier":"ENG-13","title":"Docs","url":"https://linear.app/acme/issue/ENG-13","state":{"name":"In Progress"}},
        {"broken":true}
    ]}}}}"#;

    async fn stub_linear() -> String {
        let app = axum::Router::new().route(
            "/graphql",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                let key = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let query = body["query"].as_str().unwrap_or_default();
                if !query.contains("assignedIssues") {
                    return (axum::http::StatusCode::BAD_REQUEST, "no query".to_string());
                }
                match key.as_str() {
                    "lin_api_good" => (axum::http::StatusCode::OK, ANSWER.to_string()),
                    "lin_api_gql" => (
                        axum::http::StatusCode::BAD_REQUEST,
                        r#"{"errors":[{"message":"Authentication required, not authenticated","extensions":{"type":"authentication error","code":"AUTHENTICATION_ERROR"}}]}"#.to_string(),
                    ),
                    _ => (axum::http::StatusCode::UNAUTHORIZED, "nope".to_string()),
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}/graphql")
    }

    #[tokio::test]
    async fn linear_issues_are_read_with_the_key_from_the_secret() {
        let url = stub_linear().await;
        let live = Live::with_linear_url(Arc::new(FakeRunner::default()), &url);
        let tickets = live.linear("lin_api_good").await.unwrap();
        assert_eq!(tickets.len(), 2, "a node that does not parse is left out");
        assert_eq!(
            tickets[0],
            Ticket {
                id: "i-1".into(),
                ticket: "ENG-12".into(),
                title: "Fix login".into(),
                url: "https://linear.app/acme/issue/ENG-12".into(),
                state: "Todo".into(),
                repo: String::new(),
            }
        );
        for key in ["lin_api_bad", "lin_api_gql"] {
            let err = live.linear(key).await.unwrap_err();
            assert!(
                err.contains("refused the API key in the secret linear"),
                "{err}"
            );
            assert!(!err.contains(key), "the key is never repeated: {err}");
        }
        let down = Live::with_linear_url(
            Arc::new(FakeRunner::default()),
            "http://127.0.0.1:1/graphql",
        );
        assert!(down
            .linear("lin_api_good")
            .await
            .unwrap_err()
            .starts_with("Linear did not answer"));
    }

    #[test]
    fn no_filter_asks_linear_what_it_always_did() {
        assert_eq!(LinearFilter::default().request().0, LINEAR_QUERY);
        let blank = LinearFilter {
            labels: vec![" ".into()],
            ..Default::default()
        };
        assert!(blank.is_empty());
    }

    #[test]
    fn a_filter_asks_linear_with_names_as_variables() {
        let filter = LinearFilter {
            labels: vec!["agent-ready".into(), "bug\" } } { x".into()],
            teams: vec!["ENG".into()],
            projects: vec!["Billing".into()],
        };
        let (query, variables) = filter.request();
        assert!(query.contains("$filter: IssueFilter"), "{query}");
        assert!(!query.contains("agent-ready") && !query.contains("bug"));
        let f = &variables["filter"];
        assert_eq!(f["state"]["type"]["nin"][0], "completed", "still open only");
        assert_eq!(
            f["labels"]["some"]["or"][0]["name"]["eqIgnoreCase"],
            "agent-ready"
        );
        assert_eq!(f["team"]["or"][0]["key"]["eqIgnoreCase"], "ENG");
        assert_eq!(f["team"]["or"][1]["name"]["eqIgnoreCase"], "ENG");
        assert_eq!(f["project"]["or"][0]["name"]["eqIgnoreCase"], "Billing");
    }

    #[test]
    fn linear_errors_are_said_plainly() {
        assert_eq!(
            parse_linear(r#"{"errors":[{"message":"Rate limited"}]}"#).unwrap_err(),
            "Linear said: Rate limited"
        );
        assert_eq!(
            parse_linear("<html>").unwrap_err(),
            "Linear's answer was not JSON"
        );
        assert_eq!(
            parse_linear(r#"{"data":{}}"#).unwrap_err(),
            "Linear's answer has no issues list"
        );
    }

    #[tokio::test]
    async fn github_issues_and_review_requests_are_read_from_gh() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "gh search issues --assignee=@me",
            Output::ok_with(
                r#"[{"number":7,"title":"Crash on save","url":"https://github.com/acme/web/issues/7","repository":{"name":"web","nameWithOwner":"acme/web"}}]"#,
            ),
        );
        fake.stub(
            "gh search prs --review-requested=@me",
            Output::ok_with(
                r#"[{"number":9,"title":"Add login","url":"https://github.com/acme/api/pull/9","repository":{"nameWithOwner":"acme/api"}}]"#,
            ),
        );
        let live = Live::new(fake.clone());
        let issues = live.github(GhList::Assigned).await.unwrap();
        assert_eq!(
            issues,
            [Ticket {
                id: "https://github.com/acme/web/issues/7".into(),
                ticket: "acme/web#7".into(),
                title: "Crash on save".into(),
                url: "https://github.com/acme/web/issues/7".into(),
                state: "open".into(),
                repo: "acme/web".into(),
            }]
        );
        let reviews = live.github(GhList::ReviewRequested).await.unwrap();
        assert_eq!(reviews[0].ticket, "acme/api#9");
        let call = fake.calls()[0].join(" ");
        assert!(call.starts_with("bash -c GH_PROMPT_DISABLED=1"), "{call}");
        assert!(call.contains("--state=open --json number,title,url,repository"));
    }

    #[test]
    fn gh_missing_logged_out_or_failing_is_named() {
        assert_eq!(
            read_gh(&Output::failed(127, "")).unwrap_err(),
            "gh is not installed on this machine"
        );
        assert!(read_gh(&Output::failed(4, ""))
            .unwrap_err()
            .contains("gh auth login"));
        assert_eq!(
            read_gh(&Output::failed(1, "\nHTTP 502: bad gateway\n")).unwrap_err(),
            "gh said: HTTP 502: bad gateway"
        );
        assert_eq!(
            read_gh(&Output::timeout()).unwrap_err(),
            "gh took too long to answer"
        );
        assert!(read_gh(&Output::ok_with("not json"))
            .unwrap_err()
            .starts_with("unexpected gh output"));
        assert_eq!(read_gh(&Output::ok_with("[]\n")).unwrap(), []);
    }
}
