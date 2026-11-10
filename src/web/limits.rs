use super::pulls_api::{send_card, sends_unasked};
use super::AppState;
use crate::dispatch::By;
use crate::snapshot::Activity;
use crate::state::SessionView;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const ROUND: Duration = Duration::from_secs(30);
pub const RESUME: &str = "continue";

// A reset long past is old news: whoever left that session stopped has moved on.
const STALE_AFTER_HOURS: i64 = 6;

pub fn due(s: &SessionView, now: DateTime<Utc>) -> Option<Value> {
    let name = s.tmux.as_deref().filter(|t| !t.is_empty())?;
    if s.stale || s.activity != Activity::Idle {
        return None;
    }
    let error = s.stopped.as_deref()?;
    let resets = s.resets.as_deref()?;
    let at = DateTime::parse_from_rfc3339(resets)
        .ok()?
        .with_timezone(&Utc);
    if at > now || now - at > chrono::Duration::hours(STALE_AFTER_HOURS) {
        return None;
    }
    Some(json!({
        "role": "pull",
        "kind": "limit",
        "key": format!("limit:{}:{name}:{resets}", s.machine),
        "machine": s.machine,
        "name": name,
        "path": s.path,
        "branch": s.branch,
        "folder": s.folder,
        "error": error,
        "resets": resets,
        "instruction": RESUME,
        "at": chrono::Local::now().to_rfc3339(),
    }))
}

pub async fn round(app: &Arc<AppState>, now: DateTime<Utc>) {
    let Ok(cfg) = app.config() else {
        return;
    };
    let view = app.state.view(&cfg, app.ports.as_ref(), "localhost");
    for s in &view.sessions {
        let Some(card) = due(s, now) else {
            continue;
        };
        let name = card["name"].as_str().unwrap_or_default().to_string();
        if app.dispatch.limit_waiting(&s.machine, &name) {
            continue;
        }
        let title = format!("Usage limit: {}", s.folder);
        let Some((id, index)) = app
            .dispatch
            .post_pull(&s.machine, &name, &s.path, &title, card)
        else {
            continue;
        };
        app.state.touch();
        if !sends_unasked(app, &id, index) {
            continue;
        }
        if let Err(e) = send_card(app, &id, index, None, By::Dispatch).await {
            tracing::warn!(error = %e.1, machine = %s.machine, session = %name, "the usage limit card was not sent");
        }
        app.state.touch();
    }
}

pub fn start_loop(app: Arc<AppState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(ROUND);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            round(&app, Utc::now()).await;
        }
    })
}
