use crate::config::Config;
use crate::dispatch::diff::{words, Part};
use crate::settings::{edit_machine, MachineEdit, Settings};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub const CHANGEABLE: [&str; 10] = [
    "dispatch",
    "triggers",
    "worktree_setup",
    "agents",
    "session_mcp_servers",
    "phone",
    "health_checks",
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
        "health_checks" => to(&cfg.health_checks),
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

// Where an entry sends what it holds; a saved credential is only kept while these stay the same.
const DESTINATIONS: [&str; 5] = ["url", "host", "command", "resume", "teardown"];

// Walks what was sent beside the area as stored and as read_settings showed it. A string that
// still says (hidden) takes the stored string, but only when it is exactly what was shown: text
// edited around a placeholder would be lost, and a placeholder moved elsewhere would carry a
// credential with it. New ${secret:} references are noted for the card.
struct Keep<'a> {
    uses: &'a mut Vec<String>,
}

impl Keep<'_> {
    fn walk(
        &mut self,
        sent: &Value,
        stored: Option<&Value>,
        shown: Option<&Value>,
        path: &str,
    ) -> Result<Value, String> {
        match sent {
            Value::String(s) if s.contains(HIDDEN) => match (stored, shown) {
                (Some(Value::String(t)), Some(Value::String(seen))) if seen == s => {
                    Ok(Value::String(t.clone()))
                }
                (Some(Value::String(_)), Some(Value::String(_))) => Err(format!(
                    "{path}: the text around {HIDDEN} cannot be changed here; send it as it was read, or change it in Settings"
                )),
                _ => Err(format!(
                    "{path} says {HIDDEN} but there is no stored value to keep"
                )),
            },
            Value::String(s) => {
                if shown.and_then(Value::as_str) != Some(s.as_str()) {
                    for found in SECRET_REF.find_iter(s) {
                        self.uses.push(format!("{} in {}", found.as_str(), path.trim_start_matches("value.")));
                    }
                }
                Ok(sent.clone())
            }
            Value::Object(map) => map
                .iter()
                .map(|(k, v)| {
                    let at = format!("{path}.{k}");
                    Ok((
                        k.clone(),
                        self.walk(v, stored.and_then(|s| s.get(k)), shown.and_then(|s| s.get(k)), &at)?,
                    ))
                })
                .collect::<Result<serde_json::Map<_, _>, String>>()
                .map(Value::Object),
            Value::Array(items) => items
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    let theirs = stored.and_then(Value::as_array);
                    let at = match identity(item) {
                        Some(id) => theirs.and_then(|t| {
                            t.iter().position(|x| identity(x).as_deref() == Some(&id))
                        }),
                        None => theirs.filter(|t| i < t.len()).map(|_| i),
                    };
                    let (found, seen) = match at {
                        Some(j) => (
                            theirs.and_then(|t| t.get(j)),
                            shown.and_then(Value::as_array).and_then(|t| t.get(j)),
                        ),
                        None => (None, None),
                    };
                    let path = format!("{path}[{i}]");
                    let kept = self.walk(item, found, seen, &path)?;
                    if item.to_string().contains(HIDDEN) {
                        if let Some(key) = seen.and_then(|seen| {
                            DESTINATIONS.into_iter().find(|k| item.get(k) != seen.get(k))
                        }) {
                            return Err(format!(
                                "{path}: its {key} changed, so the saved credentials in it are not kept; enter them again in Settings"
                            ));
                        }
                    }
                    Ok(kept)
                })
                .collect::<Result<Vec<_>, String>>()
                .map(Value::Array),
            other => Ok(other.clone()),
        }
    }
}

static SECRET_REF: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\$\{secret:[^}]*\}").expect("secret reference pattern")
});

// The sent value with the stored value back wherever it still says (hidden), and the new secret
// references it makes.
fn kept(
    cfg: &Config,
    area: &str,
    sent: &Value,
    saved: &[String],
) -> Result<(Value, Vec<String>), String> {
    let mut uses = Vec::new();
    let shown = crate::mcp_read::area_shown(cfg, area, saved);
    let value =
        Keep { uses: &mut uses }.walk(sent, Some(&stored(cfg, area)), Some(&shown), "value")?;
    Ok((value, uses))
}

// The new ${secret:} references a change makes, such as "${secret:gitlab} in gitlab[1].token".
pub fn secret_uses(cfg: &Config, area: &str, sent: &Value, saved: &[String]) -> Vec<String> {
    kept(cfg, area, sent, saved)
        .map(|(_, uses)| uses)
        .unwrap_or_default()
}

// The parts of stored strings that read_settings hides, so an error message that quotes a stored
// value (a validation problem naming an agent's process, say) can hide them again.
fn hidden_parts(stored: &Value, shown: &Value, out: &mut Vec<String>) {
    match (stored, shown) {
        (Value::String(real), Value::String(seen)) if seen.contains(HIDDEN) => {
            let pieces: Vec<&str> = seen.split(HIDDEN).collect();
            let mut rest = real.strip_prefix(pieces[0]).unwrap_or(real);
            for (n, piece) in pieces[1..].iter().enumerate() {
                let last = n + 2 == pieces.len();
                let at = match (last, piece.is_empty()) {
                    (true, _) => rest
                        .len()
                        .checked_sub(piece.len())
                        .filter(|_| rest.ends_with(piece)),
                    (false, true) => None,
                    (false, false) => rest.find(piece),
                };
                let Some(at) = at else {
                    out.push(real.clone());
                    break;
                };
                out.push(rest[..at].to_string());
                rest = &rest[at + piece.len()..];
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                if let Some(w) = b.get(k) {
                    hidden_parts(v, w, out);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for (v, w) in a.iter().zip(b) {
                hidden_parts(v, w, out);
            }
        }
        _ => {}
    }
}

fn scrub(message: &str, cfg: &Config, area: &str, saved: &[String]) -> String {
    let mut parts = Vec::new();
    hidden_parts(
        &stored(cfg, area),
        &crate::mcp_read::area_shown(cfg, area, saved),
        &mut parts,
    );
    parts.retain(|p| p.len() >= 3);
    parts.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let mut message = message.to_string();
    for part in parts {
        message = message.replace(&part, HIDDEN);
    }
    crate::mcp_read::scrubbed(&message, saved)
}

fn read<T: DeserializeOwned>(area: &str, value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("{area}: {e}"))
}

// The field names a struct reads, as serde names them, caught from the one call a struct makes.
struct Fields<'a>(&'a std::cell::Cell<Option<&'static [&'static str]>>);

impl<'de> serde::Deserializer<'de> for Fields<'_> {
    type Error = serde::de::value::Error;

    fn deserialize_any<V: serde::de::Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
        Err(serde::de::Error::custom("only the field names are read"))
    }

    fn deserialize_struct<V: serde::de::Visitor<'de>>(
        self,
        _: &'static str,
        fields: &'static [&'static str],
        _: V,
    ) -> Result<V::Value, Self::Error> {
        self.0.set(Some(fields));
        Err(serde::de::Error::custom("only the field names are read"))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option
        unit unit_struct newtype_struct seq tuple tuple_struct map enum identifier ignored_any
    }
}

fn fields_of<T: DeserializeOwned>() -> Option<&'static [&'static str]> {
    let found = std::cell::Cell::new(None);
    let _ = T::deserialize(Fields(&found));
    found.get()
}

// Serde drops a field a struct does not have, so it would be saved as if it were never sent.
// The area, or each entry of a list area, may hold only the fields its type reads, plus the
// extras read_settings adds for reading.
fn known<T: DeserializeOwned>(value: &Value, path: &str, extras: &[&str]) -> Result<(), String> {
    let Some(fields) = fields_of::<T>() else {
        return Ok(());
    };
    let check = |entry: &Value, at: &str| -> Result<(), String> {
        let unknown = entry
            .as_object()
            .into_iter()
            .flat_map(|o| o.keys())
            .find(|k| !fields.contains(&k.as_str()) && !extras.contains(&k.as_str()));
        match unknown {
            Some(k) => Err(format!(
                "{at}.{k} is not a setting here; read the area again and send back only its own fields"
            )),
            None => Ok(()),
        }
    };
    match value {
        Value::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(i, item)| check(item, &format!("{path}[{i}]"))),
        other => check(other, path),
    }
}

// Puts an area's new value into the config; the config is validated after.
fn put(cfg: &mut Config, area: &str, value: Value) -> Result<(), String> {
    match area {
        "dispatch" => {
            known::<crate::config::DispatchSettings>(&value, area, &[])?;
            let mut d: crate::config::DispatchSettings = read(area, value)?;
            if cfg.dispatch.agent.is_empty() && d.agent == cfg.default_agent() {
                d.agent.clear();
            }
            cfg.dispatch = d;
        }
        "triggers" => {
            known::<crate::triggers::Trigger>(&value, area, &["enabled"])?;
            cfg.triggers = read(area, value)?;
        }
        "worktree_setup" => {
            known::<crate::worktrees::setup::WorktreeSetup>(&value, area, &[])?;
            cfg.worktree_setup = read(area, value)?;
        }
        "agents" => {
            if let Some(key) = value.as_object().and_then(|o| {
                o.keys()
                    .find(|k| !["default_agent", "custom", "all"].contains(&k.as_str()))
            }) {
                return Err(format!(
                    "agents.{key} is not a setting here; read the area again and send back only its own fields"
                ));
            }
            let default = value["default_agent"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            known::<crate::agents::Agent>(&value["custom"], "agents.custom", &[])?;
            let custom: Vec<crate::agents::Agent> = read("agents.custom", value["custom"].clone())?;
            let builtin = crate::agents::builtin();
            if let Some(a) = custom.iter().find(|a| {
                builtin.iter().any(|b| b.name == a.name)
                    && !cfg.agents.iter().any(|c| c.name == a.name)
            }) {
                return Err(format!(
                    "agents.custom: {} is a built-in agent, which cannot be replaced here; give the new agent its own name",
                    a.name
                ));
            }
            cfg.agents = custom;
            if default != cfg.default_agent() {
                cfg.default_agent = Some(default).filter(|d| !d.is_empty());
            }
        }
        "session_mcp_servers" => {
            known::<crate::config::McpServer>(&value, area, &[])?;
            let mut servers: Vec<crate::config::McpServer> = read(area, value)?;
            // Reaching private addresses stays a person's choice, for the address they chose it for.
            for s in &mut servers {
                s.allow_private = cfg
                    .mcp_servers
                    .iter()
                    .any(|old| old.name == s.name && old.url == s.url && old.allow_private);
            }
            cfg.mcp_servers = servers;
        }
        "phone" => {
            known::<crate::config::PhoneNotifications>(&value, area, &[])?;
            cfg.phone_notifications = read(area, value)?;
        }
        "health_checks" => {
            known::<crate::config::HealthChecks>(&value, area, &[])?;
            cfg.health_checks = read(area, value)?;
        }
        "machines" => {
            let sent: Vec<Value> =
                serde_json::from_value(value).map_err(|e| format!("{area}: {e}"))?;
            let mut names: Vec<&str> = sent.iter().filter_map(|m| m["name"].as_str()).collect();
            let mut have: Vec<&str> = cfg.machines.iter().map(|m| m.name.as_str()).collect();
            names.sort_unstable();
            have.sort_unstable();
            if names != have {
                return Err("adding or removing a machine is done in Settings, Machines".into());
            }
            let before = stored(cfg, "machines");
            for (i, m) in sent.iter().enumerate() {
                let name = m["name"].as_str().unwrap_or_default().to_string();
                let was = before
                    .as_array()
                    .and_then(|b| b.iter().find(|x| x["name"] == m["name"]));
                // A machine left as it was is not checked again, so a setting Settings would
                // now refuse (an ssh alias, say) does not block a change to another machine.
                if was == Some(m) {
                    continue;
                }
                if was.is_some_and(|w| w.get("local") != m.get("local")) {
                    return Err(format!(
                        "machines[{i}].local cannot be changed here; a machine's kind is set when it is added"
                    ));
                }
                let at = format!("machines[{i}]");
                known::<MachineEdit>(m, &at, &["name", "local"])?;
                let edit: MachineEdit = read(&at, m.clone())?;
                edit_machine(cfg, &name, &edit)?;
            }
        }
        "pipelines" => {
            known::<crate::config::Pipelines>(&value, area, &[])?;
            cfg.pipelines = read(area, value)?;
        }
        "pull_requests" => {
            known::<crate::config::PullRequests>(&value, area, &[])?;
            cfg.pull_requests = read(area, value)?;
        }
        _ => {
            return Err(format!(
                "{area} cannot be changed through tools; the areas that can are {}",
                CHANGEABLE.join(", ")
            ))
        }
    }
    Ok(())
}

// The config as it would be after the change, checked as Settings checks it. No problem it
// reports quotes a credential.
pub fn check(
    cfg: &Config,
    area: &str,
    value: &Value,
    saved: &[String],
) -> Result<Config, Vec<String>> {
    let fail = |e: String| vec![scrub(&e, cfg, area, saved)];
    let (value, _) = kept(cfg, area, value, saved).map_err(fail)?;
    let mut next = cfg.clone();
    put(&mut next, area, value).map_err(fail)?;
    next.validate().map_err(|e| fail(e.to_string()))?;
    Ok(next)
}

// Applies the change to the config as it is now, with one backup for Undo.
pub fn apply(
    settings: &Settings,
    area: &str,
    value: Value,
    saved: &[String],
) -> Result<(), String> {
    let mut before = None;
    settings
        .change(|cfg| {
            before = Some(cfg.clone());
            let (value, _) = kept(cfg, area, &value, saved)?;
            put(cfg, area, value)
        })
        .map_err(|e| match &before {
            Some(cfg) => scrub(&e, cfg, area, saved),
            None => crate::mcp_read::scrubbed(&e, saved),
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

    fn keep_hidden(sent: &Value, stored: &Value, shown: &Value) -> Result<Value, String> {
        Keep {
            uses: &mut Vec::new(),
        }
        .walk(sent, Some(stored), Some(shown), "value")
    }

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
        let shown = json!([
            { "name": "a", "env": { "TOKEN": "(hidden)" }, "headers": { "Authorization": "Bearer (hidden)" } },
            { "name": "b", "url": "https://(hidden)@x/sse?key=(hidden)" },
        ]);
        let kept = keep_hidden(&sent, &stored, &shown).unwrap();
        assert_eq!(kept[0]["url"], "https://u:pw@x/sse?key=real-q");
        assert_eq!(kept[1]["env"], json!({ "TOKEN": "real-a", "LOG": "debug" }));
        assert_eq!(kept[1]["headers"]["Authorization"], "Bearer real-h");
    }

    #[test]
    fn keep_hidden_refuses_a_new_hidden() {
        let err = keep_hidden(
            &json!([{ "name": "new", "env": { "TOKEN": "(hidden)" } }]),
            &json!([]),
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
            apply(&settings, area, value.clone(), &[]).unwrap_or_else(|e| panic!("{area}: {e}"));
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
        apply(&settings, "machines", machines, &[]).unwrap();
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
        let err = apply(&settings, "machines", machines, &[]).unwrap_err();
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
            &[],
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
            &[],
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

    fn planted() -> (Settings, tempfile::TempDir, Config) {
        let (settings, dir) = settings();
        let path = dir.path().join("yardbell.yml");
        let mut cfg = Config::load(&path).unwrap();
        cfg.agents = vec![crate::agents::Agent {
            name: "mine".into(),
            label: Some("Mine".into()),
            command: "ANTHROPIC_API_KEY=sk-inline-real-999 claude".into(),
            resume: "claude --continue".into(),
            process: Some("claude".into()),
            prompt_arg: None,
        }];
        cfg.mcp_servers = vec![crate::config::McpServer {
            name: "lin".into(),
            command: String::new(),
            url: "https://mcp.linear.app/sse".into(),
            env: Default::default(),
            headers: [(
                "Authorization".to_string(),
                "Bearer lin_api_realrealreal".to_string(),
            )]
            .into(),
            machines: vec![],
            allow_private: false,
        }];
        cfg.pull_requests.gitlab = vec![crate::config::GitLabHost {
            host: "git.example.com".into(),
            url: String::new(),
            token: "glpat-realrealreal".into(),
        }];
        cfg.save(&path).unwrap();
        (settings, dir, cfg)
    }

    fn shown(cfg: &Config, area: &str) -> Value {
        crate::mcp_read::area_shown(cfg, area, &[])
    }

    #[test]
    fn every_area_read_and_sent_back_passes() {
        let (_settings, _dir, cfg) = planted();
        for area in CHANGEABLE {
            check(&cfg, area, &shown(&cfg, area), &[]).unwrap_or_else(|e| panic!("{area}: {e:?}"));
        }
    }

    #[test]
    fn an_error_never_echoes_a_kept_credential() {
        let (settings, _dir, cfg) = planted();
        let mut agents = shown(&cfg, "agents");
        assert_eq!(
            agents["custom"][0]["command"],
            "ANTHROPIC_API_KEY=(hidden) claude"
        );
        agents["custom"][0]
            .as_object_mut()
            .unwrap()
            .remove("process");
        let problems = check(&cfg, "agents", &agents, &[]).unwrap_err().join(" ");
        assert!(
            problems.contains("must be a plain program name"),
            "{problems}"
        );
        assert!(!problems.contains("sk-inline-real-999"), "{problems}");
        let err = apply(&settings, "agents", agents, &[]).unwrap_err();
        assert!(!err.contains("sk-inline-real-999"), "{err}");
    }

    #[test]
    fn a_kept_credential_does_not_follow_a_changed_destination() {
        let (_settings, _dir, cfg) = planted();
        let mut servers = shown(&cfg, "session_mcp_servers");
        servers[0]["url"] = json!("https://evil.example/sse");
        let problems = check(&cfg, "session_mcp_servers", &servers, &[]).unwrap_err();
        assert!(problems[0].contains("its url changed"), "{problems:?}");

        let mut pr = shown(&cfg, "pull_requests");
        pr["gitlab"][0]["url"] = json!("https://evil.example");
        let problems = check(&cfg, "pull_requests", &pr, &[]).unwrap_err();
        assert!(problems[0].contains("its url changed"), "{problems:?}");

        let mut agents = shown(&cfg, "agents");
        agents["custom"][0]["resume"] = json!("evil --continue");
        assert!(check(&cfg, "agents", &agents, &[]).is_err());
    }

    #[test]
    fn a_new_secret_reference_is_named() {
        let (_settings, _dir, cfg) = planted();
        let mut pr = shown(&cfg, "pull_requests");
        assert!(secret_uses(&cfg, "pull_requests", &pr, &[]).is_empty());
        pr["gitlab"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "host": "evil.example", "token": "${secret:gitlab}" }));
        let uses = secret_uses(&cfg, "pull_requests", &pr, &[]);
        assert_eq!(
            uses,
            vec!["${secret:gitlab} in gitlab[1].token".to_string()]
        );
    }

    #[test]
    fn editing_around_hidden_is_refused() {
        let (_settings, _dir, cfg) = planted();
        let mut agents = shown(&cfg, "agents");
        agents["custom"][0]["command"] = json!("ANTHROPIC_API_KEY=(hidden) claude --read-only");
        let problems = check(&cfg, "agents", &agents, &[]).unwrap_err();
        assert!(
            problems[0].contains("the text around (hidden) cannot be changed here"),
            "{problems:?}"
        );
    }

    #[test]
    fn fields_an_area_does_not_have_are_refused() {
        let (_settings, _dir, cfg) = planted();
        let problems = check(&cfg, "phone", &json!({ "wait_minute": 9 }), &[]).unwrap_err();
        assert!(
            problems[0].contains("wait_minute is not a setting"),
            "{problems:?}"
        );

        let mut machines = shown(&cfg, "machines");
        machines[0]["bogus"] = json!("x");
        machines[0]["root"] = json!("/srv/projects");
        let problems = check(&cfg, "machines", &machines, &[]).unwrap_err();
        assert!(
            problems[0].contains("bogus is not a setting"),
            "{problems:?}"
        );

        let mut machines = shown(&cfg, "machines");
        let local = machines[0]["local"].as_bool().unwrap();
        machines[0]["local"] = json!(!local);
        let problems = check(&cfg, "machines", &machines, &[]).unwrap_err();
        assert!(
            problems[0].contains("local cannot be changed here"),
            "{problems:?}"
        );

        let mut agents = shown(&cfg, "agents");
        agents["custom"].as_array_mut().unwrap().push(
            json!({ "name": "claude", "label": "Claude", "command": "evil-bin", "resume": "evil-bin" }),
        );
        let problems = check(&cfg, "agents", &agents, &[]).unwrap_err();
        assert!(
            problems[0].contains("claude is a built-in agent"),
            "{problems:?}"
        );
    }

    #[test]
    fn a_diff_marks_what_changed() {
        let parts = diff(&json!({ "wait_minutes": 2 }), &json!({ "wait_minutes": 7 }));
        let text = serde_json::to_string(&parts).unwrap();
        assert!(text.contains('2') && text.contains('7'), "{text}");
    }
}
