use super::*;
use crate::testing::FakeRunner;
use chrono::Duration;
use futures::future::BoxFuture;
use std::path::Path;

const QUICK: &str = r#"echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Nothing needs you."}]}}'
echo '{"type":"result","is_error":false,"result":"Nothing needs you."}'"#;

fn dispatch(dir: &Path, script: &str) -> Dispatch {
    static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let path = dir.join(format!("claude-{n}"));
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    Dispatch::new(Arc::new(FakeRunner::default()), dir.join("dispatch"))
        .with_command(vec![path.display().to_string()])
}

fn config(triggers: &str) -> Config {
    let cfg: Config = serde_yaml::from_str(&format!(
        "machines:\n  - name: hp\n    local: true\n    root: /r\ntriggers:\n{triggers}"
    ))
    .unwrap();
    cfg.validate().unwrap();
    cfg
}

fn launch<'a>(cfg: &'a Config, dispatch: &'a Dispatch) -> Launch<'a> {
    Launch {
        dispatch,
        port: 4000,
        settings: &cfg.dispatch,
        extra: Ok(None),
        linear_key: Ok("lin_api_test".into()),
    }
}

async fn settled(dispatch: &Dispatch) {
    for _ in 0..200 {
        if !dispatch
            .list()
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["busy"] == true)
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("a conversation is still busy");
}

fn conversations(dispatch: &Dispatch) -> Vec<Value> {
    let mut all: Vec<Value> = dispatch
        .list()
        .as_array()
        .unwrap()
        .iter()
        .map(|c| dispatch.get(c["id"].as_str().unwrap()).unwrap())
        .collect();
    all.sort_by(|a, b| a["updated"].as_str().cmp(&b["updated"].as_str()));
    all
}

fn last(triggers: &Triggers, name: &str) -> Kept {
    triggers.lock().get(name).cloned().unwrap_or_default()
}

#[derive(Default)]
struct FakeFeeds {
    linear: Mutex<Vec<Ticket>>,
    linear_down: Mutex<Option<String>>,
    github: Mutex<HashMap<GhList, Result<Vec<Ticket>, String>>>,
    asked: Mutex<Vec<String>>,
}

impl Feeds for FakeFeeds {
    fn linear<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<Ticket>, String>> {
        self.asked.lock().unwrap().push(format!("linear {key}"));
        let out = match self.linear_down.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(self.linear.lock().unwrap().clone()),
        };
        Box::pin(async move { out })
    }

    fn github(&self, list: GhList) -> BoxFuture<'_, Result<Vec<Ticket>, String>> {
        self.asked.lock().unwrap().push(format!("github {list:?}"));
        let out = self
            .github
            .lock()
            .unwrap()
            .get(&list)
            .cloned()
            .unwrap_or(Ok(Vec::new()));
        Box::pin(async move { out })
    }
}

impl FakeFeeds {
    fn asked(&self) -> usize {
        self.asked.lock().unwrap().len()
    }
}

fn linear(id: &str, ticket: &str, title: &str, state: &str) -> Ticket {
    Ticket {
        id: id.into(),
        ticket: ticket.into(),
        title: title.into(),
        url: format!("https://linear.app/acme/issue/{ticket}"),
        state: state.into(),
        repo: String::new(),
    }
}

fn at(text: &str) -> DateTime<Local> {
    let naive = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap();
    naive.and_local_timezone(Local).earliest().unwrap()
}

const HOURLY: &str =
    "  - name: Hourly status\n    task: What's going on?\n    schedule: every 1h\n";

#[tokio::test]
async fn missed_slots_run_once_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("triggers.json");
    let d = dispatch(dir.path(), QUICK);
    let cfg = config(HOURLY);
    let first = Triggers::new(Arc::new(FakeFeeds::default()), file.clone());
    assert_eq!(
        first
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 09:10"))
            .await,
        0
    );
    assert_eq!(
        first
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 09:59"))
            .await,
        0
    );
    drop(first);

    let again = Triggers::new(Arc::new(FakeFeeds::default()), file.clone());
    assert_eq!(
        again
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 14:20"))
            .await,
        1,
        "five missed slots, one run"
    );
    settled(&d).await;
    assert_eq!(
        again
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 14:59"))
            .await,
        0
    );
    let kept = last(&again, "Hourly status");
    let run = kept.last.unwrap();
    assert_eq!(run.outcome, "started");
    assert_eq!(
        run.text,
        "Started late for Mon 14:00, Yardbell was not running then"
    );
    let all = conversations(&d);
    assert_eq!(all.len(), 1);
    let convo = &all[0];
    assert_eq!(convo["title"], "What's going on?");
    assert_eq!(convo["trigger"]["name"], "Hourly status");
    assert_eq!(convo["trigger"]["kind"], "schedule");
    assert_eq!(convo["trigger"]["what"], "Every hour");
    assert_eq!(
        convo["trigger"]["slot"],
        at("2026-06-01 14:00").to_rfc3339(),
        "the latest missed slot"
    );
    assert_eq!(
        convo["events"][0]["text"],
        "What's going on? Summarise every machine and session."
    );
    assert_eq!(d.list()[0]["trigger"], "Hourly status");

    assert_eq!(
        again
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 15:00"))
            .await,
        1
    );
    settled(&d).await;
    assert_eq!(
        last(&again, "Hourly status").last.unwrap().text,
        "Started a conversation"
    );
}

#[tokio::test]
async fn a_run_still_working_is_not_stacked() {
    let dir = tempfile::tempdir().unwrap();
    let d = dispatch(dir.path(), "sleep 30");
    let cfg = config(HOURLY);
    let triggers = Triggers::new(Arc::new(FakeFeeds::default()), dir.path().join("t.json"));
    triggers
        .round(&cfg, &launch(&cfg, &d), at("2026-06-01 09:30"))
        .await;
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 10:00"))
            .await,
        1
    );
    assert!(d.triggered_busy("Hourly status"));
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 11:00"))
            .await,
        0
    );
    let kept = last(&triggers, "Hourly status").last.unwrap();
    assert_eq!(kept.outcome, "skipped");
    assert_eq!(
        kept.text,
        "Skipped the run at 11:00, the last one was still working"
    );
    assert_eq!(
        triggers
            .run_now(
                &cfg,
                "Hourly status",
                &launch(&cfg, &d),
                at("2026-06-01 11:05")
            )
            .await
            .unwrap_err(),
        "its last run is still working. Wait for it, or stop it in Dispatch"
    );
    assert_eq!(d.list().as_array().unwrap().len(), 1);
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 11:30"))
            .await,
        0,
        "the skipped slot is not run later"
    );
    let id = d.list()[0]["id"].as_str().unwrap().to_string();
    d.stop(&id);
    settled(&d).await;
    let out = triggers
        .run_now(
            &cfg,
            "Hourly status",
            &launch(&cfg, &d),
            at("2026-06-01 11:40"),
        )
        .await
        .unwrap();
    assert!(out["conversation"].as_str().is_some_and(|c| c != id));
    d.stop(out["conversation"].as_str().unwrap());
    settled(&d).await;
}

#[tokio::test]
async fn a_trigger_turned_off_and_on_again_counts_from_then() {
    let dir = tempfile::tempdir().unwrap();
    let d = dispatch(dir.path(), QUICK);
    let mut cfg = config(HOURLY);
    let triggers = Triggers::new(Arc::new(FakeFeeds::default()), dir.path().join("t.json"));
    triggers
        .round(&cfg, &launch(&cfg, &d), at("2026-06-01 09:30"))
        .await;
    cfg.triggers[0].enabled = false;
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 12:30"))
            .await,
        0
    );
    cfg.triggers[0].enabled = true;
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 12:40"))
            .await,
        0
    );
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 13:00"))
            .await,
        1
    );
    settled(&d).await;
    cfg.triggers[0].schedule = "daily 18:00".into();
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 17:00"))
            .await,
        0,
        "a new schedule counts from when it is seen"
    );
    let view = triggers.view(&cfg, &launch(&cfg, &d), at("2026-06-01 17:00"));
    assert_eq!(view[0]["next"], at("2026-06-01 18:00").to_rfc3339());
    assert_eq!(view[0]["describe"], "Daily at 18:00");
    assert_eq!(
        view[0]["last"]["outcome"], "started",
        "the last run is kept"
    );
}

#[tokio::test]
async fn a_missing_task_is_reported_and_nothing_starts() {
    let dir = tempfile::tempdir().unwrap();
    let d = dispatch(dir.path(), QUICK);
    let cfg = config("  - name: Gone\n    task: Not a task\n    schedule: every 1h\n");
    let triggers = Triggers::new(Arc::new(FakeFeeds::default()), dir.path().join("t.json"));
    triggers
        .round(&cfg, &launch(&cfg, &d), at("2026-06-01 09:30"))
        .await;
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), at("2026-06-01 10:00"))
            .await,
        0
    );
    let run = last(&triggers, "Gone").last.unwrap();
    assert_eq!(run.outcome, "failed");
    assert!(
        run.text.contains("the task Not a task no longer exists"),
        "{}",
        run.text
    );
    assert!(d.list().as_array().unwrap().is_empty());
}

const LINEAR: &str = "  - name: My tickets\n    task: Start a ticket\n    linear:\n      assigned: true\n      states: [In Progress]\n";

#[tokio::test]
async fn linear_tickets_start_once_each_even_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("triggers.json");
    let d = dispatch(dir.path(), QUICK);
    d.save_task(
        "Start a ticket",
        "Start a session for {ticket} ({title}), it is {state}. {url}",
        None,
    )
    .unwrap();
    let cfg = config(LINEAR);
    let feeds = Arc::new(FakeFeeds::default());
    *feeds.linear.lock().unwrap() = vec![linear("i-1", "ENG-1", "Old one", "Todo")];
    let triggers = Triggers::new(feeds.clone(), file.clone());
    let t0 = at("2026-06-01 09:00");
    assert_eq!(
        triggers.round(&cfg, &launch(&cfg, &d), t0).await,
        0,
        "what is already assigned is not started"
    );
    assert_eq!(feeds.asked(), 1);
    assert_eq!(feeds.asked.lock().unwrap()[0], "linear lin_api_test");
    triggers
        .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(1))
        .await;
    assert_eq!(
        feeds.asked(),
        1,
        "Linear is asked every few minutes, not every round"
    );

    *feeds.linear.lock().unwrap() = vec![
        linear("i-2", "ENG-2", "Fix login", "Todo"),
        linear("i-1", "ENG-1", "Old one", "In Progress"),
    ];
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(3))
            .await,
        1
    );
    settled(&d).await;
    let kept = last(&triggers, "My tickets");
    assert_eq!(
        kept.last.unwrap().text,
        "Started for ENG-1 moved to In Progress"
    );
    assert_eq!(kept.note, "1 more ticket is waiting for the next check");
    let first = conversations(&d).pop().unwrap();
    assert_eq!(first["title"], "Start a ticket: ENG-1 Old one");
    assert_eq!(
        first["events"][0]["text"],
        "Start a session for ENG-1 (Old one), it is In Progress. https://linear.app/acme/issue/ENG-1"
    );
    assert_eq!(first["trigger"]["kind"], "linear");
    assert_eq!(first["trigger"]["what"], "ENG-1 moved to In Progress");
    assert_eq!(
        first["trigger"]["url"],
        "https://linear.app/acme/issue/ENG-1"
    );
    drop(triggers);

    let again = Triggers::new(feeds.clone(), file.clone());
    assert_eq!(
        again
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(4))
            .await,
        1
    );
    settled(&d).await;
    assert_eq!(
        last(&again, "My tickets").last.unwrap().text,
        "Started for ENG-2 was assigned to you"
    );
    for minutes in [8, 12] {
        assert_eq!(
            again
                .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(minutes))
                .await,
            0,
            "each ticket and event once"
        );
    }
    assert_eq!(conversations(&d).len(), 2);
    let again = Triggers::new(feeds.clone(), file);
    assert_eq!(
        again
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(20))
            .await,
        0
    );
    assert_eq!(
        conversations(&d).len(),
        2,
        "still once after another restart"
    );
}

#[tokio::test]
async fn new_tickets_wait_while_the_last_run_works() {
    let dir = tempfile::tempdir().unwrap();
    let d = dispatch(dir.path(), "sleep 30");
    d.save_task("Start a ticket", "Start it", None).unwrap();
    let cfg = config(LINEAR);
    let feeds = Arc::new(FakeFeeds::default());
    let triggers = Triggers::new(feeds.clone(), dir.path().join("t.json"));
    let t0 = at("2026-06-01 09:00");
    triggers.round(&cfg, &launch(&cfg, &d), t0).await;
    *feeds.linear.lock().unwrap() = vec![
        linear("i-1", "ENG-1", "One", "Todo"),
        linear("i-2", "ENG-2", "Two", "Todo"),
    ];
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(3))
            .await,
        1
    );
    let convo = conversations(&d).pop().unwrap();
    assert!(convo["events"][0]["text"]
        .as_str()
        .unwrap()
        .ends_with("Ticket: ENG-2 Two\nhttps://linear.app/acme/issue/ENG-2"));
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(6))
            .await,
        0
    );
    assert_eq!(
        last(&triggers, "My tickets").note,
        "1 ticket is waiting for the last run to finish"
    );
    d.stop(convo["id"].as_str().unwrap());
    settled(&d).await;
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(9))
            .await,
        1
    );
    let id = conversations(&d).pop().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    d.stop(&id);
    settled(&d).await;
    assert_eq!(conversations(&d).len(), 2);
}

#[tokio::test]
async fn a_missing_key_or_a_failing_feed_shows_on_the_trigger_and_is_retried_later() {
    let dir = tempfile::tempdir().unwrap();
    let d = dispatch(dir.path(), QUICK);
    let cfg = config(LINEAR);
    let feeds = Arc::new(FakeFeeds::default());
    let triggers = Triggers::new(feeds.clone(), dir.path().join("t.json"));
    let t0 = at("2026-06-01 09:00");
    let mut no_key = launch(&cfg, &d);
    no_key.linear_key = Err("the secret linear is not set".into());
    triggers.round(&cfg, &no_key, t0).await;
    assert_eq!(feeds.asked(), 0);
    assert_eq!(
        last(&triggers, "My tickets").problem,
        "the secret linear is not set"
    );
    assert_eq!(
        triggers.view(&cfg, &no_key, t0)[0]["problem"],
        "the secret linear is not set"
    );
    triggers
        .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(5))
        .await;
    assert_eq!(feeds.asked(), 0, "a failed check waits ten minutes");
    *feeds.linear_down.lock().unwrap() = Some("Linear did not answer".into());
    let out = triggers
        .run_now(
            &cfg,
            "My tickets",
            &launch(&cfg, &d),
            t0 + Duration::minutes(6),
        )
        .await;
    assert_eq!(
        out.unwrap_err(),
        "Linear did not answer",
        "Check now asks at once"
    );
    *feeds.linear_down.lock().unwrap() = None;
    *feeds.linear.lock().unwrap() = vec![linear("i-1", "ENG-1", "One", "Todo")];
    let out = triggers
        .run_now(
            &cfg,
            "My tickets",
            &launch(&cfg, &d),
            t0 + Duration::minutes(7),
        )
        .await
        .unwrap();
    assert_eq!(
        out,
        json!({ "conversation": null, "text": "Checked, nothing new" })
    );
    let kept = last(&triggers, "My tickets");
    assert!(kept.problem.is_empty());
    assert!(
        kept.seen.contains_key("assigned:i-1"),
        "the first check only looks"
    );
    assert_eq!(
        kept.last.unwrap().text,
        "Started watching. 1 already matched and was left alone"
    );
}

#[tokio::test]
async fn github_issues_and_review_requests_start_their_task() {
    let dir = tempfile::tempdir().unwrap();
    let d = dispatch(dir.path(), QUICK);
    d.save_task("Review it", "Review {ticket} in {repo}: {title}", None)
        .unwrap();
    let cfg = config(
        "  - name: Reviews\n    task: Review it\n    github:\n      review_requested: true\n",
    );
    let feeds = Arc::new(FakeFeeds::default());
    let triggers = Triggers::new(feeds.clone(), dir.path().join("t.json"));
    let t0 = at("2026-06-01 09:00");
    triggers.round(&cfg, &launch(&cfg, &d), t0).await;
    assert_eq!(*feeds.asked.lock().unwrap(), ["github ReviewRequested"]);
    let pr = Ticket {
        id: "https://github.com/acme/api/pull/9".into(),
        ticket: "acme/api#9".into(),
        title: "Add login".into(),
        url: "https://github.com/acme/api/pull/9".into(),
        state: "open".into(),
        repo: "acme/api".into(),
    };
    feeds
        .github
        .lock()
        .unwrap()
        .insert(GhList::ReviewRequested, Ok(vec![pr]));
    assert_eq!(
        triggers
            .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(3))
            .await,
        1
    );
    settled(&d).await;
    let convo = conversations(&d).pop().unwrap();
    assert_eq!(
        convo["events"][0]["text"],
        "Review acme/api#9 in acme/api: Add login"
    );
    assert_eq!(convo["trigger"]["what"], "acme/api#9 asks for your review");
    feeds.github.lock().unwrap().insert(
        GhList::ReviewRequested,
        Err("gh is not logged in on this machine. Run gh auth login there".into()),
    );
    triggers
        .round(&cfg, &launch(&cfg, &d), t0 + Duration::minutes(6))
        .await;
    assert!(last(&triggers, "Reviews").problem.contains("gh auth login"));
    assert_eq!(
        last(&triggers, "Reviews").last.unwrap().outcome,
        "started",
        "a failed check keeps the last run"
    );
}

#[test]
fn a_ticket_fills_the_task_or_is_added_after_it() {
    let t = linear("i-1", "ENG-7", "Fix it", "Todo");
    assert_eq!(
        fill("Look at {ticket}: {title} ({state}) {url}", Some(&t)),
        "Look at ENG-7: Fix it (Todo) https://linear.app/acme/issue/ENG-7"
    );
    assert_eq!(
        fill("Plan my day", Some(&t)),
        "Plan my day\n\nTicket: ENG-7 Fix it\nhttps://linear.app/acme/issue/ENG-7"
    );
    assert_eq!(fill("Plan {ticket}", None), "Plan {ticket}");
}

#[test]
fn triggers_are_validated() {
    let ok = |yaml: &str| {
        let cfg: Config = serde_yaml::from_str(&format!(
            "machines:\n  - name: hp\n    local: true\n    root: /r\ntriggers:\n{yaml}"
        ))
        .unwrap();
        cfg.validate().map_err(|e| e.to_string())
    };
    assert!(ok(HOURLY).is_ok());
    assert!(ok(LINEAR).is_ok());
    for (yaml, said) in [
        (
            "  - name: ''\n    task: x\n    schedule: every 1h\n",
            "every trigger needs a name",
        ),
        (
            "  - name: ' x'\n    task: x\n    schedule: every 1h\n",
            "without spaces at either end",
        ),
        (
            &format!("{HOURLY}{HOURLY}"),
            "\"Hourly status\" is listed twice",
        ),
        (
            "  - name: x\n    task: ''\n    schedule: every 1h\n",
            "needs the task it runs",
        ),
        (
            "  - name: x\n    task: t\n",
            "exactly one of schedule, linear or github",
        ),
        (
            "  - name: x\n    task: t\n    schedule: every 1h\n    github: {assigned: true}\n",
            "exactly one of",
        ),
        (
            "  - name: x\n    task: t\n    schedule: at nine\n",
            "trigger \"x\": schedule \"at nine\" is not a schedule",
        ),
        (
            "  - name: x\n    task: t\n    linear: {}\n",
            "needs linear.assigned: true or a list",
        ),
        (
            "  - name: x\n    task: t\n    linear: {states: ['']}\n",
            "empty linear state",
        ),
        (
            "  - name: x\n    task: t\n    github: {}\n",
            "github.assigned or github.review_requested",
        ),
    ] {
        let err = ok(yaml).unwrap_err();
        assert!(err.starts_with("invalid config: "), "{err}");
        assert!(err.contains(said), "{yaml}: {err}");
    }
}

#[test]
fn triggers_save_without_defaults_and_load_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("yardbell.yml");
    let mut cfg = config(&format!("{HOURLY}{LINEAR}"));
    cfg.triggers[1].enabled = false;
    cfg.save(&path).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("triggers:\n- name: Hourly status\n  task: What's going on?\n  schedule: every 1h\n- name: My tickets\n  task: Start a ticket\n  enabled: false\n  linear:\n    assigned: true\n    states:\n    - In Progress\n"),
        "{text}"
    );
    assert_eq!(Config::load(&path).unwrap().triggers, cfg.triggers);
    let none = config("  []\n");
    none.save(&path).unwrap();
    assert!(!std::fs::read_to_string(&path).unwrap().contains("triggers"));
}
