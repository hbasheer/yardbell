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

// The same figures Claude Code's /usage shows, for the Claude account signed in on this machine,
// so the card also counts sessions Dispatch did not run. The endpoint is not documented.
pub async fn from_account(http: &reqwest::Client) -> Result<Value, String> {
    let creds = credentials()
        .await
        .ok_or("no Claude Code sign-in on this machine")?;
    let token = token_from(&creds, chrono::Utc::now().timestamp_millis())
        .ok_or("the Claude Code sign-in has expired; it renews the next time Claude Code runs")?;
    let res = http
        .get(USAGE_URL)
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
    parse_account(&body).ok_or_else(|| "no plan limits in the answer".to_string())
}

fn parse_account(body: &Value) -> Option<Value> {
    let found: Vec<Value> = WINDOWS
        .iter()
        .filter_map(|(key, label)| {
            let w = &body[*key];
            let used = w["utilization"].as_f64()? / 100.0;
            let resets_at = w["resets_at"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.timestamp());
            let status = if w["locked_reason"].is_null() {
                "allowed"
            } else {
                "rejected"
            };
            Some(json!({
                "name": key,
                "label": label,
                "used": used.clamp(0.0, 1.0),
                "resets_at": resets_at,
                "status": status,
            }))
        })
        .collect();
    if found.is_empty() {
        return None;
    }
    Some(json!({
        "windows": found,
        "seen": chrono::Local::now().to_rfc3339(),
        "source": "account",
    }))
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

async fn credentials() -> Option<String> {
    if cfg!(target_os = "macos") {
        let out = tokio::process::Command::new("security")
            .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
            .output()
            .await
            .ok()?;
        if out.status.success() {
            return String::from_utf8(out.stdout).ok();
        }
    }
    tokio::fs::read_to_string(credentials_file()?).await.ok()
}

fn credentials_file() -> Option<PathBuf> {
    let dir = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".claude"),
    };
    Some(dir.join(".credentials.json"))
}

const USAGE_FRESH: chrono::TimeDelta = chrono::TimeDelta::seconds(30);

impl Dispatch {
    pub async fn refresh_usage(&self, http: &reqwest::Client) -> Result<(), String> {
        self.shared.set_usage(from_account(http).await?);
        Ok(())
    }

    // A click right after a check gets that check's figures instead of asking Anthropic again.
    pub async fn refresh_usage_now(&self, http: &reqwest::Client) -> Result<Value, String> {
        let current = self.usage();
        let fresh = current["source"] == "account"
            && current["seen"]
                .as_str()
                .and_then(|seen| chrono::DateTime::parse_from_rfc3339(seen).ok())
                .is_some_and(|seen| chrono::Local::now().signed_duration_since(seen) < USAGE_FRESH);
        if !fresh {
            self.refresh_usage(http).await?;
        }
        Ok(self.usage())
    }

    pub fn usage(&self) -> Value {
        self.shared
            .usage
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
        card["codex"] = self
            .shared
            .codex_usage
            .lock()
            .expect("dispatch lock")
            .clone()
            .unwrap_or(Value::Null);
        card
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::tests::fake_claude;

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

    #[tokio::test]
    async fn a_refresh_right_after_a_check_reuses_its_figures() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let checked = json!({
            "windows": [{"name": "five_hour", "label": "5-hour limit", "used": 0.12, "resets_at": null, "status": "allowed"}],
            "seen": chrono::Local::now().to_rfc3339(),
            "source": "account",
        });
        dispatch.shared.set_usage(checked.clone());
        let usage = dispatch
            .refresh_usage_now(&reqwest::Client::new())
            .await
            .unwrap();
        assert_eq!(usage, checked);
    }
}
