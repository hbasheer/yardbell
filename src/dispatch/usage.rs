use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use super::Dispatch;
use crate::config::RunsOn;

const WINDOWS: [(&str, &str); 2] = [("five_hour", "5-hour limit"), ("seven_day", "Weekly limit")];

// Claude Code reports the account's plan limits in a rate_limit_event while it runs, so every
// Dispatch turn refreshes them for free.
pub fn from_stream(message: &Value) -> Option<Value> {
    if message["type"] != "rate_limit_event" {
        return None;
    }
    let windows = &message["rate_limit_info"]["unifiedWindows"];
    let found: Vec<Value> = WINDOWS
        .iter()
        .filter_map(|(key, label)| {
            let w = &windows[*key];
            let used = w["utilization"].as_f64()?;
            Some(json!({
                "name": key,
                "label": label,
                "used": used.clamp(0.0, 1.0),
                "resets_at": w["resetsAt"].as_i64(),
                "status": w["status"].as_str().unwrap_or("allowed"),
            }))
        })
        .collect();
    if found.is_empty() {
        return None;
    }
    Some(json!({
        "windows": found,
        "seen": chrono::Local::now().to_rfc3339(),
        "source": "dispatch",
    }))
}

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

// Where the Claude account's plan limits are read from: Anthropic's endpoint, or a stand-in set by
// YARDBELL_CLAUDE_USAGE_URL, with the sign-in Claude Code keeps in its config folder.
#[derive(Debug, Clone)]
pub struct ClaudeAccount {
    pub url: String,
    pub dir: Option<PathBuf>,
    pub keychain: bool,
}

impl ClaudeAccount {
    pub fn system() -> ClaudeAccount {
        let dir = match std::env::var_os("CLAUDE_CONFIG_DIR") {
            Some(dir) => Some(PathBuf::from(dir)),
            None => std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")),
        };
        ClaudeAccount {
            url: std::env::var("YARDBELL_CLAUDE_USAGE_URL").unwrap_or_else(|_| USAGE_URL.into()),
            dir,
            keychain: cfg!(target_os = "macos"),
        }
    }

    pub fn signed_in(&self) -> bool {
        self.keychain
            || self
                .dir
                .as_ref()
                .is_some_and(|dir| dir.join(".credentials.json").is_file())
    }

    async fn credentials(&self) -> Option<String> {
        if self.keychain {
            let out = tokio::process::Command::new("security")
                .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
                .output()
                .await
                .ok()?;
            if out.status.success() {
                return String::from_utf8(out.stdout).ok();
            }
        }
        tokio::fs::read_to_string(self.dir.as_ref()?.join(".credentials.json"))
            .await
            .ok()
    }
}

// The same figures Claude Code's /usage shows, for the Claude account signed in on this machine,
// so the card also counts sessions Dispatch did not run. The endpoint is not documented.
pub async fn from_account(
    http: &reqwest::Client,
    account: &ClaudeAccount,
) -> Result<Value, String> {
    let creds = account
        .credentials()
        .await
        .ok_or("no Claude Code sign-in on this machine")?;
    let token = token_from(&creds, chrono::Utc::now().timestamp_millis())
        .ok_or("the Claude Code sign-in has expired; it renews the next time Claude Code runs")?;
    let res = http
        .get(&account.url)
        .bearer_auth(token)
        .header("anthropic-beta", OAUTH_BETA)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("cannot reach Anthropic: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Anthropic answered {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    let mut usage =
        parse_account(&body).ok_or_else(|| "no plan limits in the answer".to_string())?;
    if let Some(plan) = plan_from(&creds) {
        usage["plan"] = json!(plan);
    }
    Ok(usage)
}

const MODEL_WEEKLY: [(&str, &str); 2] =
    [("seven_day_opus", "Opus"), ("seven_day_sonnet", "Sonnet")];

fn resets_from(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp())
}

fn parse_account(body: &Value) -> Option<Value> {
    let mut found: Vec<Value> = WINDOWS
        .iter()
        .filter_map(|(key, label)| {
            let w = &body[*key];
            let used = w["utilization"].as_f64()? / 100.0;
            let status = if w["locked_reason"].is_null() {
                "allowed"
            } else {
                "rejected"
            };
            Some(json!({
                "name": key,
                "label": label,
                "used": used.clamp(0.0, 1.0),
                "resets_at": resets_from(&w["resets_at"]),
                "status": status,
            }))
        })
        .collect();
    for (key, model) in MODEL_WEEKLY {
        if let Some(used) = body[key]["utilization"].as_f64() {
            found.push(model_weekly(
                model,
                used,
                resets_from(&body[key]["resets_at"]),
            ));
        }
    }
    // Newer answers list a weekly limit per model in `limits`, named only by the model.
    for limit in body["limits"].as_array().into_iter().flatten() {
        let model = limit["scope"]["model"]["display_name"].as_str();
        let (Some(model), Some(used)) = (model, limit["percent"].as_f64()) else {
            continue;
        };
        if limit["kind"] != "weekly_scoped" || found.iter().any(|w| w["model"] == model) {
            continue;
        }
        found.push(model_weekly(model, used, resets_from(&limit["resets_at"])));
    }
    // Paid use past the plan's limits, when the account has it turned on.
    if let Some(used) = body["extra_usage"]["utilization"].as_f64() {
        found.push(json!({
            "name": "extra_usage",
            "label": "Extra usage",
            "short": "extra",
            "used": (used / 100.0).clamp(0.0, 1.0),
            "resets_at": resets_from(&body["extra_usage"]["resets_at"]),
            "status": "allowed",
        }));
    }
    if found.is_empty() {
        return None;
    }
    Some(json!({
        "windows": found,
        "seen": chrono::Local::now().to_rfc3339(),
        "source": "account",
    }))
}

fn model_weekly(model: &str, used: f64, resets_at: Option<i64>) -> Value {
    json!({
        "name": format!("seven_day_{}", model.to_lowercase()),
        "label": format!("Weekly {model}"),
        "short": format!("{model} wk"),
        "model": model,
        "used": (used / 100.0).clamp(0.0, 1.0),
        "resets_at": resets_at,
        "status": "allowed",
    })
}

// Only read, never refreshed: refreshing would replace the sign-in Claude Code itself relies on.
fn token_from(creds: &str, now_ms: i64) -> Option<String> {
    let creds: Value = serde_json::from_str(creds).ok()?;
    let oauth = &creds["claudeAiOauth"];
    let expires = oauth["expiresAt"].as_i64().unwrap_or(i64::MAX);
    if expires <= now_ms {
        return None;
    }
    oauth["accessToken"].as_str().map(str::to_string)
}

// "max" with the tier "default_claude_max_20x" reads "Max 20x".
fn plan_from(creds: &str) -> Option<String> {
    let creds: Value = serde_json::from_str(creds).ok()?;
    let oauth = &creds["claudeAiOauth"];
    let plan = oauth["subscriptionType"].as_str()?.trim();
    let first = plan.chars().next()?;
    let mut label = first.to_uppercase().collect::<String>() + &plan[first.len_utf8()..];
    let times = oauth["rateLimitTier"]
        .as_str()
        .and_then(|tier| tier.rsplit('_').next())
        .filter(|last| {
            last.strip_suffix('x')
                .is_some_and(|n| n.parse::<u32>().is_ok())
        });
    if let Some(times) = times {
        label = format!("{label} {times}");
    }
    Some(label)
}

impl Dispatch {
    pub async fn refresh_usage(
        &self,
        http: &reqwest::Client,
        account: &ClaudeAccount,
    ) -> Result<(), String> {
        self.shared.set_usage(from_account(http, account).await?);
        Ok(())
    }

    pub fn usage(&self) -> Value {
        self.shared
            .usage
            .lock()
            .expect("dispatch lock")
            .clone()
            .unwrap_or(Value::Null)
    }

    pub fn codex_usage(&self) -> Value {
        self.shared
            .codex_usage
            .lock()
            .expect("dispatch lock")
            .clone()
            .unwrap_or(Value::Null)
    }

    // The sidebar card: the Claude figures as before, which sessions still use up, with what
    // Codex last said about its own limits and which of the two Dispatch runs on.
    pub fn usage_card(&self, runs_on: RunsOn) -> Value {
        let mut card = match self.usage() {
            Value::Object(found) => Value::Object(found),
            _ => json!({}),
        };
        card["runs_on"] = json!(runs_on);
        card["codex"] = self.codex_usage();
        card
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_limits_are_read_from_the_rate_limit_event() {
        let event = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {"unifiedWindows": {
                "five_hour": {"utilization": 0.04, "resetsAt": 1792913400, "status": "allowed"},
                "seven_day": {"utilization": 0.37, "resetsAt": 1793062800, "status": "allowed"}
            }}
        });
        let usage = from_stream(&event).unwrap();
        let windows = usage["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["name"], "five_hour");
        assert_eq!(windows[0]["used"], 0.04);
        assert_eq!(windows[1]["resets_at"], 1793062800);
        assert_eq!(usage["source"], "dispatch");
        assert_eq!(from_stream(&json!({"type": "result"})), None);
        assert_eq!(
            from_stream(&json!({"type": "rate_limit_event", "rate_limit_info": {}})),
            None
        );
    }

    #[test]
    fn account_limits_are_read_as_fractions_with_unix_resets() {
        let body = json!({
            "five_hour": {"utilization": 12.0, "resets_at": "2026-10-26T17:29:59.952457+00:00", "locked_reason": null},
            "seven_day": {"utilization": 43.0, "resets_at": "2026-10-27T00:59:59.952482+00:00", "locked_reason": null},
            "seven_day_opus": null
        });
        let usage = parse_account(&body).unwrap();
        let windows = usage["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["label"], "5-hour limit");
        assert_eq!(windows[0]["used"], 0.12);
        assert_eq!(windows[0]["resets_at"], 1793035799);
        assert_eq!(windows[1]["used"], 0.43);
        assert_eq!(windows[1]["status"], "allowed");
        assert_eq!(usage["source"], "account");
    }

    #[test]
    fn a_locked_window_is_rejected_and_an_empty_answer_is_nothing() {
        let body = json!({"five_hour": {"utilization": 100.0, "resets_at": null, "locked_reason": "limit"}});
        let usage = parse_account(&body).unwrap();
        assert_eq!(usage["windows"][0]["status"], "rejected");
        assert_eq!(usage["windows"][0]["resets_at"], Value::Null);
        assert_eq!(parse_account(&json!({"five_hour": null})), None);
    }

    #[test]
    fn an_expired_or_missing_token_is_not_used() {
        let creds = r#"{"claudeAiOauth": {"accessToken": "tok", "expiresAt": 2000}}"#;
        assert_eq!(token_from(creds, 1000).as_deref(), Some("tok"));
        assert_eq!(token_from(creds, 2000), None);
        assert_eq!(token_from(r#"{"claudeAiOauth": {}}"#, 0), None);
        assert_eq!(token_from("not json", 0), None);
    }

    #[test]
    fn model_weekly_limits_and_the_plan_are_read() {
        let body = json!({
            "five_hour": null,
            "seven_day": {"utilization": 16.0, "resets_at": "2026-11-17T00:59:59.646438+00:00", "locked_reason": null},
            "seven_day_opus": {"utilization": 40.0, "resets_at": null},
            "seven_day_sonnet": null,
            "extra_usage": {"is_enabled": true, "utilization": 25.0},
            "limits": [
                {"kind": "weekly_all", "percent": 16, "resets_at": "2026-11-17T00:59:59+00:00", "scope": null},
                {"kind": "weekly_scoped", "percent": 3, "resets_at": "2026-11-17T00:59:59+00:00", "scope": {"model": {"id": null, "display_name": "Fable"}}},
                {"kind": "weekly_scoped", "percent": 9, "scope": {"model": {"display_name": "Opus"}}}
            ]
        });
        let usage = parse_account(&body).unwrap();
        let labels: Vec<&str> = usage["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["label"].as_str().unwrap())
            .collect();
        assert_eq!(
            labels,
            ["Weekly limit", "Weekly Opus", "Weekly Fable", "Extra usage"],
            "with five_hour null every other window still shows"
        );
        assert_eq!(usage["windows"][2]["short"], "Fable wk");
        assert_eq!(usage["windows"][3]["used"], 0.25);
        let off = json!({"seven_day": {"utilization": 1.0}, "extra_usage": {"is_enabled": false, "utilization": null}});
        assert_eq!(
            parse_account(&off).unwrap()["windows"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(usage["windows"][2]["used"], 0.03);
        assert_eq!(usage["windows"][2]["name"], "seven_day_fable");
        assert_eq!(usage["windows"][2]["resets_at"], 1794877199);

        let creds = r#"{"claudeAiOauth": {"subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"}}"#;
        assert_eq!(plan_from(creds).as_deref(), Some("Max 20x"));
        let pro = r#"{"claudeAiOauth": {"subscriptionType": "pro", "rateLimitTier": "default_claude_ai"}}"#;
        assert_eq!(plan_from(pro).as_deref(), Some("Pro"));
        assert_eq!(plan_from(r#"{"claudeAiOauth": {}}"#), None);
    }

    #[tokio::test]
    async fn account_limits_are_fetched_from_the_configured_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth": {"accessToken": "fixture-token", "expiresAt": 99999999999999, "subscriptionType": "pro"}}"#,
        )
        .unwrap();
        let fake = crate::testing::FakeHttp::json(json!({
            "five_hour": {"utilization": 25.0, "resets_at": null, "locked_reason": null}
        }))
        .await;
        let account = ClaudeAccount {
            url: format!("{}/api/oauth/usage", fake.url),
            dir: Some(dir.path().to_path_buf()),
            keychain: false,
        };
        assert!(account.signed_in());
        let usage = from_account(&reqwest::Client::new(), &account)
            .await
            .unwrap();
        assert_eq!(usage["windows"][0]["used"], 0.25);
        assert_eq!(usage["plan"], "Pro");
        let asked = fake.asked();
        assert_eq!(asked[0].path, "/api/oauth/usage");
        assert_eq!(
            asked[0].header("authorization").as_deref(),
            Some("Bearer fixture-token")
        );
        let nobody = ClaudeAccount {
            dir: Some(dir.path().join("nowhere")),
            ..account
        };
        assert!(!nobody.signed_in());
        assert!(from_account(&reqwest::Client::new(), &nobody)
            .await
            .is_err());
    }
}
