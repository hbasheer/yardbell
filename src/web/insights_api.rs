use super::{asset, find_machine, ApiError, AppState};
use crate::insights::work::{self, Work};
use crate::insights::{runs::runs, suggest_message, Ask};
use axum::extract::{Path as UrlPath, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

// How far back the scrollback is read for runs from before Yardbell recorded them.
const SCROLLBACK: u32 = 2000;
const SCREEN_END_LINES: usize = 30;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/insights.js", get(|| async { asset("insights.js") }))
        .route("/sessions/{machine}/{name}/insights", get(insights_route))
}

fn screen_end(text: &str) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let from = lines.len().saturating_sub(SCREEN_END_LINES);
    lines[from..].join("\n")
}

async fn work_of(
    app: &AppState,
    m: &crate::config::Machine,
    name: &str,
    live: Option<&crate::snapshot::Session>,
    screen: String,
) -> Option<Work> {
    let record = app.insights.record(&m.name, name);
    let (agent, cwd) = match (live, &record) {
        (Some(s), _) => (s.agent.clone(), s.cwd.clone()),
        (None, Some(r)) => (r.agent.clone(), r.cwd.clone()),
        (None, None) => return None,
    };
    let read = if agent.contains("claude") && !cwd.is_empty() {
        let lines = app.sessions.work_lines(m, &cwd).await;
        lines.and_then(|text| work::of_transcript(&text, &cwd))
    } else {
        None
    };
    let mut found = read.or_else(|| {
        (!screen.trim().is_empty()).then(|| Work {
            screen,
            ..Work::default()
        })
    })?;
    found.shared = found.screen.is_empty()
        && app
            .state
            .snapshot(&m.name)
            .is_some_and(|snap| snap.sessions.iter().filter(|s| s.cwd == cwd).count() > 1);
    work::scrub(&mut found, &crate::mcp_read::saved_values(app));
    Some(found)
}

async fn insights_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let live = app.state.snapshot(&m.name).and_then(|snap| {
        snap.sessions.into_iter().find(|s| {
            s.tmux.as_deref() == Some(name.as_str())
                || (s.tmux.is_none() && s.pid.to_string() == name)
        })
    });
    let timeline = app
        .insights
        .record(&m.name, &name)
        .map(|r| r.timeline(chrono::Local::now()));
    if live.is_none() && timeline.is_none() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("Yardbell has seen no session {name} on {machine}"),
        ));
    }
    let attachable = live.as_ref().is_some_and(|s| s.attachable());
    let mut screen = String::new();
    let (earlier, scrollback) = if attachable {
        match app.sessions.read(&m, &name, SCROLLBACK).await {
            Ok(text) => {
                screen = screen_end(&text);
                let recorded: HashSet<&str> = timeline
                    .iter()
                    .flat_map(|t| t.runs.iter().map(|r| r.text.as_str()))
                    .collect();
                let mut seen = HashSet::new();
                let earlier: Vec<_> = runs(&text)
                    .into_iter()
                    .filter(|r| !recorded.contains(r.text.as_str()) && seen.insert(r.text.clone()))
                    .collect();
                (earlier, None)
            }
            Err(e) => (Vec::new(), Some(e)),
        }
    } else {
        (Vec::new(), None)
    };
    let work = work_of(&app, &m, &name, live.as_ref(), screen).await;
    let parts = match (&work, &timeline) {
        (Some(w), Some(t)) if w.screen.is_empty() => Some(work::parts(&t.periods, &w.moments)),
        _ => None,
    };
    let pull = live
        .as_ref()
        .map(|s| (s.folder.clone(), s.branch.clone()))
        .or_else(|| {
            timeline
                .as_ref()
                .map(|t| (t.folder.clone(), t.branch.clone()))
        })
        .and_then(|(folder, branch)| app.state.pull_of(&m.name, &folder, &branch));
    let origin = app.dispatch.origin(&m.name, &name);
    let task = origin
        .as_ref()
        .map(|o| o.prompt.clone())
        .filter(|p| !p.trim().is_empty())
        .or_else(|| app.task_of(&m.name, &name))
        .unwrap_or_default();
    let saved = app.dispatch.tasks();
    let from = origin
        .as_ref()
        .and_then(|o| o.task.clone())
        .and_then(|(task, version)| {
            let now = saved.iter().find(|t| t.name == task && !t.hidden)?;
            Some((task, version.unwrap_or(now.version), now.version))
        });
    let suggest = suggest_message(&Ask {
        machine: &m.name,
        name: &name,
        live: attachable,
        task: &task,
        from: from.as_ref().map(|(t, v, _)| (t.as_str(), *v)),
        timeline: timeline.as_ref(),
    });
    let mut out: Value = json!({
        "machine": m.name,
        "name": name,
        "live": live.is_some(),
        "attachable": attachable,
        "activity": live.as_ref().map(|s| s.activity),
        "work": work,
        "parts": parts,
        "timeline": timeline,
        "earlier": earlier,
        "scrollback_error": scrollback,
        "task": task,
        "conversation": origin.map(|o| o.conversation),
        "pull": pull,
        "suggest": suggest,
    });
    if let Some((task, version, current)) = from {
        out["from"] = json!({ "name": task, "version": version, "current": current });
    }
    Ok(Json(out).into_response())
}
