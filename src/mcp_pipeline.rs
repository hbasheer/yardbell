use crate::config::Config;
use crate::connectors::Connector;
use crate::dispatch::diff::words;
use crate::mcp::tool;
use crate::pipeline::definition::{
    check as check_definition, slug, Definition, Outcome, StepKind, END, WAIT,
};
use crate::pipeline::record::{PrRef, Run, RunState, Waiting};
use crate::web::{ApiError, AppState};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};

pub const TOOLS: [&str; 5] = [
    "save_connector",
    "save_pipeline",
    "set_pipeline_enabled",
    "run_pipeline",
    "answer_run",
];

// The hash and whether a step only reads record what a person chose, so what an agent sends for
// them never counts.
pub(crate) fn keep_tool_hashes(def: &mut Definition, before: Option<&Definition>) {
    for step in &mut def.steps {
        let StepKind::Tool {
            server,
            tool,
            schema_hash,
            call_kind,
            ..
        } = &mut step.kind
        else {
            continue;
        };
        let kept = before
            .and_then(|b| b.step(&step.id))
            .and_then(|old| match &old.kind {
                StepKind::Tool {
                    server: s,
                    tool: t,
                    schema_hash: h,
                    call_kind: k,
                    ..
                } if s == server && t == tool => Some((h.clone(), *k)),
                _ => None,
            });
        let (hash, kind) = kept.unwrap_or((String::new(), crate::connectors::CallKind::Change));
        *schema_hash = hash;
        *call_kind = kind;
    }
}

pub fn owns(tool: &str) -> bool {
    TOOLS.contains(&tool)
}

pub fn tools() -> Vec<Value> {
    vec![
        tool(
            "save_connector",
            "Propose a new connection to an outside tool, or a change to one: its address, headers and calls, as read_settings shows under connectors. Headers may only name saved secrets, like ${secret:name}: never send a token. It always waits for the user, and a new one arrives switched off for the user to check, add its secrets and switch on. allow_private can only be set in Settings.",
            json!({ "connector": { "type": "object", "description": "The whole connection: id, name, base_url, headers, params, calls" } }),
            &["connector"],
        ),
        tool(
            "save_pipeline",
            "Propose a new pipeline, or a change to one. For a change, read it first with read_pipeline and send the whole definition back with your edits, keeping its id; for a new one leave id empty. The pipeline is checked as the builder checks it, and any problem comes back to you to correct. It always waits for the user, who can approve it, finish it in the builder, or reject it; from a client other than Dispatch it waits in the user's Proposals inbox. A new pipeline is saved switched off.",
            json!({ "definition": { "type": "object", "description": "The whole pipeline definition, as read_pipeline returns it" } }),
            &["definition"],
        ),
        tool(
            "set_pipeline_enabled",
            "Propose switching a pipeline on or off. Switching on checks that its trigger can run, and a problem comes back to you. From a client other than Dispatch it waits in the user's Proposals inbox.",
            json!({
                "id": { "type": "string", "description": "The pipeline's id, from list_pipelines" },
                "on": { "type": "boolean" },
            }),
                        &["id", "on"],
        ),
        tool(
            "run_pipeline",
            "Propose starting a pipeline: one run per ticket or pull request, or one run with no subject when neither is given. tickets are Linear identifiers such as COM-12, from the user's open tickets; prs are GitHub pull request or GitLab merge request links. From a client other than Dispatch it waits in the user's Proposals inbox.",
            json!({
                "id": { "type": "string", "description": "The pipeline's id, from list_pipelines" },
                "tickets": { "type": "array", "items": { "type": "string" } },
                "prs": { "type": "array", "items": { "type": "string" } },
            }),
            &["id"],
        ),
        tool(
            "answer_run",
            "Propose acting on a pipeline run that waits for the user (read_run shows what it waits for): answer its question with text, retry the step, continue as if the step passed or failed, or drop the run. From a client other than Dispatch it waits in the user's Proposals inbox.",
            json!({
                "id": { "type": "string", "description": "The run's id, from list_runs" },
                "action": { "type": "string", "enum": ACTIONS },
                "text": { "type": "string", "description": "The answer, for action answer" },
            }),
            &["id", "action"],
        ),
    ]
}

const ACTIONS: [&str; 5] = ["answer", "retry", "continue_pass", "continue_fail", "drop"];

fn bad(message: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}

fn not_saved(list: Vec<String>) -> ApiError {
    bad(format!("Not saved: {}", list.join("; ")))
}

fn problems(list: Vec<String>) -> ApiError {
    bad(format!(
        "Not proposed, correct this and send the whole pipeline again: {}",
        list.join("; ")
    ))
}

#[derive(Deserialize)]
struct SaveConnector {
    connector: Connector,
}

// What may come from an agent is the connection's calls. Whether it is on, and whether it may reach
// a private address, stay what the person chose, and a new address gives up private reach.
fn connector_as_saved(cfg: &Config, mut c: Connector) -> Result<Connector, ApiError> {
    let existing = cfg.connectors.iter().find(|o| o.id == c.id);
    let same_host = existing.is_some_and(|o| {
        crate::connectors::host_of(&o.base_url) == crate::connectors::host_of(&c.base_url)
    });
    let kept_private = same_host && existing.is_some_and(|o| o.allow_private);
    if c.allow_private && !kept_private {
        return Err(bad("allow_private can only be set in Settings".into()));
    }
    c.allow_private = kept_private;
    c.enabled = existing.is_some_and(|o| o.enabled);
    if c.name.trim().is_empty() {
        c.name = c.id.clone();
    }
    if !c.server.is_empty() && !cfg.mcp_servers.iter().any(|s| s.name == c.server) {
        return Err(bad(format!(
            "{} is not in Settings, Connections, and only a person can add a server",
            c.server
        )));
    }
    crate::connectors::validate(std::slice::from_ref(&c)).map_err(bad)?;
    Ok(c)
}

#[derive(Deserialize)]
struct SavePipeline {
    definition: Definition,
    #[serde(default)]
    before: Option<Definition>,
}

#[derive(Deserialize)]
struct Enabled {
    id: String,
    on: bool,
}

#[derive(Deserialize)]
struct RunPipeline {
    id: String,
    #[serde(default)]
    tickets: Vec<String>,
    #[serde(default)]
    prs: Vec<String>,
}

#[derive(Deserialize)]
struct AnswerRun {
    id: String,
    action: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    waiting: Option<Waiting>,
}

fn arg<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| bad(e.to_string()))
}

fn existing(app: &AppState, id: &str) -> Option<Definition> {
    (!id.is_empty())
        .then(|| app.pipelines.library().get(id))
        .flatten()
}

fn found(app: &AppState, id: &str) -> Result<Definition, ApiError> {
    existing(app, id).ok_or_else(|| {
        let ids: Vec<String> = app
            .pipelines
            .library()
            .list()
            .into_iter()
            .map(|d| d.id)
            .collect();
        bad(format!(
            "there is no pipeline {id}; the pipelines are {}",
            ids.join(", ")
        ))
    })
}

fn checked_enabled(app: &AppState, cfg: &Config, e: &Enabled) -> Result<Definition, ApiError> {
    let mut def = found(app, &e.id)?;
    def.enabled = e.on;
    check_definition(&def, cfg).map_err(problems)?;
    Ok(def)
}

fn runnable(app: &AppState, r: &RunPipeline) -> Result<Definition, ApiError> {
    let def = found(app, &r.id)?;
    if def.steps.is_empty() {
        return Err(bad(format!("{} has no steps yet", def.name)));
    }
    if let Some(url) = r.prs.iter().find(|u| PrRef::parse(u).is_none()) {
        return Err(bad(format!(
            "{url} is not a GitHub pull request or GitLab merge request link"
        )));
    }
    Ok(def)
}

// The same conditions the Pipelines page's buttons are held to.
fn fits(run: &Run, action: &str, text: &str) -> Result<(), String> {
    let label = run.subject.label();
    let waiting = run.state == RunState::Waiting;
    match action {
        "answer" if text.trim().is_empty() => Err("type an answer first".into()),
        "answer" if waiting && run.waiting.as_ref().is_some_and(|w| w.kind.answerable()) => Ok(()),
        "answer" => Err(format!("{label} is not waiting for an answer")),
        "retry" | "continue_pass" | "continue_fail" if waiting => Ok(()),
        "retry" | "continue_pass" | "continue_fail" => {
            Err(format!("{label} is not waiting for you"))
        }
        "drop" if run.state.active() => Ok(()),
        "drop" => Err(format!("{label} has already ended")),
        other => Err(format!(
            "action {other:?} must be one of {}",
            ACTIONS.join(", ")
        )),
    }
}

fn answerable(app: &AppState, a: &AnswerRun) -> Result<Run, ApiError> {
    let run = app
        .pipelines
        .run(&a.id)
        .ok_or_else(|| bad(format!("there is no run {}; list_runs shows them", a.id)))?;
    fits(&run, &a.action, &a.text).map_err(bad)?;
    // A card answers the wait it was drawn for, never a later one at another step.
    if let Some(was) = &a.waiting {
        match &run.waiting {
            Some(now) if now.step == was.step && now.reason == was.reason => {}
            Some(now) => {
                return Err(bad(format!(
                    "{} now waits at {} for something else ({}); this was for {}",
                    run.subject.label(),
                    now.step,
                    now.reason,
                    was.step
                )))
            }
            None => {
                return Err(bad(format!(
                    "{} no longer waits at {}",
                    run.subject.label(),
                    was.step
                )))
            }
        }
    }
    Ok(run)
}

// A card for a new pipeline always makes a new one; a card for a change saves only the pipeline
// it showed, and only while it exists. The stored on or off is what the checks see.
fn aligned(app: &AppState, s: &mut SavePipeline) -> Result<Option<Definition>, ApiError> {
    let Some(before) = &s.before else {
        s.definition.enabled = false;
        return Ok(None);
    };
    if s.definition.id != before.id {
        return Err(bad(format!(
            "this card changes {}; its definition names another pipeline",
            before.name
        )));
    }
    let current = existing(app, &before.id).ok_or_else(|| {
        bad(format!(
            "{} was deleted since this was proposed",
            before.name
        ))
    })?;
    s.definition.enabled = current.enabled;
    Ok(Some(current))
}

pub fn plan(app: &AppState, cfg: &Config, tool: &str, args: Value) -> Result<Value, ApiError> {
    match tool {
        "save_connector" => {
            let SaveConnector { connector } = arg(args)?;
            let connector = connector_as_saved(cfg, connector)?;
            let before = cfg.connectors.iter().find(|c| c.id == connector.id);
            Ok(json!({
                "connector": connector,
                "host": crate::connectors::host_of(&connector.base_url),
                "before": before,
            }))
        }
        "save_pipeline" => {
            let SavePipeline { mut definition, .. } = arg(args)?;
            let before = existing(app, &definition.id);
            definition.enabled = before.as_ref().is_some_and(|b| b.enabled);
            keep_tool_hashes(&mut definition, before.as_ref());
            check_definition(&definition, cfg).map_err(problems)?;
            let changes = changes(before.as_ref(), &definition);
            Ok(json!({ "definition": definition, "before": before, "changes": changes }))
        }
        "set_pipeline_enabled" => {
            let e: Enabled = arg(args)?;
            let def = checked_enabled(app, cfg, &e)?;
            Ok(json!({ "id": def.id, "name": def.name, "on": e.on }))
        }
        "run_pipeline" => {
            let r: RunPipeline = arg(args)?;
            let def = runnable(app, &r)?;
            Ok(json!({ "id": def.id, "name": def.name, "tickets": r.tickets, "prs": r.prs }))
        }
        "answer_run" => {
            let a: AnswerRun = arg(args)?;
            let run = answerable(app, &a)?;
            Ok(json!({
                "id": run.id, "action": a.action, "text": a.text.trim(),
                "pipeline": run.pipeline_name, "subject": run.subject.label(), "waiting": run.waiting,
            }))
        }
        other => Err(bad(format!("{other} is not a pipeline tool"))),
    }
}

pub fn check(app: &AppState, cfg: &Config, tool: &str, input: &Value) -> Result<(), ApiError> {
    match tool {
        "save_connector" => {
            let SaveConnector { connector } = arg(input.clone())?;
            connector_as_saved(cfg, connector).map(|_| ())
        }
        "save_pipeline" => {
            let mut s: SavePipeline = arg(input.clone())?;
            aligned(app, &mut s)?;
            check_definition(&s.definition, cfg).map_err(problems)
        }
        "set_pipeline_enabled" => checked_enabled(app, cfg, &arg(input.clone())?).map(|_| ()),
        "run_pipeline" => runnable(app, &arg(input.clone())?).map(|_| ()),
        "answer_run" => answerable(app, &arg(input.clone())?).map(|_| ()),
        other => Err(bad(format!("{other} is not a pipeline tool"))),
    }
}

pub async fn perform(app: &AppState, tool: &str, input: Value) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let library = app.pipelines.library();
    let out = match tool {
        "save_connector" => {
            let SaveConnector { connector } = arg(input)?;
            let connector = connector_as_saved(&cfg, connector)?;
            let id = connector.id.clone();
            let mut all = cfg.connectors.clone();
            match all.iter().position(|c| c.id == id) {
                Some(i) => all[i] = connector,
                None => all.push(connector),
            }
            app.settings.set_connectors(all).map_err(bad)?;
            json!({ "saved": id })
        }
        "save_pipeline" => {
            let mut s: SavePipeline = arg(input)?;
            let current = aligned(app, &mut s)?;
            let SavePipeline {
                mut definition,
                before,
            } = s;
            keep_tool_hashes(&mut definition, current.as_ref());
            match current {
                Some(current) => {
                    let saved = library.save(definition, &cfg).map_err(not_saved)?;
                    let mut out =
                        json!({ "saved": saved.id, "name": saved.name, "version": saved.version });
                    if before.is_some_and(|b| b.version != current.version) {
                        out["note"] = json!(
                            "The pipeline had changed since this was proposed; this replaced it."
                        );
                        out["replaced"] = json!(current.version);
                    }
                    out
                }
                None => {
                    let taken: Vec<String> = library.list().into_iter().map(|d| d.id).collect();
                    definition.id = slug(&definition.name, &taken);
                    definition.version = 0;
                    definition.enabled = false;
                    let saved = library.save(definition, &cfg).map_err(not_saved)?;
                    json!({ "saved": saved.id, "name": saved.name, "version": saved.version })
                }
            }
        }
        "set_pipeline_enabled" => {
            let e: Enabled = arg(input)?;
            let def = library.set_enabled(&e.id, e.on, &cfg).map_err(not_saved)?;
            json!({ "id": def.id, "enabled": def.enabled })
        }
        "run_pipeline" => {
            let r: RunPipeline = arg(input)?;
            runnable(app, &r)?;
            let def = app.pipelines.library().get(&r.id).ok_or_else(|| {
                ApiError(
                    StatusCode::NOT_FOUND,
                    format!("there is no pipeline {}", r.id),
                )
            })?;
            let subjects =
                crate::web::pipeline_api::subjects(app, &def, &r.tickets, &r.prs).await?;
            let runs = app
                .pipelines
                .start(&r.id, subjects, "dispatch")
                .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
            json!({ "runs": runs.iter().map(|run| json!({ "id": run.id, "subject": run.subject.label() })).collect::<Vec<_>>() })
        }
        "answer_run" => {
            let a: AnswerRun = arg(input)?;
            answerable(app, &a)?;
            let pipelines = &app.pipelines;
            let run = match a.action.as_str() {
                "answer" => pipelines.answer(&a.id, &a.text),
                "retry" => pipelines.retry(&a.id),
                "continue_pass" => pipelines.continue_on(&a.id, Outcome::Pass),
                "continue_fail" => pipelines.continue_on(&a.id, Outcome::Fail),
                "drop" => pipelines.drop_run(&a.id),
                other => Err(format!(
                    "action {other:?} must be one of {}",
                    ACTIONS.join(", ")
                )),
            }
            .map_err(bad)?;
            json!({ "run": run.id, "state": run.state })
        }
        other => return Err(bad(format!("{other} is not a pipeline tool"))),
    };
    app.state.touch();
    Ok(out)
}

fn target(def: &Definition, other: &Definition, id: &str) -> String {
    match id {
        END => "the end".into(),
        WAIT => "wait for you".into(),
        id => def
            .step(id)
            .or_else(|| other.step(id))
            .map_or_else(|| id.to_string(), |s| s.name.clone()),
    }
}

fn instructions(kind: &StepKind) -> Option<&str> {
    match kind {
        StepKind::Agent { instructions, .. } => Some(instructions),
        _ => None,
    }
}

// What a save would change, said in step names: steps added, removed and edited, lines that now
// go elsewhere, and agents' instructions as word diffs. Positions on the canvas are left out.
pub fn changes(before: Option<&Definition>, after: &Definition) -> Value {
    let Some(before) = before else {
        return json!({ "trigger": false, "added": [], "removed": [], "changed": [], "lines": [], "wording": [] });
    };
    let names = |d: &Definition, other: &Definition| -> Vec<String> {
        d.steps
            .iter()
            .filter(|s| other.step(&s.id).is_none())
            .map(|s| s.name.clone())
            .collect()
    };
    let mut changed = Vec::new();
    let mut lines = Vec::new();
    let mut wording = Vec::new();
    if before.start != after.start {
        lines.push(json!({
            "from": "Start", "outcome": "start",
            "was": target(before, after, &before.start), "now": target(after, before, &after.start),
        }));
    }
    for now in &after.steps {
        let Some(was) = before.step(&now.id) else {
            continue;
        };
        let (a, b) = (json!(was), json!(now));
        let fields: Vec<&String> = b
            .as_object()
            .into_iter()
            .flat_map(|o| o.keys())
            .chain(a.as_object().into_iter().flat_map(|o| o.keys()))
            .filter(|k| !["id", "x", "y", "next"].contains(&k.as_str()))
            .filter(|k| a.get(k.as_str()) != b.get(k.as_str()))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        if !fields.is_empty() {
            changed.push(json!({ "step": now.name, "fields": fields }));
        }
        for (outcome, was_to, now_to) in [
            ("pass", &was.next.pass, &now.next.pass),
            ("fail", &was.next.fail, &now.next.fail),
            ("needs_you", &was.next.needs_you, &now.next.needs_you),
        ] {
            if was_to != now_to {
                lines.push(json!({
                    "from": now.name, "outcome": outcome,
                    "was": target(before, after, was_to), "now": target(after, before, now_to),
                }));
            }
        }
        if let (Some(old), Some(new)) = (instructions(&was.kind), instructions(&now.kind)) {
            if old != new {
                wording.push(json!({ "step": now.name, "diff": words(old, new) }));
            }
        }
    }
    json!({
        "trigger": before.trigger != after.trigger,
        "added": names(after, before),
        "removed": names(before, after),
        "changed": changed,
        "lines": lines,
        "wording": wording,
    })
}
