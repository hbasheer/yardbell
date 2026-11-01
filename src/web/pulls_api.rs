use super::{asset, card_of, conversation_id, decide, refused, ApiError, AppState, Decision};
use crate::config::Approval;
use crate::dispatch::{decide_step, By, Rule};
use axum::extract::{Path as UrlPath, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
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
    let card = card_of(&app, id, req.card, "pull")?;
    let field = |k: &str| card[k].as_str().unwrap_or_default().to_string();
    let text = req
        .text
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| field("instruction"));
    let input = json!({ "machine": field("machine"), "name": field("name"), "text": text });
    let cfg = app.config()?;
    crate::mcp::check(&app, &cfg, "send_to_session", &input)?;
    let step = crate::mcp::step_of(&app, "send_to_session", &input);
    let verdict = decide_step(cfg.dispatch.approval, &cfg.dispatch.rules, &step);
    if verdict.approval == Approval::Deny {
        return Err(ApiError(StatusCode::FORBIDDEN, refusal(verdict.rule)));
    }
    app.dispatch.pull_claim(id, req.card).map_err(refused)?;
    let proposed = app
        .dispatch
        .propose(id, "send_to_session", input, By::You, None, verdict.rule);
    let step = match proposed {
        Ok(step) => step,
        Err(e) => {
            let _ = app.dispatch.pull_sent(id, req.card, None);
            return Err(refused(e));
        }
    };
    let step_id = step["id"].as_str().unwrap_or_default().to_string();
    let card = app
        .dispatch
        .pull_sent(id, req.card, Some(&step_id))
        .map_err(refused)?;
    let step = match verdict.approval {
        Approval::Allow => {
            let approve = Decision {
                decision: "approve".into(),
                input: None,
                again: false,
            };
            decide(&app, id, &step_id, &approve).await?
        }
        _ => step,
    };
    Ok(Json(json!({ "card": card, "step": step })).into_response())
}
