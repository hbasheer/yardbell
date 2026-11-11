use super::{ApiError, AppState};
use crate::config::VoiceInput;
use crate::voice::ModelStore;
use crate::voice_models::{
    find_ffmpeg, find_whisper, recommended, FFMPEG_MISSING, WHISPER_MISSING,
};
use axum::extract::{Path as UrlPath, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/settings/voice/models", get(models))
        .route("/api/settings/voice/models/{name}/download", post(download))
        .route("/api/settings/voice/models/{name}/cancel", post(cancel))
        .route("/api/settings/voice/models/{name}/delete", post(delete))
        .route("/api/settings/voice/models/{name}/use", post(use_model))
        .route("/api/settings/voice/setup", post(setup))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn active(store: &ModelStore, voice: &crate::config::VoiceSettings) -> Option<PathBuf> {
    store.resolve(&voice.whisper_model).ok()
}

async fn models(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let voice = app.config()?.voice;
    let store = ModelStore::default();
    let in_use = active(&store, &voice);
    let catalog_name = store
        .catalog
        .iter()
        .find(|m| in_use.as_ref() == Some(&store.file(m.name)))
        .map(|m| m.name);
    let list: Vec<_> = store
        .catalog
        .iter()
        .map(|m| {
            json!({
                "name": m.name,
                "label": m.label,
                "bytes": m.bytes,
                "quality": m.quality,
                "english_only": m.english_only,
                "note": m.note,
                "downloaded": store.downloaded(m.name),
                "partial": store.partial(m.name),
                "download": store.progress(m.name),
            })
        })
        .collect();
    let custom = match (&in_use, catalog_name) {
        (Some(path), None) => Some(json!({ "path": path, "found": path.is_file() })),
        _ => None,
    };
    Ok(Json(json!({
        "dir": store.dir,
        "input": voice.input,
        "active": catalog_name,
        "custom": custom,
        "recommended": recommended(&voice.language),
        "whisper": find_whisper(&voice.whisper_command),
        "ffmpeg": find_ffmpeg().is_some(),
        "models": list,
    }))
    .into_response())
}

async fn download(
    AxState(_app): AxState<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Response, ApiError> {
    let store = ModelStore::default();
    let model = store.known(&name).map_err(bad)?;
    let claim = store
        .start(model.name)
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    tokio::spawn(async move {
        if let Err(e) = ModelStore::default().run(model.name, claim).await {
            tracing::warn!(model = model.name, error = %e, "the speech model did not download");
        }
    });
    Ok((StatusCode::ACCEPTED, Json(json!({ "ok": true }))).into_response())
}

async fn cancel(UrlPath(name): UrlPath<String>) -> Result<Response, ApiError> {
    let store = ModelStore::default();
    let model = store.known(&name).map_err(bad)?;
    Ok(Json(json!({ "ok": store.cancel(model.name) })).into_response())
}

async fn delete(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Response, ApiError> {
    let store = ModelStore::default();
    let model = store.known(&name).map_err(bad)?;
    let voice = app.config()?.voice;
    if voice.input == VoiceInput::Local && active(&store, &voice) == Some(store.file(model.name)) {
        return Err(bad(format!(
            "{} is the model dictation uses. Pick another model first, or turn voice input off.",
            model.label
        )));
    }
    store.delete(model.name).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

// The tools are looked for before anything downloads, so a missing whisper.cpp is said at once
// rather than after a long download.
fn tools(voice: &crate::config::VoiceSettings) -> Result<PathBuf, ApiError> {
    let whisper =
        find_whisper(&voice.whisper_command).ok_or_else(|| bad(WHISPER_MISSING.into()))?;
    if find_ffmpeg().is_none() {
        return Err(bad(FFMPEG_MISSING.into()));
    }
    Ok(whisper)
}

fn switch_to(app: &AppState, whisper: &std::path::Path, name: &str) -> Result<(), String> {
    let mut voice = app.config().map_err(|e| e.1)?.voice;
    voice.input = VoiceInput::Local;
    voice.whisper_command = whisper.display().to_string();
    voice.whisper_model = name.to_string();
    app.settings.set_voice(voice)
}

async fn use_model(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Response, ApiError> {
    let store = ModelStore::default();
    let model = store.known(&name).map_err(bad)?;
    if !store.downloaded(model.name) {
        return Err(bad(format!("{} is not downloaded yet.", model.label)));
    }
    let whisper = tools(&app.config()?.voice)?;
    switch_to(&app, &whisper, model.name).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct SetupReq {
    #[serde(default)]
    model: String,
}

async fn setup(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<SetupReq>,
) -> Result<Response, ApiError> {
    let voice = app.config()?.voice;
    let store = ModelStore::default();
    let name = match req.model.trim() {
        "" => recommended(&voice.language),
        given => given,
    };
    let model = store.known(name).map_err(bad)?;
    let whisper = tools(&voice)?;
    if store.downloaded(model.name) {
        switch_to(&app, &whisper, model.name).map_err(bad)?;
        return Ok(Json(json!({ "ok": true, "ready": true, "model": model.name })).into_response());
    }
    let claim = store
        .start(model.name)
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    let state = app.clone();
    tokio::spawn(async move {
        match ModelStore::default().run(model.name, claim).await {
            Ok(_) => {
                if let Err(e) = switch_to(&state, &whisper, model.name) {
                    tracing::warn!(error = %e, "voice input could not be switched to the new model");
                }
            }
            Err(e) => {
                tracing::warn!(model = model.name, error = %e, "the speech model did not download")
            }
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "ok": true, "ready": false, "model": model.name })),
    )
        .into_response())
}
