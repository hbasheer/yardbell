use super::github::{classify, excerpt, log_command, parse_review_comments, parse_view};
use super::gitlab::stub::{serve, Answers, Stub};
use super::*;
use crate::probe::MachineStatus;
use crate::shell::Output;
use crate::snapshot::{Activity, Session, Snapshot};
use crate::ssh::Ssh;
use crate::testing::FakeRunner;
use serde_json::json;

const VIEW: &str = include_str!("../../tests/fixtures/gh_pr_view.json");
const LOG: &str = "test\tRun cargo test\t2026-10-28T10:01:00.1234567Z ##[group]Run cargo test\n\
test\tRun cargo test\t2026-10-28T10:01:00.1234567Z cargo test --all\n\
test\tRun cargo test\t2026-10-28T10:01:00.1234567Z ##[endgroup]\n\
test\tRun cargo test\t2026-10-28T10:01:05.1234567Z running 3 tests\n\
test\tRun cargo test\t2026-10-28T10:01:05.1234567Z test login::redirects ... FAILED\n\
test\tRun cargo test\t2026-10-28T10:01:05.1234567Z \x1b[31merror\x1b[0m: test failed, to rerun pass `--lib`\n\
test\tRun cargo test\t2026-10-28T10:01:06.1234567Z ##[error]Process completed with exit code 101.\n";

fn view_with(ci: &str, sha: &str, comments: &[(&str, &str)]) -> String {
    let mut v: Value = serde_json::from_str(VIEW).unwrap();
    v["headRefOid"] = json!(sha);
    v["reviews"] = json!([]);
    v["comments"] = json!(comments
        .iter()
        .map(|(id, who)| json!({ "id": id, "author": { "login": who }, "body": format!("{who} says hi"), "url": format!("https://github.com/acme/app/pull/12#{id}"), "viewerDidAuthor": false, "isMinimized": false }))
        .collect::<Vec<_>>());
    let check = |status: &str, conclusion: &str| json!([{ "__typename": "CheckRun", "name": "test", "workflowName": "CI", "status": status, "conclusion": conclusion, "detailsUrl": "https://github.com/acme/app/actions/runs/111/job/222" }]);
    v["statusCheckRollup"] = match ci {
        "pending" => check("IN_PROGRESS", ""),
        "passing" => check("COMPLETED", "SUCCESS"),
        "failing" => check("COMPLETED", "FAILURE"),
        _ => json!([]),
    };
    v.to_string()
}

#[test]
fn a_pull_request_is_read_from_gh() {
    let p = parse_view(VIEW).unwrap();
    assert_eq!(
        (p.number, p.state.as_str(), p.review.as_str(), p.draft),
        (12, "open", "changes_requested", false)
    );
    assert_eq!(p.title, "Fix the login redirect");
    assert_eq!(p.author, "hb");
    assert_eq!(p.ci, Ci::Failing, "one failed, one still running");
    assert_eq!(
        p.failed,
        [Check {
            name: "CI / test".into(),
            url: "https://github.com/acme/app/actions/runs/111/job/222".into(),
            log: String::new(),
        }],
        "a cancelled run is not a failure"
    );
    let notes: Vec<(&str, &str, &str)> = p
        .notes
        .iter()
        .map(|n| (n.id.as_str(), n.kind.as_str(), n.author.as_str()))
        .collect();
    assert_eq!(
        notes,
        [
            ("IC_kwDOAAAA01", "comment", "alice"),
            ("PRR_kwDOBBBB01", "changes_requested", "bob"),
        ],
        "not the author's own, a hidden one or an approval"
    );
    assert_eq!(
        PullView::from(&p).failed,
        ["CI / test"],
        "the badge names what failed"
    );
}

#[test]
fn checks_add_up_to_one_ci_state() {
    let ci = |state: &str| parse_view(&view_with(state, "a", &[])).unwrap().ci;
    assert_eq!(ci("pending"), Ci::Pending);
    assert_eq!(ci("passing"), Ci::Passing);
    assert_eq!(ci("failing"), Ci::Failing);
    assert_eq!(ci("none"), Ci::None);
    let mut nulls: Value = serde_json::from_str(VIEW).unwrap();
    nulls["statusCheckRollup"] = Value::Null;
    nulls["reviewDecision"] = Value::Null;
    nulls["comments"][0]["body"] = Value::Null;
    let p = parse_view(&nulls.to_string()).unwrap();
    assert_eq!((p.ci, p.review.as_str()), (Ci::None, ""));
}

#[test]
fn gh_missing_logged_out_or_without_a_pull_request_is_quiet() {
    assert_eq!(classify(&Output::failed(127, "")), Fetched::NoTool);
    assert_eq!(
        classify(&Output::failed(
            4,
            "To get started with GitHub CLI, please run:  gh auth login"
        )),
        Fetched::NoTool
    );
    assert_eq!(
        classify(&Output::failed(
            1,
            "no pull requests found for branch \"eng-1\""
        )),
        Fetched::NoPull
    );
    assert_eq!(
        classify(&Output::failed(
            1,
            "\nnone of the git remotes configured for this repository point to a known GitHub host\n"
        )),
        Fetched::Failed(
            "none of the git remotes configured for this repository point to a known GitHub host"
                .into()
        )
    );
    assert!(matches!(classify(&Output::timeout()), Fetched::Failed(_)));
    assert!(matches!(
        classify(&Output::ok_with("not json")),
        Fetched::Failed(_)
    ));
}

#[test]
fn the_failed_log_is_read_for_actions_checks_only() {
    assert_eq!(
        log_command("https://github.com/acme/app/actions/runs/111/job/222").unwrap(),
        "gh run view --job 222 --log-failed 2>/dev/null | tail -n 400"
    );
    assert!(log_command("https://github.com/acme/app/actions/runs/111")
        .unwrap()
        .starts_with("gh run view 111 --log-failed"));
    assert_eq!(log_command("https://circleci.com/gh/acme/app/1"), None);
    assert_eq!(
        excerpt(LOG),
        "cargo test --all\nrunning 3 tests\ntest login::redirects ... FAILED\nerror: test failed, to rerun pass `--lib`\nProcess completed with exit code 101."
    );
    assert_eq!(
        telling_line(&excerpt(LOG)),
        "error: test failed, to rerun pass `--lib`",
        "the runner's closing line says nothing"
    );
    let long: String = (0..500).map(|i| format!("line {i}\n")).collect();
    let cut = excerpt(&long);
    assert_eq!(cut.lines().count(), 30);
    assert!(cut.ends_with("line 499"));
    let wide = format!("{}\n", "é".repeat(4000));
    assert!(
        excerpt(&wide).len() <= 3000,
        "capped, on a character boundary"
    );
}

#[test]
fn review_comments_on_lines_are_read() {
    let json = r#"{"data":{"node":{"comments":{"nodes":[
        {"id":"PRRC_1","path":"src/login.rs","line":42,"originalLine":40,"body":"Off by one","url":"https://github.com/acme/app/pull/12#discussion_r1","author":{"login":"bob"}},
        {"id":"PRRC_2","path":"src/old.rs","line":null,"originalLine":7,"body":"Gone","url":"u2","author":null}
    ]}}}}"#;
    let notes = parse_review_comments(json, "bob");
    assert_eq!(
        notes
            .iter()
            .map(|n| (n.place.as_str(), n.author.as_str(), n.kind.as_str()))
            .collect::<Vec<_>>(),
        [
            ("src/login.rs:42", "bob", "inline"),
            ("src/old.rs:7", "bob", "inline")
        ]
    );
    assert!(parse_review_comments("{\"data\":{\"node\":null}}", "bob").is_empty());
}

fn pull(ci: &str, sha: &str, comments: &[(&str, &str)]) -> Pull {
    parse_view(&view_with(ci, sha, comments)).unwrap()
}

fn kinds(changes: &[Change]) -> Vec<&str> {
    changes
        .iter()
        .map(|c| match c {
            Change::Failed(_) => "failed",
            Change::Reviewed(_) => "reviewed",
        })
        .collect()
}

#[test]
fn a_failure_or_a_comment_is_reported_once() {
    let (seen, first) = observe(None, &pull("failing", "a", &[("c1", "alice")]), "d");
    assert!(first.is_empty(), "the first sighting only sets the state");
    let (seen, again) = observe(Some(&seen), &pull("pending", "a", &[("c1", "alice")]), "d");
    assert!(again.is_empty());
    let (seen, rerun) = observe(Some(&seen), &pull("failing", "a", &[("c1", "alice")]), "d");
    assert!(
        rerun.is_empty(),
        "the same commit failing again is the same failure"
    );
    let (seen, pushed) = observe(Some(&seen), &pull("pending", "b", &[("c1", "alice")]), "d");
    assert!(pushed.is_empty());
    let (seen, failed) = observe(Some(&seen), &pull("failing", "b", &[("c1", "alice")]), "d");
    assert_eq!(kinds(&failed), ["failed"]);
    match &failed[0] {
        Change::Failed(checks) => assert_eq!(checks[0].name, "CI / test"),
        other => panic!("{other:?}"),
    }
    let (seen, commented) = observe(
        Some(&seen),
        &pull("failing", "b", &[("c1", "alice"), ("c2", "bob")]),
        "d",
    );
    assert_eq!(kinds(&commented), ["reviewed"]);
    match &commented[0] {
        Change::Reviewed(notes) => assert_eq!(notes.len(), 1),
        other => panic!("{other:?}"),
    }
    let mut merged = pull("failing", "c", &[("c3", "carol")]);
    merged.state = "merged".into();
    let (seen, quiet) = observe(Some(&seen), &merged, "d");
    assert!(
        quiet.is_empty(),
        "nothing is posted for a closed pull request"
    );
    assert!(seen.notes.contains(&"c3".to_string()) && seen.failures.contains(&"c".to_string()));
}

#[test]
fn instructions_are_short_and_say_what_to_do() {
    let p = pull("failing", "a", &[]);
    let mut checks = p.failed.clone();
    checks[0].log = excerpt(LOG);
    assert_eq!(
        ci_instruction(&p, &checks),
        "CI failed on CI / test for pull request #12: error: test failed, to rerun pass `--lib`. Fix it and push."
    );
    let notes = vec![
        Note {
            id: "r".into(),
            kind: "changes_requested".into(),
            author: "bob".into(),
            body: String::new(),
            url: String::new(),
            place: String::new(),
        },
        Note {
            id: "i".into(),
            kind: "inline".into(),
            author: "bob".into(),
            body: "Off\nby one".into(),
            url: String::new(),
            place: "src/a.rs:3".into(),
        },
    ];
    assert_eq!(
        review_instruction(&p, &notes),
        "New review comments on pull request #12. bob requested changes. bob on src/a.rs:3: \"Off by one\" Address them and push."
    );
    let many: Vec<Note> = (0..40)
        .map(|i| Note {
            body: "x".repeat(300),
            id: i.to_string(),
            ..notes[1].clone()
        })
        .collect();
    let text = review_instruction(&p, &many);
    assert!(
        text.len() < 1500 && text.contains("more on the pull request"),
        "{text}"
    );
}

#[test]
fn a_gitlab_merge_request_is_named_as_one() {
    let mut p = pull("failing", "a", &[]);
    p.forge = "gitlab".into();
    let checks = vec![Check {
        name: "test / rspec".into(),
        url: String::new(),
        log: "2 examples, 1 failure".into(),
    }];
    assert_eq!(noun(&p), "merge request !12");
    assert_eq!(
        ci_instruction(&p, &checks),
        "CI failed on test / rspec for merge request !12: 2 examples, 1 failure. Fix it and push."
    );
    let note = Note {
        id: "gitlab:1".into(),
        kind: "comment".into(),
        author: "rev1".into(),
        body: "x".repeat(300),
        url: String::new(),
        place: String::new(),
    };
    let many = vec![note; 40];
    let text = review_instruction(&p, &many[..1]);
    assert!(
        text.starts_with("New review comments on merge request !12. rev1: "),
        "{text}"
    );
    let text = review_instruction(&p, &many);
    assert!(text.contains("more on the merge request."), "{text}");
    assert_eq!(noun(&pull("failing", "a", &[])), "pull request #12");
}

struct NoPorts;

impl crate::state::PortStatus for NoPorts {
    fn local_port(&self, _m: &Machine, _remote: u16) -> Option<u16> {
        None
    }
    fn status(&self, _m: &Machine, _port: &crate::snapshot::Port) -> String {
        String::new()
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    fake: Arc<FakeRunner>,
    cfg: Config,
    state: State,
}

const BRANCH: &str = "gh pr view 'eng-1'";

impl Rig {
    fn new(extra: &str) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let cfg_path = root.join("yardbell.yml");
        std::fs::write(
            &cfg_path,
            format!("machines:\n  - {{name: hp, local: true, root: /r}}\n{extra}"),
        )
        .unwrap();
        let cfg = Config::load(&cfg_path).unwrap();
        let state = State::default();
        let session = |tmux: Option<&str>, pid| Session {
            machine: "hp".into(),
            agent: "claude".into(),
            pid,
            cwd: "/r/app".into(),
            folder: "app".into(),
            branch: "eng-1".into(),
            ticket: "ENG-1".into(),
            tmux: tmux.map(str::to_string),
            activity: Activity::Active,
        };
        let mut snap = Snapshot {
            sessions: vec![session(Some("hp-app"), 1), session(None, 2)],
            ..Snapshot::default()
        };
        snap.folders.insert("app".into(), "eng-1".into());
        snap.folder_paths.insert("app".into(), "/r/app".into());
        state.update(MachineStatus {
            name: "hp".into(),
            up: true,
            reason: None,
            snapshot: Some(snap),
            checked_at: chrono::Local::now(),
        });
        Rig {
            _dir: dir,
            root,
            fake: Arc::new(FakeRunner::default()),
            cfg,
            state,
        }
    }

    fn secrets(&self) -> Result<crate::secrets::Secrets, String> {
        crate::secrets::Secrets::for_config(&self.root.join("yardbell.yml"))
            .map_err(|e| e.to_string())
    }

    fn pulls(&self) -> Pulls {
        let ssh = || Ssh::new(self.root.join("ssh"));
        Pulls::new(
            Arc::new(GitHub::new(self.fake.clone(), ssh())),
            Arc::new(GitLab::new()),
            Remotes::new(self.fake.clone(), ssh()),
            self.root.join("state/pulls.json"),
        )
    }

    fn dispatch(&self) -> Dispatch {
        Dispatch::new(Arc::new(FakeRunner::default()), self.root.join("dispatch"))
    }

    fn gh_calls(&self) -> usize {
        self.fake
            .calls()
            .iter()
            .filter(|argv| argv.join(" ").contains("gh pr view"))
            .count()
    }

    fn badge(&self, index: usize) -> Option<PullView> {
        self.state.view(&self.cfg, &NoPorts, "h").sessions[index]
            .pull
            .clone()
    }

    fn pull_cards(&self, dispatch: &Dispatch) -> Vec<Value> {
        dispatch
            .list()
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| {
                dispatch.get(c["id"].as_str().unwrap()).unwrap()["events"]
                    .as_array()
                    .unwrap()
                    .clone()
            })
            .filter(|e| e["role"] == "pull")
            .collect()
    }
}

fn later(start: Instant, secs: u64) -> Instant {
    start + Duration::from_secs(secs)
}

#[test]
fn every_branch_with_a_session_is_a_target_once() {
    let rig = Rig::new("");
    assert_eq!(
        targets(&rig.cfg, &rig.state),
        [Target {
            machine: "hp".into(),
            path: "/r/app".into(),
            branch: "eng-1".into(),
            sessions: vec!["hp-app".into()],
        }]
    );
}

#[tokio::test]
async fn without_gh_there_is_no_badge_and_no_card_and_gh_is_not_asked_again_soon() {
    let rig = Rig::new("");
    rig.fake.stub(BRANCH, Output::failed(127, ""));
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    pulls
        .round(&rig.cfg, &rig.secrets(), &rig.state, &dispatch, start)
        .await;
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 300),
        )
        .await;
    assert_eq!(rig.gh_calls(), 1);
    assert!(pulls.views().is_empty());
    assert!(rig.badge(0).is_none());
    assert!(dispatch.list().as_array().unwrap().is_empty());
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 601),
        )
        .await;
    assert_eq!(rig.gh_calls(), 2, "asked again after a while");
}

#[tokio::test]
async fn a_branch_without_a_pull_request_has_no_badge() {
    let rig = Rig::new("");
    rig.fake.stub(
        BRANCH,
        Output::failed(1, "no pull requests found for branch \"eng-1\""),
    );
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            Instant::now(),
        )
        .await;
    assert!(rig.badge(0).is_none());
    assert!(dispatch.list().as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_failing_branch_gets_a_badge_and_one_card_even_across_restarts() {
    let rig = Rig::new("");
    rig.fake
        .stub(BRANCH, Output::ok_with(&view_with("pending", "a", &[])));
    rig.fake.stub("gh run view --job 222", Output::ok_with(LOG));
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    pulls
        .round(&rig.cfg, &rig.secrets(), &rig.state, &dispatch, start)
        .await;
    let badge = rig.badge(0).unwrap();
    assert_eq!((badge.number, badge.ci), (12, Ci::Pending));
    assert!(
        rig.badge(1).is_some(),
        "a session outside tmux on the same branch shows it too"
    );

    rig.fake
        .restub(BRANCH, Output::ok_with(&view_with("failing", "a", &[])));
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 60),
        )
        .await;
    assert_eq!(
        rig.gh_calls(),
        1,
        "not asked again before the poll interval"
    );
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 120),
        )
        .await;
    assert_eq!(rig.gh_calls(), 2);
    let badge = rig.badge(0).unwrap();
    assert_eq!(
        (badge.ci, badge.failed),
        (Ci::Failing, vec!["CI / test".to_string()])
    );

    let cards = rig.pull_cards(&dispatch);
    assert_eq!(cards.len(), 1);
    let card = &cards[0];
    assert_eq!(
        (
            &card["kind"],
            &card["machine"],
            &card["name"],
            &card["branch"]
        ),
        (
            &json!("ci"),
            &json!("hp"),
            &json!("hp-app"),
            &json!("eng-1")
        )
    );
    assert_eq!(card["pull"]["number"], 12);
    assert!(card["checks"][0]["log"]
        .as_str()
        .unwrap()
        .contains("login::redirects ... FAILED"));
    assert_eq!(
        card["instruction"],
        "CI failed on CI / test for pull request #12: error: test failed, to rerun pass `--lib`. Fix it and push."
    );
    assert_eq!(
        dispatch.list()[0]["title"],
        "Pull request #12: Fix the login redirect"
    );

    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 240),
        )
        .await;
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            Instant::now(),
        )
        .await;
    assert_eq!(
        rig.pull_cards(&dispatch).len(),
        1,
        "no second card, also after a restart"
    );
}

#[tokio::test]
async fn a_new_review_gets_a_card_with_its_comments_on_lines() {
    let rig = Rig::new("");
    rig.fake
        .stub(BRANCH, Output::ok_with(&view_with("passing", "a", &[])));
    rig.fake.stub(
        "gh api graphql",
        Output::ok_with(r#"{"data":{"node":{"comments":{"nodes":[{"id":"PRRC_1","path":"src/login.rs","line":42,"body":"Off by one","url":"https://github.com/acme/app/pull/12#discussion_r1","author":{"login":"bob"}}]}}}}"#),
    );
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    pulls
        .round(&rig.cfg, &rig.secrets(), &rig.state, &dispatch, start)
        .await;
    let mut reviewed: Value = serde_json::from_str(&view_with("passing", "a", &[])).unwrap();
    reviewed["reviews"] = json!([{ "id": "PRR_new", "author": { "login": "bob" }, "body": "", "state": "CHANGES_REQUESTED" }]);
    rig.fake
        .restub(BRANCH, Output::ok_with(&reviewed.to_string()));
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 120),
        )
        .await;
    let cards = rig.pull_cards(&dispatch);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["kind"], "review");
    assert_eq!(cards[0]["notes"][0]["place"], "src/login.rs:42");
    assert_eq!(
        cards[0]["instruction"],
        "New review comments on pull request #12. bob on src/login.rs:42: \"Off by one\" Address them and push."
    );
    assert!(rig
        .fake
        .calls()
        .iter()
        .any(|argv| argv.join(" ").contains("PRR_new")));
}

#[tokio::test]
async fn turned_off_there_is_no_badge_and_with_cards_off_no_card() {
    let off = Rig::new("pull_requests:\n  enabled: false\n");
    off.fake
        .stub(BRANCH, Output::ok_with(&view_with("pending", "a", &[])));
    let (pulls, dispatch) = (off.pulls(), off.dispatch());
    pulls
        .round(
            &off.cfg,
            &off.secrets(),
            &off.state,
            &dispatch,
            Instant::now(),
        )
        .await;
    assert_eq!(off.gh_calls(), 0);
    assert!(off.badge(0).is_none());

    let quiet = Rig::new("pull_requests:\n  cards: false\n");
    quiet
        .fake
        .stub(BRANCH, Output::ok_with(&view_with("pending", "a", &[])));
    let (pulls, dispatch) = (quiet.pulls(), quiet.dispatch());
    let start = Instant::now();
    pulls
        .round(&quiet.cfg, &quiet.secrets(), &quiet.state, &dispatch, start)
        .await;
    quiet
        .fake
        .restub(BRANCH, Output::ok_with(&view_with("failing", "a", &[])));
    pulls
        .round(
            &quiet.cfg,
            &quiet.secrets(),
            &quiet.state,
            &dispatch,
            later(start, 120),
        )
        .await;
    assert_eq!(quiet.badge(0).unwrap().ci, Ci::Failing);
    assert!(quiet.pull_cards(&dispatch).is_empty());
}

#[test]
fn an_excerpt_drops_a_byte_order_mark_before_the_first_stamp() {
    let log = "desktop\tRun cargo clippy\t\u{feff}2026-10-28T02:48:00.9386230Z ##[group]Run cargo clippy\n\
               desktop\tRun cargo clippy\t2026-10-28T02:48:14.0412420Z \x1b[1m\x1b[91merror[E0063]\x1b[0m: missing field\n";
    assert_eq!(excerpt(log), "error[E0063]: missing field");
}

// A rig whose app folder is on GitHub and whose web folder is on a GitLab host served by `stub`.
fn gitlab_rig(stub: &Stub) -> Rig {
    let rig = Rig::new(&format!(
        "pull_requests:\n  gitlab:\n    - {{host: git.commslayer.com, url: '{}', token: '${{secret:gitlab}}'}}\n",
        stub.base
    ));
    std::fs::write(rig.root.join("secrets.yml"), "gitlab: glpat-good\n").unwrap();
    let mut snap = rig.state.snapshot("hp").unwrap();
    snap.sessions.push(Session {
        machine: "hp".into(),
        agent: "claude".into(),
        pid: 3,
        cwd: "/r/web".into(),
        folder: "web".into(),
        branch: "eng-2".into(),
        ticket: "ENG-2".into(),
        tmux: Some("hp-web".into()),
        activity: Activity::Active,
    });
    snap.folders.insert("web".into(), "eng-2".into());
    snap.folder_paths.insert("web".into(), "/r/web".into());
    rig.state.update(MachineStatus {
        name: "hp".into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    });
    rig.fake.stub(
        "branch.eng-1.remote",
        Output::ok_with("git@github.com:acme/app.git\n"),
    );
    rig.fake.stub(
        "branch.eng-2.remote",
        Output::ok_with("git@git.commslayer.com:commslayer/web.git\n"),
    );
    rig.fake
        .stub(BRANCH, Output::ok_with(&view_with("passing", "abc", &[])));
    rig
}

impl Rig {
    fn asked(&self, part: &str) -> usize {
        self.fake
            .calls()
            .iter()
            .filter(|argv| argv.join(" ").contains(part))
            .count()
    }

    fn forge_of(&self, folder: &str) -> Option<String> {
        self.state
            .view(&self.cfg, &NoPorts, "h")
            .sessions
            .iter()
            .find(|s| s.folder == folder)
            .and_then(|s| s.pull.clone())
            .map(|p| p.forge)
    }
}

fn new_failure(stub: &Stub, sha: &str) {
    let mut mr: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/gitlab_mr.json")).unwrap();
    mr["sha"] = json!(sha);
    mr["head_pipeline"]["sha"] = json!(sha);
    stub.answers.lock().unwrap().mr = (200, mr.to_string());
}

fn new_note(stub: &Stub) {
    let mut d: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/gitlab_discussions.json")).unwrap();
    d.as_array_mut().unwrap().push(json!({
        "id": "d9",
        "notes": [{"id": 399, "type": null, "body": "One more thing.", "author": {"username": "rev1"}, "system": false}]
    }));
    stub.answers.lock().unwrap().discussions = (200, d.to_string());
}

#[tokio::test]
async fn each_branch_goes_to_its_own_forge() {
    let stub = serve(Answers::default()).await;
    let rig = gitlab_rig(&stub);
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            Instant::now(),
        )
        .await;
    assert_eq!(rig.gh_calls(), 1);
    assert!(!rig
        .fake
        .calls()
        .iter()
        .any(|a| a.join(" ").contains("gh pr view 'eng-2'")));
    assert_eq!(stub.asked("merge_requests?source_branch=eng-2"), 1);
    assert_eq!(stub.asked("source_branch=eng-1"), 0);
    assert_eq!(rig.forge_of("app").as_deref(), Some("github"));
    assert_eq!(rig.forge_of("web").as_deref(), Some("gitlab"));
}

#[tokio::test]
async fn without_gitlab_hosts_no_remote_is_read() {
    let rig = Rig::new("");
    rig.fake
        .stub(BRANCH, Output::ok_with(&view_with("passing", "abc", &[])));
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            Instant::now(),
        )
        .await;
    assert_eq!(rig.gh_calls(), 1);
    assert_eq!(rig.asked("git config --get"), 0);
}

#[tokio::test]
async fn the_remote_is_read_once_per_ten_minutes() {
    let stub = serve(Answers::default()).await;
    let rig = gitlab_rig(&stub);
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    for secs in [0, 130, 260] {
        pulls
            .round(
                &rig.cfg,
                &rig.secrets(),
                &rig.state,
                &dispatch,
                later(start, secs),
            )
            .await;
    }
    assert_eq!(rig.asked("branch.eng-1.remote"), 1);
    assert_eq!(rig.asked("branch.eng-2.remote"), 1);
    assert_eq!(stub.asked("merge_requests?source_branch=eng-2"), 3);
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 601),
        )
        .await;
    assert_eq!(rig.asked("branch.eng-2.remote"), 2);
}

#[tokio::test]
async fn a_refused_token_pauses_that_host_only() {
    let stub = serve(Answers::default()).await;
    let rig = gitlab_rig(&stub);
    std::fs::write(rig.root.join("secrets.yml"), "gitlab: glpat-bad\n").unwrap();
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    pulls
        .round(&rig.cfg, &rig.secrets(), &rig.state, &dispatch, start)
        .await;
    assert_eq!(rig.forge_of("web"), None);
    assert_eq!(rig.forge_of("app").as_deref(), Some("github"));
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 130),
        )
        .await;
    assert_eq!(rig.gh_calls(), 2, "GitHub carries on");
    assert_eq!(
        stub.asked("merge_requests?"),
        1,
        "the host is not asked again soon"
    );
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 601),
        )
        .await;
    assert_eq!(
        stub.asked("merge_requests?"),
        2,
        "asked again after a while"
    );
}

#[tokio::test]
async fn a_removed_secret_pauses_the_host_and_github_carries_on() {
    let stub = serve(Answers::default()).await;
    let rig = gitlab_rig(&stub);
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    pulls
        .round(&rig.cfg, &rig.secrets(), &rig.state, &dispatch, start)
        .await;
    assert_eq!(rig.forge_of("web").as_deref(), Some("gitlab"));
    let asked = stub.log.lock().unwrap().len();
    std::fs::write(rig.root.join("secrets.yml"), "other: x\n").unwrap();
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 130),
        )
        .await;
    assert_eq!(
        stub.log.lock().unwrap().len(),
        asked,
        "no request without a token"
    );
    assert_eq!(rig.forge_of("web"), None);
    assert_eq!(rig.gh_calls(), 2);
}

#[tokio::test]
async fn gitlab_cards_once_across_restarts_and_never_with_the_token() {
    let stub = serve(Answers::default()).await;
    let rig = gitlab_rig(&stub);
    let (pulls, dispatch) = (rig.pulls(), rig.dispatch());
    let start = Instant::now();
    pulls
        .round(&rig.cfg, &rig.secrets(), &rig.state, &dispatch, start)
        .await;
    assert!(
        rig.pull_cards(&dispatch).is_empty(),
        "first sight says nothing"
    );

    new_failure(&stub, "def456");
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 130),
        )
        .await;
    let cards = rig.pull_cards(&dispatch);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["kind"], "ci");
    assert_eq!(cards[0]["pull"]["forge"], "gitlab");
    let titles: Vec<String> = dispatch
        .list()
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["title"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(titles, ["Merge request !12: Fix the login redirect"]);
    assert_eq!(cards[0]["checks"][0]["name"], "test / rspec");
    assert!(
        cards[0]["checks"][0]["log"]
            .as_str()
            .unwrap()
            .contains("2 examples, 1 failure"),
        "{}",
        cards[0]["checks"][0]["log"]
    );

    new_note(&stub);
    pulls
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 260),
        )
        .await;
    let cards = rig.pull_cards(&dispatch);
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[1]["kind"], "review");
    assert_eq!(cards[1]["notes"][0]["id"], "gitlab:399");

    let again = rig.pulls();
    again
        .round(
            &rig.cfg,
            &rig.secrets(),
            &rig.state,
            &dispatch,
            later(start, 400),
        )
        .await;
    assert_eq!(
        rig.pull_cards(&dispatch).len(),
        2,
        "nothing twice after a restart"
    );

    let saved = std::fs::read_to_string(rig.root.join("state/pulls.json")).unwrap();
    let view = serde_json::to_string(&rig.state.view(&rig.cfg, &NoPorts, "h")).unwrap();
    let cards = serde_json::to_string(&rig.pull_cards(&dispatch)).unwrap();
    for text in [saved, view, cards] {
        assert!(!text.contains("glpat"), "{text}");
    }
}
