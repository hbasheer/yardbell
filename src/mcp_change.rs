use crate::config::Config;
use crate::dispatch::diff::{words, Part};
use crate::settings::{edit_machine, MachineEdit, Settings};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub const CHANGEABLE: [&str; 9] = [
    "dispatch",
    "triggers",
    "worktree_setup",
    "agents",
    "session_mcp_servers",
    "phone",
    "machines",
    "pipelines",
    "pull_requests",
];

const HIDDEN: &str = "(hidden)";

// An area as stored, in the shape read_settings shows it, with nothing hidden.
pub fn stored(cfg: &Config, area: &str) -> Value {
    match area {
        "dispatch" => to(&cfg.dispatch),
        "triggers" => to(&cfg.triggers),
        "worktree_setup" => to(&cfg.worktree_setup),
        "agents" => json!({ "default_agent": cfg.default_agent(), "custom": to(&cfg.agents) }),
        "session_mcp_servers" => to(&cfg.mcp_servers),
        "phone" => to(&cfg.phone_notifications),
        "machines" => json!(cfg
            .machines
            .iter()
            .map(|m| json!({
                "name": m.name,
                "local": m.local,
                "ssh": m.ssh,
                "mesh_ip": m.mesh_ip,
                "port_prefix": m.port_prefix,
                "root": m.root,
                "mesh": m.mesh,
            }))
            .collect::<Vec<_>>()),
        "pipelines" => to(&cfg.pipelines),
        "pull_requests" => to(&cfg.pull_requests),
        _ => Value::Null,
    }
}

fn to<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn identity(v: &Value) -> Option<String> {
    for key in ["name", "host"] {
        if let Some(s) = v[key].as_str() {
            return Some(format!("{key}={s}"));
        }
    }
    match (v["folder"].as_str(), v["machine"].as_str()) {
        (Some(f), m) => Some(format!("folder={f}@{}", m.unwrap_or("any"))),
        _ => None,
    }
}

fn keep(sent: &Value, stored: Option<&Value>, path: &str) -> Result<Value, String> {
    match sent {
        Value::String(s) if s.contains(HIDDEN) => match stored {
            Some(Value::String(t)) => Ok(Value::String(t.clone())),
            _ => Err(format!(
                "{path} says {HIDDEN} but there is no stored value to keep"
            )),
        },
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                Ok((
                    k.clone(),
                    keep(v, stored.and_then(|s| s.get(k)), &format!("{path}.{k}"))?,
                ))
            })
            .collect::<Result<serde_json::Map<_, _>, String>>()
            .map(Value::Object),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let theirs = stored.and_then(Value::as_array);
                let found = match identity(item) {
                    Some(id) => {
                        theirs.and_then(|t| t.iter().find(|x| identity(x).as_deref() == Some(&id)))
                    }
                    None => theirs.and_then(|t| t.get(i)),
                };
                keep(item, found, &format!("{path}[{i}]"))
            })
            .collect::<Result<Vec<_>, String>>()
            .map(Value::Array),
        other => Ok(other.clone()),
    }
}

// The sent value with the stored value back wherever it still says (hidden).
pub fn keep_hidden(sent: &Value, stored: &Value) -> Result<Value, String> {
    keep(sent, Some(stored), "value")
}

fn read<T: DeserializeOwned>(area: &str, value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("{area}: {e}"))
}

// Puts an area's new value into the config; the config is validated after.
fn put(cfg: &mut Config, area: &str, value: Value) -> Result<(), String> {
    match area {
        "dispatch" => {
            let mut d: crate::config::DispatchSettings = read(area, value)?;
            if cfg.dispatch.agent.is_empty() && d.agent == cfg.default_agent() {
                d.agent.clear();
            }
            cfg.dispatch = d;
        }
        "triggers" => cfg.triggers = read(area, value)?,
        "worktree_setup" => cfg.worktree_setup = read(area, value)?,
        "agents" => {
            let default = value["default_agent"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            cfg.agents = read(area, value["custom"].clone())?;
            if default != cfg.default_agent() {
                cfg.default_agent = Some(default).filter(|d| !d.is_empty());
            }
        }
        "session_mcp_servers" => cfg.mcp_servers = read(area, value)?,
        "phone" => cfg.phone_notifications = read(area, value)?,
        "machines" => {
            let sent: Vec<Value> = read(area, value)?;
            let mut names: Vec<&str> = sent.iter().filter_map(|m| m["name"].as_str()).collect();
            let mut have: Vec<&str> = cfg.machines.iter().map(|m| m.name.as_str()).collect();
            names.sort_unstable();
            have.sort_unstable();
            if names != have {
                return Err("adding or removing a machine is done in Settings, Machines".into());
            }
            let before = stored(cfg, "machines");
            for m in &sent {
                let name = m["name"].as_str().unwrap_or_default().to_string();
                // A machine left as it was is not checked again, so a setting Settings would
                // now refuse (an ssh alias, say) does not block a change to another machine.
                let unchanged = before
                    .as_array()
                    .and_then(|b| b.iter().find(|x| x["name"] == m["name"]))
                    .is_some_and(|x| x == m);
                if unchanged {
                    continue;
                }
                let edit: MachineEdit = read(area, m.clone())?;
                edit_machine(cfg, &name, &edit)?;
            }
        }
        "pipelines" => cfg.pipelines = read(area, value)?,
        "pull_requests" => cfg.pull_requests = read(area, value)?,
        _ => {
            return Err(format!(
                "{area} cannot be changed through tools; the areas that can are {}",
                CHANGEABLE.join(", ")
            ))
        }
    }
    Ok(())
}

// The config as it would be after the change, checked as Settings checks it.
pub fn check(cfg: &Config, area: &str, value: &Value) -> Result<Config, Vec<String>> {
    let kept = keep_hidden(value, &stored(cfg, area)).map_err(|e| vec![e])?;
    let mut next = cfg.clone();
    put(&mut next, area, kept).map_err(|e| vec![e])?;
    next.validate().map_err(|e| vec![e.to_string()])?;
    Ok(next)
}

// Applies the change to the config as it is now, with one backup for Undo.
pub fn apply(settings: &Settings, area: &str, value: Value) -> Result<(), String> {
    settings.change(|cfg| {
        let kept = keep_hidden(&value, &stored(cfg, area))?;
        put(cfg, area, kept)
    })
}

pub fn diff(before: &Value, after: &Value) -> Vec<Part> {
    let text = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    words(&text(before), &text(after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::settings::Settings;
    use serde_json::json;
    use std::sync::Arc;

    fn settings() -> (Settings, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let cfg = Config::load(std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        cfg.save(&path).unwrap();
        (
            Settings::new(
                path,
                dir.path().join("ssh_config"),
                Arc::new(chrono::Local::now),
            ),
            dir,
        )
    }

    #[test]
    fn keep_hidden_puts_stored_values_back() {
        let stored = json!([
            { "name": "a", "env": { "TOKEN": "real-a" }, "headers": { "Authorization": "Bearer real-h" } },
            { "name": "b", "url": "https://u:pw@x/sse?key=real-q" },
        ]);
        let sent = json!([
            { "name": "b", "url": "https://(hidden)@x/sse?key=(hidden)" },
            { "name": "a", "env": { "TOKEN": "(hidden)", "LOG": "debug" }, "headers": { "Authorization": "Bearer (hidden)" } },
        ]);
        let kept = keep_hidden(&sent, &stored).unwrap();
        assert_eq!(kept[0]["url"], "https://u:pw@x/sse?key=real-q");
        assert_eq!(kept[1]["env"], json!({ "TOKEN": "real-a", "LOG": "debug" }));
        assert_eq!(kept[1]["headers"]["Authorization"], "Bearer real-h");
    }

    #[test]
    fn keep_hidden_refuses_a_new_hidden() {
        let err = keep_hidden(
            &json!([{ "name": "new", "env": { "TOKEN": "(hidden)" } }]),
            &json!([]),
        )
        .unwrap_err();
        assert!(
            err.contains("says (hidden) but there is no stored value to keep"),
            "{err}"
        );
    }

    #[test]
    fn apply_each_area_saves_and_undo_restores() {
        let (settings, dir) = settings();
        let path = dir.path().join("yardbell.yml");
        let changes = [
            (
                "phone",
                json!({ "wait_minutes": 7, "agent_waiting": false, "session_ended": true, "machines": true, "memory": true }),
            ),
            ("pipelines", json!({ "per_machine": 3, "minutes": 90 })),
            (
                "dispatch",
                json!({ "instructions": "Be brief.", "approval": "prompt", "rules": [], "agent": "claude", "runs_on": "claude", "model": "", "codex_model": "" }),
            ),
            (
                "worktree_setup",
                json!([{ "folder": "app", "machine": "any", "command": "cp .env.example .env", "timeout_seconds": 120 }]),
            ),
            (
                "session_mcp_servers",
                json!([{ "name": "probe", "command": "probe-server" }]),
            ),
            (
                "pull_requests",
                json!({ "gitlab": [{ "host": "git.example.com", "token": "${secret:gitlab}" }] }),
            ),
            (
                "agents",
                json!({ "default_agent": "claude", "custom": [{ "name": "mine", "label": "Mine", "command": "mine-agent", "resume": "mine-agent --continue" }] }),
            ),
        ];
        for (area, value) in changes {
            let before = std::fs::read_to_string(&path).unwrap();
            apply(&settings, area, value.clone()).unwrap_or_else(|e| panic!("{area}: {e}"));
            let after = std::fs::read_to_string(&path).unwrap();
            assert_ne!(before, after, "{area} did not change the file");
            settings.undo().unwrap();
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                before,
                "Undo did not restore {area}"
            );
        }
        let cfg = Config::load(&path).unwrap();
        let mut machines = stored(&cfg, "machines");
        machines[0]["root"] = json!("/srv/projects");
        apply(&settings, "machines", machines).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().machines[0].root,
            "/srv/projects"
        );
    }

    #[test]
    fn machines_cannot_be_added_or_removed() {
        let (settings, dir) = settings();
        let cfg = Config::load(&dir.path().join("yardbell.yml")).unwrap();
        let mut machines = stored(&cfg, "machines");
        machines.as_array_mut().unwrap().pop();
        let err = apply(&settings, "machines", machines).unwrap_err();
        assert!(
            err.contains("adding or removing a machine is done in Settings, Machines"),
            "{err}"
        );
    }

    #[test]
    fn check_returns_the_validation_problems() {
        let (_settings, dir) = settings();
        let cfg = Config::load(&dir.path().join("yardbell.yml")).unwrap();
        let problems = check(
            &cfg,
            "pipelines",
            &json!({ "per_machine": 9, "minutes": 90 }),
        )
        .unwrap_err();
        assert!(
            problems[0].contains("pipelines.per_machine must be from 1 to 6"),
            "{problems:?}"
        );
        let ok = check(
            &cfg,
            "pipelines",
            &json!({ "per_machine": 3, "minutes": 90 }),
        )
        .unwrap();
        assert_eq!(ok.pipelines.per_machine, 3);
    }

    #[test]
    fn set_agents_and_set_pull_requests_validate() {
        let (settings, _dir) = settings();
        let pr = crate::config::PullRequests {
            poll_seconds: 5,
            ..Default::default()
        };
        let err = settings.set_pull_requests(pr).unwrap_err();
        assert!(
            err.contains("pull_requests.poll_seconds must be at least 30"),
            "{err}"
        );
        assert!(settings.set_agents(Some("nope".into()), vec![]).is_err());
    }

    #[test]
    fn a_diff_marks_what_changed() {
        let parts = diff(&json!({ "wait_minutes": 2 }), &json!({ "wait_minutes": 7 }));
        let text = serde_json::to_string(&parts).unwrap();
        assert!(text.contains('2') && text.contains('7'), "{text}");
    }
}
