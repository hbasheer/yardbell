use super::{ApiError, AppState};
use crate::pipeline::definition::StepKind;
use crate::pipeline::transcript;
use axum::extract::{Path, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::sync::Arc;

fn unavailable(why: String) -> Result<Response, ApiError> {
    Ok(Json(json!({ "available": false, "why": why })).into_response())
}

// Read from the machine on each ask: a finished run keeps only the transcripts' names, and the
// agent's own files are the record.
pub async fn transcript(
    AxState(app): AxState<Arc<AppState>>,
    Path((id, step)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let run = app
        .pipelines
        .run(&id)
        .filter(|r| !r.deleting)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("{id} is not a run")))?;
    let st = run.steps.get(&step).ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!("{step} has not run in this run"),
        )
    })?;
    let def_step = run.def().step(&step);
    let name = def_step.map_or(step.as_str(), |s| s.name.as_str());
    let agent = match def_step.map(|s| &s.kind) {
        Some(StepKind::Agent { agent, .. }) => agent,
        Some(StepKind::Plan { .. } | StepKind::Report) => {
            return unavailable(format!(
                "{name} ran in Dispatch, so it has no agent transcript. Its conversation shows what it did."
            ))
        }
        Some(_) => {
            return unavailable(format!(
                "{name} is carried out by Yardbell itself, with no agent, so it has no transcript."
            ))
        }
        None => {
            return unavailable(format!(
                "{name} is not in this run's version of the pipeline."
            ))
        }
    };
    let cfg = app.config()?;
    if !cfg.agent_reports_tokens(agent) {
        let who = if agent.is_empty() {
            cfg.default_agent()
        } else {
            agent
        };
        return unavailable(format!(
            "{name} ran on {who}. Yardbell can only read Claude Code transcripts."
        ));
    }
    if st.machine.is_empty() || st.path.is_empty() {
        return unavailable(format!(
            "{name} never started an agent session, so it has no transcript."
        ));
    }
    let Some(m) = cfg.machine(&st.machine) else {
        return unavailable(format!(
            "{} is no longer one of your machines, so its transcript cannot be read.",
            st.machine
        ));
    };
    let prefix = format!("{}:", st.machine);
    let names: Vec<String> = run
        .tokens
        .sources
        .keys()
        .filter_map(|k| k.strip_prefix(&prefix))
        .filter(|f| f.ends_with(".jsonl") && !f.contains('/'))
        .map(str::to_string)
        .collect();
    let needles = transcript::needles(&run, &step);
    let text = match app
        .sessions
        .step_transcript(m, &st.path, &names, &needles)
        .await
    {
        Ok(text) => text,
        Err(e) => {
            return unavailable(format!(
                "Yardbell could not read the transcript on {}: {e}",
                st.machine
            ))
        }
    };
    let read = transcript::read(&text, &run, &step);
    if read.items.is_empty() {
        return unavailable(format!(
            "No transcript of {name} was found in {} on {}. Claude Code may have removed it, or the session used another config folder.",
            st.path, st.machine
        ));
    }
    Ok(Json(json!({
        "available": true,
        "machine": st.machine,
        "path": st.path,
        "transcript": read,
    }))
    .into_response())
}
