pub mod codex;
pub mod gemini;
pub mod stats;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::dispatch::{ClaudeAccount, Dispatch};

// A check right after another one gets that check's figures instead of asking again.
const FRESH: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq)]
pub struct Fetched {
    pub plan: Option<String>,
    pub windows: Vec<Value>,
    pub source: &'static str,
    pub credits: Option<String>,
}

pub struct Config {
    pub claude: ClaudeAccount,
    pub claude_cli: bool,
    pub codex_home: Option<PathBuf>,
    pub codex_cli: bool,
    pub codex_command: Option<PathBuf>,
    pub codex_url: String,
    pub gemini_dir: Option<PathBuf>,
    pub gemini_cli: bool,
    pub gemini_url: String,
    pub stats_cache: PathBuf,
}

impl Config {
    // The machine Yardbell runs on. YARDBELL_CODEX_USAGE_URL and YARDBELL_GEMINI_URL point it at
    // stand-ins; YARDBELL_CODEX_COMMAND picks the Codex it asks when ChatGPT does not answer, and an
    // empty one asks none.
    pub fn system(state_dir: &Path) -> Config {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let dirs = cli_dirs(std::env::var_os("PATH"), home.as_deref());
        let find = |name: &str| find_cli(&dirs, name);
        let codex_command = match std::env::var("YARDBELL_CODEX_COMMAND") {
            Ok(set) if set.trim().is_empty() => None,
            Ok(set) => Some(PathBuf::from(set)),
            Err(_) => find("codex"),
        };
        let codex_home = match std::env::var_os("CODEX_HOME") {
            Some(dir) => Some(PathBuf::from(dir)),
            None => home.as_ref().map(|h| h.join(".codex")),
        };
        Config {
            claude: ClaudeAccount::system(),
            claude_cli: find("claude").is_some(),
            codex_home,
            codex_cli: find("codex").is_some(),
            codex_command,
            codex_url: std::env::var("YARDBELL_CODEX_USAGE_URL")
                .unwrap_or_else(|_| codex::USAGE_URL.into()),
            gemini_dir: home.as_ref().map(|h| h.join(".gemini")),
            gemini_cli: find("gemini").is_some(),
            gemini_url: std::env::var("YARDBELL_GEMINI_URL")
                .unwrap_or_else(|_| gemini::BASE_URL.into()),
            stats_cache: state_dir.join("usage-stats.json"),
        }
    }
}

// A service started by systemd or launchd gets a short PATH, so the places the agents' installers
// use are looked in too.
fn cli_dirs(path: Option<std::ffi::OsString>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = home {
        for sub in [".local/bin", ".npm-global/bin", ".bun/bin", ".claude/local"] {
            dirs.push(home.join(sub));
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs
}

fn find_cli(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    dirs.iter().map(|d| d.join(name)).find(|p| {
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

struct Checked {
    fetched: Fetched,
    seen: String,
}

impl Checked {
    fn new(fetched: Fetched) -> Checked {
        Checked {
            fetched,
            seen: chrono::Local::now().to_rfc3339(),
        }
    }
}

#[derive(Default)]
struct Live {
    claude_error: Option<String>,
    codex: Option<Result<Checked, String>>,
    gemini: Option<Result<Checked, String>>,
    checked: Option<Instant>,
}

pub struct Usage {
    cfg: Config,
    http: reqwest::Client,
    live: Mutex<Live>,
    checking: tokio::sync::Mutex<()>,
    stats: Arc<stats::Stats>,
}

impl Usage {
    pub fn new(cfg: Config) -> Usage {
        let stats = Arc::new(stats::Stats::new(
            cfg.claude.dir.clone(),
            cfg.codex_home.clone(),
            cfg.stats_cache.clone(),
        ));
        Usage {
            cfg,
            http: reqwest::Client::new(),
            live: Mutex::new(Live::default()),
            checking: tokio::sync::Mutex::new(()),
            stats,
        }
    }

    pub fn stats(&self) -> Arc<stats::Stats> {
        self.stats.clone()
    }

    pub async fn refresh(&self, dispatch: &Dispatch) {
        let _one_at_a_time = self.checking.lock().await;
        self.check(dispatch).await;
    }

    pub async fn refresh_now(&self, dispatch: &Dispatch) {
        let _one_at_a_time = self.checking.lock().await;
        let checked = self.live.lock().expect("usage lock").checked;
        if checked.is_some_and(|at| at.elapsed() < FRESH) {
            return;
        }
        self.check(dispatch).await;
    }

    async fn check(&self, dispatch: &Dispatch) {
        let (claude, codex, gemini) = tokio::join!(
            dispatch.refresh_usage(&self.http, &self.cfg.claude),
            self.check_codex(),
            self.check_gemini(),
        );
        if let Err(e) = &claude {
            tracing::debug!(error = %e, "Claude usage not refreshed from the account");
        }
        if let Some(Err(e)) = &codex {
            tracing::debug!(error = %e, "Codex usage not refreshed");
        }
        let mut live = self.live.lock().expect("usage lock");
        live.claude_error = claude.err();
        live.codex = codex.map(|r| r.map(Checked::new));
        live.gemini = gemini.map(|r| r.map(Checked::new));
        live.checked = Some(Instant::now());
    }

    async fn check_codex(&self) -> Option<Result<Fetched, String>> {
        let home = self.cfg.codex_home.as_deref()?;
        if !codex::auth_file(home).is_file() {
            return None;
        }
        let backend = codex::from_backend(&self.http, &self.cfg.codex_url, home).await;
        let Err(backend_error) = backend else {
            return Some(backend);
        };
        let Some(command) = &self.cfg.codex_command else {
            return Some(Err(backend_error));
        };
        Some(codex::from_app_server(command, home).await)
    }

    async fn check_gemini(&self) -> Option<Result<Fetched, String>> {
        let dir = self.cfg.gemini_dir.as_deref()?;
        if !gemini::creds_file(dir).is_file() {
            return None;
        }
        Some(gemini::fetch(&self.http, &self.cfg.gemini_url, dir).await)
    }

    // One entry per agent this machine has, each with its limit windows or why there are none.
    // An agent with neither its CLI nor a sign-in here is left out.
    pub fn providers(&self, dispatch: &Dispatch) -> Vec<Value> {
        let live = self.live.lock().expect("usage lock");
        let mut out = Vec::new();
        if let Some(claude) = self.claude(&live, &dispatch.usage()) {
            out.push(claude);
        }
        if let Some(codex) = self.codex(&live, &dispatch.codex_usage()) {
            out.push(codex);
        }
        if let Some(gemini) = self.gemini(&live) {
            out.push(gemini);
        }
        out
    }

    fn claude(&self, live: &Live, figures: &Value) -> Option<Value> {
        let windows = windows_of(figures);
        let signed_in = self.cfg.claude.signed_in();
        let error = live.claude_error.clone();
        if windows.is_empty() && !signed_in && !self.cfg.claude_cli {
            return None;
        }
        let mut entry = provider("claude", "Claude", figures["plan"].as_str());
        if !windows.is_empty() {
            entry["windows"] = json!(windows);
            entry["seen"] = figures["seen"].clone();
            entry["source"] = figures["source"].clone();
            if figures["source"] == "dispatch" {
                entry["note"] = json!("From Dispatch's last reply");
            }
            if let Some(e) = error {
                entry["error"] = json!(sentence(&e));
            }
        } else if !signed_in {
            entry["status"] = json!("signed_out");
            entry["message"] = json!("Not signed in");
        } else if let Some(e) = error {
            entry["status"] = json!("error");
            entry["message"] = json!(sentence(&e));
        } else {
            entry["status"] = json!("waiting");
            entry["message"] = json!("Not checked yet");
        }
        Some(entry)
    }

    fn codex(&self, live: &Live, dispatch_figures: &Value) -> Option<Value> {
        let from_dispatch = windows_of(dispatch_figures);
        let signed_in = self
            .cfg
            .codex_home
            .as_deref()
            .is_some_and(|h| codex::auth_file(h).is_file());
        let mut entry = provider("codex", "Codex", None);
        match &live.codex {
            Some(Ok(checked)) => {
                entry["plan"] = json!(checked.fetched.plan.as_deref().map(plan_label));
                entry["credits"] = json!(checked.fetched.credits);
                let newer = dispatch_figures["seen"]
                    .as_str()
                    .is_some_and(|seen| seen > checked.seen.as_str());
                if newer && !from_dispatch.is_empty() {
                    entry["windows"] = json!(from_dispatch);
                    entry["seen"] = dispatch_figures["seen"].clone();
                    entry["source"] = json!("dispatch");
                } else {
                    entry["windows"] = json!(with_short(&checked.fetched.windows));
                    entry["seen"] = json!(checked.seen);
                    entry["source"] = json!(checked.fetched.source);
                }
            }
            Some(Err(e)) if !from_dispatch.is_empty() => {
                entry["windows"] = json!(from_dispatch);
                entry["seen"] = dispatch_figures["seen"].clone();
                entry["source"] = json!("dispatch");
                entry["note"] = json!("From Dispatch's last reply on Codex");
                entry["error"] = json!(sentence(e));
            }
            Some(Err(e)) => {
                entry["status"] = json!("error");
                entry["message"] = json!(sentence(e));
            }
            None if !from_dispatch.is_empty() => {
                entry["windows"] = json!(from_dispatch);
                entry["seen"] = dispatch_figures["seen"].clone();
                entry["source"] = json!("dispatch");
                entry["note"] = json!("From Dispatch's last reply on Codex");
            }
            None if signed_in => {
                entry["status"] = json!("waiting");
                entry["message"] = json!("Not checked yet");
            }
            None if self.cfg.codex_cli => {
                entry["status"] = json!("signed_out");
                entry["message"] = json!("Not signed in");
            }
            None => return None,
        }
        Some(entry)
    }

    fn gemini(&self, live: &Live) -> Option<Value> {
        let mut entry = provider("gemini", "Gemini", None);
        match &live.gemini {
            Some(Ok(checked)) => {
                entry["plan"] = json!(checked.fetched.plan.as_deref().map(plan_label));
                entry["windows"] = json!(with_short(&checked.fetched.windows));
                entry["seen"] = json!(checked.seen);
                entry["source"] = json!(checked.fetched.source);
            }
            Some(Err(e)) => {
                entry["status"] = json!("error");
                entry["message"] = json!(sentence(e));
            }
            None if self.cfg.gemini_cli => {
                entry["status"] = json!("signed_out");
                entry["message"] = json!("Not signed in");
            }
            None => return None,
        }
        Some(entry)
    }
}

fn provider(id: &str, name: &str, plan: Option<&str>) -> Value {
    json!({
        "id": id,
        "name": name,
        "plan": plan,
        "windows": [],
        "seen": null,
        "source": null,
        "status": "ok",
        "message": null,
        "note": null,
        "error": null,
        "credits": null,
    })
}

fn windows_of(figures: &Value) -> Vec<Value> {
    with_short(
        figures["windows"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    )
}

fn with_short(windows: &[Value]) -> Vec<Value> {
    windows
        .iter()
        .map(|w| {
            let mut w = w.clone();
            if w["short"].is_null() {
                w["short"] = json!(short_of(&w));
            }
            w
        })
        .collect()
}

fn short_of(window: &Value) -> String {
    if let Some(model) = window["model"].as_str() {
        return format!("{model} wk");
    }
    let name = window["name"].as_str().unwrap_or("");
    let label = window["label"].as_str().unwrap_or("");
    match (name, label) {
        ("five_hour" | "session", _) | (_, "5-hour limit") => "5h".into(),
        ("seven_day" | "weekly", _) | (_, "Weekly limit") => "wk".into(),
        _ => label.trim_end_matches(" limit").to_string(),
    }
}

// "team" reads "Team" and "chatgpt_plus" reads "ChatGPT Plus".
pub fn plan_label(plan: &str) -> String {
    plan.split([' ', '_', '-'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let lower = w.to_lowercase();
            if lower == "chatgpt" {
                return "ChatGPT".to_string();
            }
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn sentence(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn config(dir: &Path) -> Config {
        Config {
            claude: ClaudeAccount {
                url: "http://127.0.0.1:1/usage".into(),
                dir: Some(dir.join("claude")),
                keychain: false,
            },
            claude_cli: false,
            codex_home: Some(dir.join("codex")),
            codex_cli: false,
            codex_command: None,
            codex_url: "http://127.0.0.1:1/usage".into(),
            gemini_dir: Some(dir.join("gemini")),
            gemini_cli: false,
            gemini_url: "http://127.0.0.1:1".into(),
            stats_cache: dir.join("usage-stats.json"),
        }
    }

    fn dispatch(dir: &Path) -> Dispatch {
        Dispatch::new(
            Arc::new(crate::testing::FakeRunner::default()),
            dir.join("dispatch"),
        )
    }

    fn ids(list: &[Value]) -> Vec<&str> {
        list.iter().map(|p| p["id"].as_str().unwrap()).collect()
    }

    #[test]
    fn agents_this_machine_does_not_have_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::new(config(dir.path()));
        assert!(usage.providers(&dispatch(dir.path())).is_empty());

        let usage = Usage::new(Config {
            codex_cli: true,
            gemini_cli: true,
            ..config(dir.path())
        });
        let list = usage.providers(&dispatch(dir.path()));
        assert_eq!(ids(&list), ["codex", "gemini"]);
        assert_eq!(list[0]["status"], "signed_out");
        assert_eq!(list[1]["message"], "Not signed in");

        std::fs::create_dir_all(dir.path().join("claude")).unwrap();
        std::fs::write(dir.path().join("claude/.credentials.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.path().join("codex")).unwrap();
        std::fs::write(dir.path().join("codex/auth.json"), "{}").unwrap();
        let usage = Usage::new(config(dir.path()));
        let list = usage.providers(&dispatch(dir.path()));
        assert_eq!(ids(&list), ["claude", "codex"]);
        assert_eq!(list[0]["status"], "waiting");
        assert_eq!(list[1]["status"], "waiting");
    }

    #[tokio::test]
    async fn every_agent_is_checked_and_a_failure_is_explained() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("codex")).unwrap();
        std::fs::write(
            dir.path().join("codex/auth.json"),
            r#"{"tokens": {"access_token": "fixture"}}"#,
        )
        .unwrap();
        let fake = crate::testing::FakeHttp::json(json!({
            "plan_type": "team",
            "rate_limit": {
                "primary_window": {"used_percent": 4, "limit_window_seconds": 18000, "reset_at": 4102444800u64},
                "secondary_window": {"used_percent": 1, "limit_window_seconds": 604800, "reset_at": 4102444800u64}
            }
        }))
        .await;
        let usage = Usage::new(Config {
            codex_url: format!("{}/backend-api/wham/usage", fake.url),
            claude_cli: true,
            ..config(dir.path())
        });
        let dispatch = dispatch(dir.path());
        usage.refresh(&dispatch).await;
        let list = usage.providers(&dispatch);
        assert_eq!(ids(&list), ["claude", "codex"]);
        assert_eq!(list[0]["status"], "signed_out");
        let codex = &list[1];
        assert_eq!(codex["plan"], "Team");
        assert_eq!(codex["status"], "ok");
        assert_eq!(codex["source"], "account");
        assert_eq!(codex["windows"][0]["short"], "5h");
        assert_eq!(codex["windows"][1]["short"], "wk");
        assert_eq!(fake.asked().len(), 1);

        usage.refresh_now(&dispatch).await;
        assert_eq!(fake.asked().len(), 1, "a check right after one reuses it");
        usage.refresh(&dispatch).await;
        assert_eq!(fake.asked().len(), 2);

        let broken = Usage::new(config(dir.path()));
        broken.refresh(&dispatch).await;
        let codex = &broken.providers(&dispatch)[0];
        assert_eq!(codex["status"], "error");
        assert!(codex["message"]
            .as_str()
            .unwrap()
            .starts_with("Cannot reach ChatGPT"));
    }

    #[test]
    fn dispatch_figures_stand_in_when_codex_cannot_be_checked() {
        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::new(config(dir.path()));
        let figures = json!({
            "windows": [{"name": "primary", "label": "5-hour limit", "used": 0.42, "resets_at": 4102444800u64, "status": "allowed"}],
            "seen": "2026-10-29T00:00:00+00:00",
            "source": "codex",
        });
        let live = Live {
            codex: Some(Err("ChatGPT answered 401 Unauthorized".into())),
            ..Live::default()
        };
        let codex = usage.codex(&live, &figures).unwrap();
        assert_eq!(codex["status"], "ok");
        assert_eq!(codex["source"], "dispatch");
        assert_eq!(codex["windows"][0]["used"], 0.42);
        assert_eq!(codex["windows"][0]["short"], "5h");
        assert_eq!(codex["error"], "ChatGPT answered 401 Unauthorized");
        let none = usage.codex(&Live::default(), &figures).unwrap();
        assert_eq!(none["note"], "From Dispatch's last reply on Codex");
        assert!(usage.codex(&Live::default(), &Value::Null).is_none());
    }

    #[test]
    fn plans_and_short_labels_read_well() {
        assert_eq!(plan_label("team"), "Team");
        assert_eq!(plan_label("chatgpt_plus"), "ChatGPT Plus");
        assert_eq!(short_of(&json!({"name": "five_hour"})), "5h");
        assert_eq!(short_of(&json!({"name": "seven_day"})), "wk");
        assert_eq!(
            short_of(&json!({"name": "seven_day_fable", "model": "Fable"})),
            "Fable wk"
        );
        assert_eq!(short_of(&json!({"label": "3-day limit"})), "3-day");
    }

    #[test]
    fn a_missing_session_window_leaves_the_others() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("claude")).unwrap();
        std::fs::write(dir.path().join("claude/.credentials.json"), "{}").unwrap();
        let usage = Usage::new(config(dir.path()));
        let figures = json!({
            "windows": [
                {"name": "seven_day", "label": "Weekly limit", "used": 0.16, "resets_at": 4102444800u64, "status": "allowed"},
                {"name": "seven_day_fable", "label": "Weekly Fable", "model": "Fable", "used": 0.3, "resets_at": 4102444800u64, "status": "allowed"},
            ],
            "plan": "Max 20x",
            "seen": "2026-11-12T00:00:00+00:00",
            "source": "account",
        });
        let claude = usage.claude(&Live::default(), &figures).unwrap();
        assert_eq!(claude["status"], "ok");
        assert_eq!(claude["plan"], "Max 20x");
        let shorts: Vec<&str> = claude["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["short"].as_str().unwrap())
            .collect();
        assert_eq!(shorts, ["wk", "Fable wk"]);
    }

    #[test]
    fn agent_clis_are_found_in_the_installers_folders() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("codex"), "#!/bin/sh\n").unwrap();
        std::fs::write(bin.join("gemini"), "not runnable").unwrap();
        std::fs::set_permissions(
            bin.join("codex"),
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let dirs = cli_dirs(Some("/nonexistent".into()), Some(dir.path()));
        assert_eq!(find_cli(&dirs, "codex"), Some(bin.join("codex")));
        assert_eq!(find_cli(&dirs, "gemini"), None);
    }
}
