use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::Fetched;

pub const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const SESSION_MINUTES: u64 = 300;
const WEEKLY_MINUTES: u64 = 10080;
// Older Codex builds report window lengths one minute off.
const TOLERANCE_MINUTES: u64 = 1;
const BACKEND_TIMEOUT: Duration = Duration::from_secs(10);
const RPC_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub used_percent: f64,
    pub minutes: Option<u64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Classified {
    pub session: Option<Snapshot>,
    pub weekly: Option<Snapshot>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Session,
    Weekly,
}

fn kind_of(snapshot: &Snapshot) -> Option<Kind> {
    let minutes = snapshot.minutes?;
    if minutes.abs_diff(SESSION_MINUTES) <= TOLERANCE_MINUTES {
        Some(Kind::Session)
    } else if minutes.abs_diff(WEEKLY_MINUTES) <= TOLERANCE_MINUTES {
        Some(Kind::Weekly)
    } else {
        None
    }
}

// Codex calls its windows primary and secondary; which one is the 5-hour window follows from its
// length, and a length it does not give keeps primary as the session and secondary as the week.
pub fn classify(primary: Option<Snapshot>, secondary: Option<Snapshot>) -> Classified {
    let mut out = Classified::default();
    for window in [&primary, &secondary].into_iter().flatten() {
        match kind_of(window) {
            Some(Kind::Session) if out.session.is_none() => out.session = Some(window.clone()),
            Some(Kind::Weekly) if out.weekly.is_none() => out.weekly = Some(window.clone()),
            _ => {}
        }
    }
    if out.session.is_none() {
        out.session = primary.filter(|w| kind_of(w).is_none());
    }
    if out.weekly.is_none() {
        out.weekly = secondary.filter(|w| kind_of(w).is_none());
    }
    out
}

fn window(name: &str, label: &str, short: &str, snapshot: &Snapshot, reached: bool) -> Value {
    let used = (snapshot.used_percent / 100.0).clamp(0.0, 1.0);
    json!({
        "name": name,
        "label": label,
        "short": short,
        "used": used,
        "resets_at": snapshot.resets_at.filter(|at| *at > 0),
        "status": if reached && used >= 1.0 { "rejected" } else { "allowed" },
    })
}

fn windows_of(classified: &Classified, reached: bool, prefix: Option<&str>) -> Vec<Value> {
    let named = |base: &str, label: &str, short: &str| match prefix {
        Some(model) => (
            format!("{base}_{}", model.to_lowercase().replace(' ', "_")),
            format!("{model} {}", label.to_lowercase()),
            format!("{model} {short}"),
        ),
        None => (base.to_string(), label.to_string(), short.to_string()),
    };
    let mut out = Vec::new();
    if let Some(s) = &classified.session {
        let (name, label, short) = named("session", "5-hour limit", "5h");
        out.push(window(&name, &label, &short, s, reached));
    }
    if let Some(w) = &classified.weekly {
        let (name, label, short) = named("weekly", "Weekly limit", "wk");
        out.push(window(&name, &label, &short, w, reached));
    }
    out
}

fn backend_snapshot(raw: &Value) -> Option<Snapshot> {
    let used_percent = raw["used_percent"].as_f64()?;
    let minutes = raw["limit_window_seconds"]
        .as_u64()
        .filter(|s| *s > 0)
        .map(|s| s.div_ceil(60));
    Some(Snapshot {
        used_percent,
        minutes,
        resets_at: raw["reset_at"].as_i64(),
    })
}

// The answer of ChatGPT's usage endpoint, the one the Codex app reads. Without a plan the answer is
// not one this code understands, so it is refused rather than shown as zero use.
pub fn parse_backend(body: &Value) -> Option<Fetched> {
    let plan = body["plan_type"].as_str()?;
    let limits = &body["rate_limit"];
    let reached = !body["rate_limit_reached_type"].is_null() || limits["limit_reached"] == true;
    let classified = classify(
        backend_snapshot(&limits["primary_window"]),
        backend_snapshot(&limits["secondary_window"]),
    );
    let mut windows = windows_of(&classified, reached, None);
    for extra in body["additional_rate_limits"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let Some(name) = extra["limit_name"]
            .as_str()
            .or(extra["metered_feature"].as_str())
        else {
            continue;
        };
        let limits = &extra["rate_limit"];
        let classified = classify(
            backend_snapshot(&limits["primary_window"]),
            backend_snapshot(&limits["secondary_window"]),
        );
        windows.extend(windows_of(&classified, reached, Some(name)));
    }
    Some(Fetched {
        plan: Some(plan.to_string()),
        windows,
        source: "account",
        credits: credits_of(&body["credits"], "has_credits", "unlimited", "balance"),
    })
}

// Pay-as-you-go credits beside the plan, as Codex reports them: a balance, or unlimited.
fn credits_of(raw: &Value, has: &str, unlimited: &str, balance: &str) -> Option<String> {
    if raw[unlimited] == true {
        return Some("Unlimited credits".into());
    }
    let amount = match &raw[balance] {
        Value::String(text) => text.parse::<f64>().ok(),
        other => other.as_f64(),
    };
    match amount {
        Some(amount) if raw[has] == true || amount > 0.0 => {
            Some(format!("{} credits left", (amount * 100.0).round() / 100.0))
        }
        _ => None,
    }
}

fn rpc_snapshot(raw: &Value) -> Option<Snapshot> {
    Some(Snapshot {
        used_percent: raw["usedPercent"].as_f64()?,
        minutes: raw["windowDurationMins"].as_u64(),
        resets_at: raw["resetsAt"].as_i64(),
    })
}

// The answer to `account/rateLimits/read` from `codex app-server`.
pub fn parse_rpc(result: &Value) -> Option<Fetched> {
    let limits = &result["rateLimits"];
    if !limits.is_object() {
        return None;
    }
    let reached = !limits["rateLimitReachedType"].is_null();
    let classified = classify(
        rpc_snapshot(&limits["primary"]),
        rpc_snapshot(&limits["secondary"]),
    );
    let mut windows = windows_of(&classified, reached, None);
    if let Some(by_id) = result["rateLimitsByLimitId"].as_object() {
        for (id, extra) in by_id {
            if id == "codex" || extra == limits {
                continue;
            }
            let name = extra["limitName"]
                .as_str()
                .or(extra["normalModelSlug"].as_str())
                .unwrap_or(id);
            let classified = classify(
                rpc_snapshot(&extra["primary"]),
                rpc_snapshot(&extra["secondary"]),
            );
            let reached = !extra["rateLimitReachedType"].is_null();
            windows.extend(windows_of(&classified, reached, Some(name)));
        }
    }
    if windows.is_empty() {
        return None;
    }
    Some(Fetched {
        plan: limits["planType"].as_str().map(str::to_string),
        windows,
        source: "app-server",
        credits: credits_of(&limits["credits"], "hasCredits", "unlimited", "balance"),
    })
}

pub fn auth_file(home: &Path) -> PathBuf {
    home.join("auth.json")
}

// The access token is only read: when it has expired, the app-server fallback lets Codex renew its
// own sign-in, so Yardbell never writes Codex's auth file.
fn headers_from(auth: &str) -> Result<Vec<(&'static str, String)>, String> {
    let auth: Value =
        serde_json::from_str(auth).map_err(|_| "Codex's sign-in file is not readable")?;
    let tokens = &auth["tokens"];
    let token = tokens["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("Codex signs in with an API key here, which has no plan limits")?;
    let mut headers = vec![
        ("Authorization", format!("Bearer {token}")),
        ("User-Agent", "codex-cli".to_string()),
        ("OpenAI-Beta", "codex-1".to_string()),
        ("originator", "Codex Desktop".to_string()),
    ];
    if let Some(account) = tokens["account_id"].as_str() {
        headers.push(("ChatGPT-Account-Id", account.to_string()));
    }
    Ok(headers)
}

pub async fn from_backend(
    http: &reqwest::Client,
    url: &str,
    home: &Path,
) -> Result<Fetched, String> {
    let auth = tokio::fs::read_to_string(auth_file(home))
        .await
        .map_err(|_| "Codex is not signed in on this machine")?;
    let mut req = http.get(url).timeout(BACKEND_TIMEOUT);
    for (name, value) in headers_from(&auth)? {
        req = req.header(name, value);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("cannot reach ChatGPT: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("ChatGPT answered {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    parse_backend(&body).ok_or_else(|| "no plan limits in ChatGPT's answer".to_string())
}

const APP_SERVER_ARGS: [&str; 9] = [
    "-c",
    "approval_policy=never",
    "-c",
    "features.plugins=false",
    "-s",
    "read-only",
    "-a",
    "never",
    "app-server",
];

fn rpc_line(id: u64, method: &str, params: Value) -> String {
    format!(
        "{}\n",
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    )
}

// Starts `codex app-server` read-only, asks it for the account's limits and stops it. Codex renews
// its own sign-in on the way when it has expired.
pub async fn from_app_server(codex: &Path, home: &Path) -> Result<Fetched, String> {
    let mut child = tokio::process::Command::new(codex)
        .args(APP_SERVER_ARGS)
        .env("CODEX_HOME", home)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start Codex: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let said = tokio::spawn(async move {
        let mut text = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut text).await;
        text
    });
    let talk = async {
        stdin
            .write_all(
                rpc_line(
                    1,
                    "initialize",
                    json!({"clientInfo": {"name": "yardbell", "version": env!("CARGO_PKG_VERSION")}}),
                )
                .as_bytes(),
            )
            .await
            .map_err(|_| String::new())?;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await.map_err(|_| String::new())? {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message["id"] == 1 {
                let initialized = format!(
                    "{}\n",
                    json!({"jsonrpc": "2.0", "method": "initialized", "params": {}})
                );
                let ask = rpc_line(2, "account/rateLimits/read", json!({}));
                stdin
                    .write_all(format!("{initialized}{ask}").as_bytes())
                    .await
                    .map_err(|_| String::new())?;
            } else if message["id"] == 2 {
                if let Some(error) = message["error"]["message"].as_str() {
                    return Err(format!("Codex answered: {error}"));
                }
                return parse_rpc(&message["result"])
                    .ok_or_else(|| "no plan limits in Codex's answer".to_string());
            }
        }
        Err(String::new())
    };
    let answer = tokio::time::timeout(RPC_TIMEOUT, talk).await;
    let _ = child.kill().await;
    match answer {
        Ok(Ok(fetched)) => Ok(fetched),
        Ok(Err(e)) if !e.is_empty() => Err(e),
        Ok(Err(_)) => Err(exited(&said.await.unwrap_or_default())),
        Err(_) => Err("Codex did not answer within 20 seconds".into()),
    }
}

// What Codex printed is not passed on, since it can carry paths and account details.
fn exited(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if ["refresh token", "sign in again", "log in again", "401"]
        .iter()
        .any(|hint| lower.contains(hint))
    {
        "Codex's ChatGPT sign-in could not be renewed. Sign in to Codex again.".into()
    } else {
        "Codex stopped before it gave its limits".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(used: f64, minutes: Option<u64>) -> Option<Snapshot> {
        Some(Snapshot {
            used_percent: used,
            minutes,
            resets_at: Some(1_800_000_000),
        })
    }

    #[test]
    fn windows_are_classified_by_their_length() {
        let swapped = classify(snap(1.0, Some(10080)), snap(4.0, Some(300)));
        assert_eq!(swapped.session.unwrap().used_percent, 4.0);
        assert_eq!(swapped.weekly.unwrap().used_percent, 1.0);

        let drifted = classify(snap(2.0, Some(299)), snap(3.0, Some(10081)));
        assert_eq!(drifted.session.unwrap().used_percent, 2.0);
        assert_eq!(drifted.weekly.unwrap().used_percent, 3.0);

        let unknown = classify(snap(5.0, None), snap(6.0, Some(1440)));
        assert_eq!(unknown.session.unwrap().used_percent, 5.0);
        assert_eq!(unknown.weekly.unwrap().used_percent, 6.0);

        let only_weekly = classify(snap(7.0, Some(10080)), None);
        assert_eq!(only_weekly.session, None);
        assert_eq!(only_weekly.weekly.unwrap().used_percent, 7.0);

        assert_eq!(classify(None, None), Classified::default());
    }

    #[test]
    fn the_backend_answer_gives_the_plan_and_both_windows() {
        let body = json!({
            "plan_type": "team",
            "rate_limit": {
                "allowed": true, "limit_reached": false,
                "primary_window": {"used_percent": 4, "limit_window_seconds": 18000, "reset_at": 1794449135},
                "secondary_window": {"used_percent": 1, "limit_window_seconds": 604800, "reset_at": 1795035935}
            },
            "additional_rate_limits": [{"limit_name": "GPT-6 Astra", "rate_limit": {
                "primary_window": {"used_percent": 50, "limit_window_seconds": 604800, "reset_at": 1795035935}
            }}],
            "credits": {"has_credits": true, "unlimited": false, "balance": "12.5"},
            "rate_limit_reached_type": null
        });
        let got = parse_backend(&body).unwrap();
        assert_eq!(got.plan.as_deref(), Some("team"));
        assert_eq!(got.source, "account");
        assert_eq!(got.windows.len(), 3);
        assert_eq!(got.windows[0]["label"], "5-hour limit");
        assert_eq!(got.windows[0]["short"], "5h");
        assert_eq!(got.windows[0]["used"], 0.04);
        assert_eq!(got.windows[0]["resets_at"], 1794449135);
        assert_eq!(got.windows[1]["label"], "Weekly limit");
        assert_eq!(got.windows[2]["label"], "GPT-6 Astra weekly limit");
        assert_eq!(got.windows[2]["short"], "GPT-6 Astra wk");
        assert_eq!(got.credits.as_deref(), Some("12.5 credits left"));
        let none = json!({"has_credits": false, "unlimited": false, "balance": null});
        assert_eq!(
            credits_of(&none, "has_credits", "unlimited", "balance"),
            None
        );
        let all = json!({"unlimited": true});
        assert_eq!(
            credits_of(&all, "hasCredits", "unlimited", "balance").as_deref(),
            Some("Unlimited credits")
        );
        assert!(parse_backend(&json!({"rate_limit": {}})).is_none());
    }

    #[test]
    fn the_app_server_answer_gives_the_plan_and_a_reached_limit() {
        let result = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": 1794449135},
                "secondary": {"usedPercent": 30, "windowDurationMins": 10080, "resetsAt": 1795035935},
                "planType": "plus",
                "rateLimitReachedType": "primary"
            },
            "rateLimitsByLimitId": {
                "codex": {"primary": {"usedPercent": 100, "windowDurationMins": 300}},
                "astra": {"limitName": "Astra", "secondary": {"usedPercent": 12, "windowDurationMins": 10080}, "rateLimitReachedType": null}
            }
        });
        let got = parse_rpc(&result).unwrap();
        assert_eq!(got.plan.as_deref(), Some("plus"));
        assert_eq!(got.source, "app-server");
        assert_eq!(got.windows[0]["status"], "rejected");
        assert_eq!(got.windows[1]["status"], "allowed");
        assert_eq!(got.windows[2]["label"], "Astra weekly limit");
        assert!(parse_rpc(&json!({})).is_none());
    }

    #[test]
    fn the_token_is_sent_with_the_account() {
        let auth = r#"{"auth_mode": "chatgpt", "tokens": {"access_token": "fixture", "account_id": "acct-1"}}"#;
        let headers = headers_from(auth).unwrap();
        assert!(headers.contains(&("Authorization", "Bearer fixture".to_string())));
        assert!(headers.contains(&("ChatGPT-Account-Id", "acct-1".to_string())));
        assert!(headers_from(r#"{"OPENAI_API_KEY": "sk-x", "tokens": null}"#).is_err());
        assert!(headers_from("{").is_err());
    }

    #[tokio::test]
    async fn limits_are_fetched_from_the_configured_endpoint() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            auth_file(home.path()),
            r#"{"tokens": {"access_token": "fixture", "account_id": "acct-1"}}"#,
        )
        .unwrap();
        let fake = crate::testing::FakeHttp::replies(vec![
            (
                200,
                json!({"plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 9, "limit_window_seconds": 18000, "reset_at": 1794449135}}}),
            ),
            (401, json!({"detail": "expired"})),
        ])
        .await;
        let url = format!("{}/backend-api/wham/usage", fake.url);
        let http = reqwest::Client::new();
        let got = from_backend(&http, &url, home.path()).await.unwrap();
        assert_eq!(got.windows[0]["used"], 0.09);
        let asked = &fake.asked()[0];
        assert_eq!(asked.path, "/backend-api/wham/usage");
        assert_eq!(
            asked.header("authorization").as_deref(),
            Some("Bearer fixture")
        );
        assert_eq!(
            asked.header("chatgpt-account-id").as_deref(),
            Some("acct-1")
        );
        assert_eq!(
            from_backend(&http, &url, home.path()).await.unwrap_err(),
            "ChatGPT answered 401 Unauthorized"
        );
        assert_eq!(
            from_backend(&http, &url, &home.path().join("nowhere"))
                .await
                .unwrap_err(),
            "Codex is not signed in on this machine"
        );
    }

    #[tokio::test]
    async fn the_app_server_is_asked_when_given_a_codex() {
        let dir = tempfile::tempdir().unwrap();
        let codex = dir.path().join("codex");
        std::fs::write(
            &codex,
            "#!/bin/sh\n\
             echo \"$CODEX_HOME $*\" > \"$(dirname \"$0\")/args\"\n\
             read -r init\n\
             echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'\n\
             read -r initialized\n\
             read -r ask\n\
             case \"$ask\" in *account/rateLimits/read*) ;; *) exit 3;; esac\n\
             echo '{\"jsonrpc\":\"2.0\",\"method\":\"remoteControl/status/changed\",\"params\":{}}'\n\
             echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":4,\"windowDurationMins\":300,\"resetsAt\":1794449135},\"planType\":\"team\"}}}'\n\
             sleep 5\n",
        )
        .unwrap();
        std::fs::set_permissions(&codex, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let home = dir.path().join("codex-home");
        let got = from_app_server(&codex, &home).await.unwrap();
        assert_eq!(got.plan.as_deref(), Some("team"));
        assert_eq!(got.windows[0]["used"], 0.04);
        let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
        assert!(args.starts_with(&home.display().to_string()), "{args}");
        assert!(args.contains("-s read-only -a never app-server"), "{args}");

        let refused = dir.path().join("codex-refused");
        std::fs::write(
            &refused,
            "#!/bin/sh\necho 'error: refresh token expired, sign in again' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &refused,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        assert_eq!(
            from_app_server(&refused, &home).await.unwrap_err(),
            "Codex's ChatGPT sign-in could not be renewed. Sign in to Codex again."
        );
        assert!(from_app_server(&dir.path().join("missing"), &home)
            .await
            .unwrap_err()
            .starts_with("cannot start Codex"));
    }
}
