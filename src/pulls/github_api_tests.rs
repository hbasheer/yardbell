use super::github_api::{GitHubApi, GitHubEither};
use super::{Fetched, Forge, Remotes};
use crate::config::{GithubVia, Machine, PullRequests};
use crate::connectors::tests::stub;
use crate::shell::Output;
use crate::ssh::Ssh;
use crate::testing::FakeRunner;
use serde_json::json;
use std::sync::Arc;

fn machine() -> Machine {
    serde_yaml::from_str("name: hp\nlocal: true\nroot: /r\n").unwrap()
}

fn remotes(fake: &Arc<FakeRunner>, url: &str) -> Remotes {
    fake.stub("remote get-url", Output::ok_with(url));
    Remotes::new(fake.clone(), Ssh::new(std::path::PathBuf::from("/tmp/ssh")))
}

fn api(fake: &Arc<FakeRunner>, base: &str, url: &str) -> GitHubApi {
    let api = GitHubApi::new(remotes(fake, url)).with_base(base);
    api.set_token(Ok("shh-gh-token".into()));
    api
}

fn pull(state: &str, number: u64) -> serde_json::Value {
    json!({
        "number": number, "url": format!("https://github.com/acme/app/pull/{number}"),
        "title": "Fix login", "state": state, "isDraft": false, "reviewDecision": "CHANGES_REQUESTED",
        "headRefOid": "abc", "author": { "login": "me" }, "createdAt": "2026-10-30T10:00:00Z",
        "comments": { "nodes": [{ "id": "c1", "author": { "login": "reviewer" }, "body": "Please fix", "url": "https://github.com/c1", "viewerDidAuthor": false, "isMinimized": false }] },
        "reviews": { "nodes": [{ "id": "r1", "author": { "login": "reviewer" }, "body": "No", "state": "CHANGES_REQUESTED" }] },
        "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
            { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://github.com/acme/app/actions/runs/1/job/2",
              "checkSuite": { "workflowRun": { "workflow": { "name": "CI" } } } },
            { "__typename": "StatusContext", "context": "lint", "state": "SUCCESS", "targetUrl": "https://ci.example/1" },
        ] } } } }] },
    })
}

fn answer(nodes: Vec<serde_json::Value>) -> String {
    json!({ "data": { "repository": { "pullRequests": { "nodes": nodes } } } }).to_string()
}

#[tokio::test]
async fn a_token_reads_a_pull_request_as_gh_does() {
    let s = stub().await;
    s.answer("/graphql", 200, &answer(vec![pull("OPEN", 12)]));
    let fake = Arc::new(FakeRunner::default());
    let got = api(&fake, &s.base, "git@github.com:acme/app.git")
        .fetch(&machine(), "/r/app", "fix")
        .await;
    let Fetched::Found(found) = got else {
        panic!("{got:?}")
    };
    assert_eq!(found.number, 12);
    assert_eq!(found.ci, super::Ci::Failing);
    assert_eq!(found.failed[0].name, "CI / test");
    assert!(
        found.notes.iter().any(|n| n.id == "c1"),
        "{:?}",
        found.notes
    );
    let calls = fake.calls().concat().join(" ");
    assert!(
        !calls.contains("shh-gh-token"),
        "the token stays off every command line"
    );
    assert!(!calls.contains("gh pr"), "it needs no gh");
}

#[tokio::test]
async fn an_open_pull_request_comes_before_a_closed_one() {
    let s = stub().await;
    s.answer(
        "/graphql",
        200,
        &answer(vec![pull("CLOSED", 3), pull("OPEN", 12)]),
    );
    let fake = Arc::new(FakeRunner::default());
    let got = api(&fake, &s.base, "git@github.com:acme/app.git")
        .fetch(&machine(), "/r/app", "fix")
        .await;
    assert!(matches!(got, Fetched::Found(p) if p.number == 12));
}

#[tokio::test]
async fn no_pull_request_is_said_so() {
    let s = stub().await;
    s.answer("/graphql", 200, &answer(vec![]));
    let fake = Arc::new(FakeRunner::default());
    let api = api(&fake, &s.base, "git@github.com:acme/app.git");
    assert_eq!(
        api.fetch(&machine(), "/r/app", "fix").await,
        Fetched::NoPull
    );
    assert_eq!(api.problem(), None);
}

#[tokio::test]
async fn a_refused_token_is_named_and_kept_as_the_problem() {
    let s = stub().await;
    s.answer("/graphql", 401, r#"{"message":"Bad credentials"}"#);
    let fake = Arc::new(FakeRunner::default());
    let api = api(&fake, &s.base, "git@github.com:acme/app.git");
    let got = api.fetch(&machine(), "/r/app", "fix").await;
    assert!(
        matches!(&got, Fetched::Failed(e) if e.contains("refused") && !e.contains("shh-gh-token")),
        "{got:?}"
    );
    assert!(api.problem().unwrap().contains("refused"));
}

#[tokio::test]
async fn a_missing_secret_says_so_and_asks_nothing() {
    let fake = Arc::new(FakeRunner::default());
    let api = GitHubApi::new(remotes(&fake, "git@github.com:acme/app.git"))
        .with_base("http://127.0.0.1:1");
    api.set_token(Err("the secret github_pr is not set".into()));
    let got = api.fetch(&machine(), "/r/app", "fix").await;
    assert!(
        matches!(&got, Fetched::Failed(e) if e.contains("github_pr")),
        "{got:?}"
    );
}

#[tokio::test]
async fn another_host_is_not_asked_with_the_token() {
    let s = stub().await;
    s.answer("/graphql", 200, &answer(vec![pull("OPEN", 12)]));
    let fake = Arc::new(FakeRunner::default());
    let got = api(&fake, &s.base, "git@git.example.com:acme/app.git")
        .fetch(&machine(), "/r/app", "fix")
        .await;
    assert!(
        matches!(&got, Fetched::Failed(e) if e.contains("git.example.com")),
        "{got:?}"
    );
}

#[tokio::test]
async fn a_failed_job_log_is_read_with_the_token() {
    let s = stub().await;
    s.answer(
        "/repos/acme/app/actions/jobs/2/logs",
        200,
        "2026-10-28T10:01:05.1Z test login FAILED\n",
    );
    let fake = Arc::new(FakeRunner::default());
    let check = super::Check {
        name: "test".into(),
        url: "https://github.com/acme/app/actions/runs/1/job/2".into(),
        log: String::new(),
    };
    let log = api(&fake, &s.base, "git@github.com:acme/app.git")
        .failure_log(&machine(), "/r/app", &check)
        .await;
    assert!(log.contains("test login FAILED"), "{log}");
}

#[tokio::test]
async fn the_setting_picks_which_way_github_is_asked() {
    let s = stub().await;
    s.answer("/graphql", 200, &answer(vec![pull("OPEN", 12)]));
    let fake = Arc::new(FakeRunner::default());
    let either = GitHubEither::new(
        Arc::new(super::GitHub::new(
            fake.clone(),
            Ssh::new(std::path::PathBuf::from("/tmp/ssh")),
        )),
        Arc::new(GitHubApi::new(remotes(&fake, "git@github.com:acme/app.git")).with_base(&s.base)),
    );
    fake.stub(
        "gh pr view",
        Output::ok_with(include_str!("../../tests/fixtures/gh_pr_view.json")),
    );
    let mut cfg = PullRequests::default();
    either.configure(&cfg, &Err("no secrets".into()));
    assert!(matches!(
        either.fetch(&machine(), "/r/app", "fix").await,
        Fetched::Found(_)
    ));
    assert!(fake.calls().concat().join(" ").contains("gh pr view"));
    cfg.github_via = GithubVia::Token;
    cfg.github_token = "${secret:github_pr}".into();
    either.configure(&cfg, &Err("no secrets".into()));
    let got = either.fetch(&machine(), "/r/app", "fix").await;
    assert!(matches!(&got, Fetched::Failed(_)), "{got:?}");
}
