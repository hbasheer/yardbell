use super::{decide, AppState, Decision};
use crate::config::{Approval, Config, ReviewSessions};
use crate::dispatch::{decide_step, By, PullPlace};
use crate::pulls::{Key, Pull, Pulls, Target};
use crate::snapshot::Activity;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_secs(15);
// Reading a folder's commit is an ssh call, so a branch that is not ready yet is asked at most
// this often.
const RECHECK: Duration = Duration::from_secs(60);

pub fn start(app: Arc<AppState>, pulls: Arc<Pulls>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut checked = HashMap::new();
        let mut every = tokio::time::interval(TICK);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            round(&app, &pulls, &mut checked, Instant::now()).await;
        }
    })
}

// A session's pull request is reviewed once per head commit, when that head is new and the
// session is done with it: every agent on the branch is idle and the folder has that commit
// checked out, so the reviewer reads what was pushed.
pub(super) async fn round(
    app: &Arc<AppState>,
    pulls: &Pulls,
    checked: &mut HashMap<Key, Instant>,
    now: Instant,
) {
    let Ok(cfg) = app.config() else {
        return;
    };
    let mode = cfg.pull_requests.review_sessions;
    if !cfg.pull_requests.enabled || mode == ReviewSessions::Off {
        pulls.forget_reviews();
        checked.clear();
        return;
    }
    checked.retain(|_, at| now.duration_since(*at) < RECHECK);
    for t in crate::pulls::targets(&cfg, &app.state) {
        let key = t.key();
        let Some(pull) = pulls.pull(&key) else {
            continue;
        };
        if pull.state != "open" || pull.head.is_empty() || !pulls.review_due(&pull.url, &pull.head)
        {
            continue;
        }
        if app.pipelines.owns_pull(&pull.url, &t.machine, &t.path) {
            pulls.reviewed(&pull.url, &pull.head);
            continue;
        }
        if checked.contains_key(&key) {
            continue;
        }
        let Some(session) = done_with_it(app, &t) else {
            continue;
        };
        checked.insert(key, now);
        let Some(m) = cfg.machine(&t.machine) else {
            continue;
        };
        let pin = crate::dispatch::read_pin(&app.folders, m, &t.path).await;
        if pin.head != pull.head {
            continue;
        }
        if app.dispatch.earlier_review(&m.name, &pin).is_some() {
            pulls.reviewed(&pull.url, &pull.head);
            continue;
        }
        match propose(app, &cfg, mode, &t, &session, &pull).await {
            Ok(()) => pulls.reviewed(&pull.url, &pull.head),
            Err(Unproposed(why)) => {
                tracing::warn!(machine = %t.machine, branch = %t.branch, "no review of {}: {why}", pull.url);
            }
        }
        app.state.touch();
    }
}

// The session to review, when every agent working on the branch in that folder is idle. A
// reviewer in the same folder is not one of them.
fn done_with_it(app: &AppState, t: &Target) -> Option<String> {
    let snap = app.state.snapshot(&t.machine)?;
    let mut workers = snap.sessions.iter().filter(|s| {
        s.branch == t.branch
            && snap.folder_paths.get(&s.folder) == Some(&t.path)
            && !s
                .tmux
                .as_deref()
                .is_some_and(|name| app.dispatch.is_reviewer(&t.machine, name))
    });
    let mut first = None;
    for s in workers.by_ref() {
        if s.activity != Activity::Idle {
            return None;
        }
        if first.is_none() {
            first = s.tmux.clone();
        }
    }
    first
}

struct Unproposed(String);

// Ask waits for the person whatever the rules say, unless one refuses reviews there.
// Automatically starts it, unless a rule refuses it or asks first.
async fn propose(
    app: &Arc<AppState>,
    cfg: &Config,
    mode: ReviewSessions,
    t: &Target,
    session: &str,
    pull: &Pull,
) -> Result<(), Unproposed> {
    let failed = |e: super::ApiError| Unproposed(e.1);
    let (input, of) =
        crate::mcp::review_plan(app, cfg, &t.machine, session, &t.path, "", "").map_err(failed)?;
    let step = crate::mcp::step_of(app, "review_session", &input);
    let default = match mode {
        ReviewSessions::Auto => Approval::Allow,
        _ => Approval::Prompt,
    };
    let verdict = decide_step(default, &cfg.dispatch.rules, &step);
    let approval = match (mode, verdict.approval) {
        (_, Approval::Deny) => {
            tracing::info!(machine = %t.machine, branch = %t.branch, "a Dispatch rule refuses reviews there, so {} is not reviewed", pull.url);
            return Ok(());
        }
        (ReviewSessions::Auto, approval) => approval,
        _ => Approval::Prompt,
    };
    let title = format!(
        "Review of {}",
        crate::pulls::noun_of(&pull.forge, pull.number)
    );
    let id = app.dispatch.conversation_for(&PullPlace {
        machine: &t.machine,
        session,
        path: &t.path,
        title: &title,
        url: &pull.url,
    });
    let event = app
        .dispatch
        .propose(
            &id,
            "start_session",
            input,
            By::Yardbell,
            Some(of),
            verdict.rule,
        )
        .map_err(|e| Unproposed(e.message().to_string()))?;
    if approval == Approval::Allow {
        let approve = Decision {
            decision: "approve".into(),
            input: None,
            again: false,
        };
        let action = event["id"].as_str().unwrap_or_default();
        if let Err(e) = decide(app, &id, action, &approve).await {
            tracing::warn!(machine = %t.machine, "the review of {} did not start: {}", pull.url, e.1);
        }
    }
    Ok(())
}
