use super::{ApiError, AppState};
use crate::config::McpServer;
use crate::mcp_client::oauth::{Auth, SignIn};
use crate::mcp_client::{client_for, Failure};
use axum::extract::{Path, Query, State as AxState};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

const TEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/oauth/mcp/callback", get(callback))
        .route("/api/settings/mcp/servers/{name}/sign-in", post(sign_in))
        .route("/api/settings/mcp/servers/{name}/finish", post(finish))
        .route("/api/settings/mcp/servers/{name}/sign-out", post(sign_out))
        .route("/api/settings/mcp/servers/{name}/test", post(test))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn url_server(app: &AppState, name: &str) -> Result<McpServer, ApiError> {
    let server = app
        .config()?
        .mcp_servers
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no server named {name}")))?;
    if server.url.is_empty() {
        return Err(bad(format!(
            "{name} runs as a command, so it takes its credentials from its environment"
        )));
    }
    Ok(server)
}

pub(super) fn own_server_error(name: &str) -> String {
    format!("{name} is Yardbell itself, which a pipeline must not call")
}

#[derive(Deserialize, Default)]
struct SignInReq {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
}

async fn sign_in(
    AxState(app): AxState<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<SignInReq>,
) -> Result<Response, ApiError> {
    let server = url_server(&app, &name)?;
    let redirect = format!("http://127.0.0.1:{}/oauth/mcp/callback", app.config()?.port);
    let id = req.client_id.trim();
    let secret = req.client_secret.trim();
    let given = (!id.is_empty()).then(|| {
        (
            id.to_string(),
            (!secret.is_empty()).then(|| secret.to_string()),
        )
    });
    let auth = app.pipelines.mcp_auth();
    let reply = match auth.start(&server, &redirect, given, &app.settings).await {
        Ok(started) => json!({
            "url": started.url,
            "sign_in_host": started.sign_in_host,
            "redirect": redirect,
            "needs_client": false,
        }),
        Err(SignIn::NeedsClient {
            redirect,
            sign_in_host,
        }) => json!({
            "sign_in_host": sign_in_host,
            "redirect": redirect,
            "needs_client": true,
        }),
        Err(SignIn::Failed(e)) => return Err(bad(e)),
    };
    Ok(Json(reply).into_response())
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn page(status: StatusCode, heading: &str, detail: &str) -> Response {
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Yardbell</title><link rel=\"stylesheet\" href=\"/style.css\"></head><body class=\"login\"><main class=\"panel\"><h1>{}</h1><p>{}</p><p><a href=\"/settings#connections\">Back to Settings</a></p></main></body></html>",
        escape(heading),
        escape(detail),
    );
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'self'",
            ),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
        .into_response()
}

async fn callback(
    AxState(app): AxState<Arc<AppState>>,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let refused = |detail: &str| page(StatusCode::BAD_REQUEST, "Sign-in did not finish", detail);
    if let Some(error) = &q.error {
        return refused(q.error_description.as_deref().unwrap_or(error));
    }
    let (Some(state), Some(code)) = (&q.state, &q.code) else {
        return refused("This page was opened without a sign-in.");
    };
    match app
        .pipelines
        .mcp_auth()
        .finish(state, code, &app.settings)
        .await
    {
        Ok(server) => page(
            StatusCode::OK,
            &format!("Signed in to {server}"),
            "You can close this page.",
        ),
        Err(e) => refused(&e),
    }
}

#[derive(Deserialize)]
struct FinishReq {
    address: String,
}

async fn finish(
    AxState(app): AxState<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<FinishReq>,
) -> Result<Response, ApiError> {
    url_server(&app, &name)?;
    let (state, code) = Auth::finish_from_address(&req.address).map_err(bad)?;
    let server = app
        .pipelines
        .mcp_auth()
        .finish(&state, &code, &app.settings)
        .await
        .map_err(bad)?;
    Ok(Json(json!({ "server": server })).into_response())
}

async fn sign_out(
    AxState(app): AxState<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<Response, ApiError> {
    let server = url_server(&app, &name)?;
    app.pipelines
        .mcp_auth()
        .sign_out(&server, &app.settings)
        .await
        .map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

fn said(name: &str, failure: Failure) -> ApiError {
    bad(match failure {
        Failure::NeedsSignIn(_) => format!("Sign in to {name} first."),
        Failure::NeedsScope(_) => format!("{name} wants more access. Sign in again."),
        Failure::Other(e) => e,
    })
}

async fn test(
    AxState(app): AxState<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let server = cfg
        .mcp_servers
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no server named {name}")))?;
    let secrets = app.secrets()?;
    let saved = secrets.values().map(|(_, v)| v.to_string()).collect();
    let auth = app.pipelines.mcp_auth();
    let mut client = client_for(
        server,
        &cfg,
        &secrets,
        auth,
        &app.settings,
        saved,
        TEST_TIMEOUT,
    )
    .await
    .map_err(|f| said(&name, f))?;
    let version = client.connect().await.map_err(|f| said(&name, f))?;
    let tools = client.list_tools().await.map_err(|f| said(&name, f));
    client.close().await;
    let tools: Vec<_> = tools?
        .into_iter()
        .map(|t| json!({ "name": t.name, "description": t.description }))
        .collect();
    Ok(Json(json!({ "version": version, "tools": tools })).into_response())
}
