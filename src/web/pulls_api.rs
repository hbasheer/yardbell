use super::{asset, card_of, conversation_id, decide, refused, ApiError, AppState, Decision};
use crate::config::Approval;
use crate::dispatch::{decide_step, By, Rule};
use axum::extract::{Path as UrlPath, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/pull.js", get(|| async { asset("pull.js") }))
        .route(
            "/dispatch-pull.js",
            get(|| async { asset("dispatch-pull.js") }),
        )
        .route("/dispatch/conversations/{id}/pulls", post(send))
}

#[derive(Deserialize)]
struct SendInput {
    card: usize,
    #[serde(default)]
    text: Option<String>,
}

fn refusal(rule: Option<&Rule>) -> String {
    match rule {
        Some(rule) => format!(
            "Not sent: your Dispatch rule \"{}\" refuses it. You can change it in Settings, under Dispatch.",
            rule.describe()
        ),
        None => "Not sent: your Dispatch settings refuse steps that change something unless a rule \
allows them. You can add one in Settings, under Dispatch."
            .into(),
    }
}

// Send to session on a pull request card is a step the person asks for, so Dispatch's rules decide
// it like any other: it runs, waits below for approval, or is refused.
async fn send(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
    Json(req): Json<SendInput>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let text = req
        .text
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let (card, step) = send_card(&app, id, req.card, text, By::You).await?;
    Ok(Json(json!({ "card": card, "step": step })).into_response())
}

fn send_input(
    app: &AppState,
    id: &str,
    index: usize,
    text: Option<String>,
) -> Result<Value, ApiError> {
    let card = card_of(app, id, index, "pull")?;
    let field = |k: &str| card[k].as_str().unwrap_or_default().to_string();
    let text = text.unwrap_or_else(|| field("instruction"));
    Ok(json!({ "machine": field("machine"), "name": field("name"), "text": text }))
}

// Whether the rules let a card's instruction go to its session without anyone approving it.
pub(super) fn sends_unasked(app: &AppState, id: &str, index: usize) -> bool {
    let (Ok(input), Ok(cfg)) = (send_input(app, id, index, None), app.config()) else {
        return false;
    };
    let step = crate::mcp::step_of(app, "send_to_session", &input);
    crate::mcp::check(app, &cfg, "send_to_session", &input).is_ok()
        && decide_step(cfg.dispatch.approval, &cfg.dispatch.rules, &step).approval
            == Approval::Allow
}

pub(super) async fn send_card(
    app: &Arc<AppState>,
    id: &str,
    index: usize,
    text: Option<String>,
    by: By,
) -> Result<(Value, Value), ApiError> {
    let input = send_input(app, id, index, text)?;
    let cfg = app.config()?;
    crate::mcp::check(app, &cfg, "send_to_session", &input)?;
    let step = crate::mcp::step_of(app, "send_to_session", &input);
    let verdict = decide_step(cfg.dispatch.approval, &cfg.dispatch.rules, &step);
    if verdict.approval == Approval::Deny {
        return Err(ApiError(StatusCode::FORBIDDEN, refusal(verdict.rule)));
    }
    app.dispatch.pull_claim(id, index).map_err(refused)?;
    let proposed = app
        .dispatch
        .propose(id, "send_to_session", input, by, None, verdict.rule);
    let step = match proposed {
        Ok(step) => step,
        Err(e) => {
            let _ = app.dispatch.pull_sent(id, index, None);
            return Err(refused(e));
        }
    };
    let step_id = step["id"].as_str().unwrap_or_default().to_string();
    let card = app
        .dispatch
        .pull_sent(id, index, Some(&step_id))
        .map_err(refused)?;
    let step = match verdict.approval {
        Approval::Allow => {
            let approve = Decision {
                decision: "approve".into(),
                input: None,
                again: false,
            };
            decide(app, id, &step_id, &approve).await?
        }
        _ => step,
    };
    Ok((card, step))
}
