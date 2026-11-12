use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::Fetched;

pub const BASE_URL: &str = "https://cloudcode-pa.googleapis.com";
const TIMEOUT: Duration = Duration::from_secs(10);

pub fn creds_file(dir: &Path) -> PathBuf {
    dir.join("oauth_creds.json")
}

// Only read, never refreshed, the way the Claude sign-in is: Gemini CLI renews it when it runs.
fn token_from(creds: &str, now_ms: i64) -> Result<String, String> {
    let creds: Value =
        serde_json::from_str(creds).map_err(|_| "Gemini's sign-in file is not readable")?;
    let token = creds["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("Gemini CLI is not signed in with Google here")?;
    if creds["expiry_date"].as_i64().unwrap_or(i64::MAX) <= now_ms {
        return Err(
            "the Gemini CLI sign-in has expired; it renews the next time Gemini CLI runs".into(),
        );
    }
    Ok(token.to_string())
}

fn model_label(model: &str) -> String {
    model
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// Gemini reports a remaining fraction per model; models that share a quota repeat the same figure,
// so one of them stands for the rest.
pub fn parse_quota(body: &Value, plan: Option<String>) -> Option<Fetched> {
    let buckets = body["buckets"].as_array().or(body.as_array())?;
    let mut windows: Vec<Value> = Vec::new();
    for bucket in buckets {
        let (Some(remaining), Some(model)) = (
            bucket["remainingFraction"].as_f64(),
            bucket["modelId"].as_str(),
        ) else {
            continue;
        };
        let used = (1.0 - remaining).clamp(0.0, 1.0);
        let resets_at = bucket["resetTime"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp());
        let label = model_label(model);
        let same = windows
            .iter()
            .position(|w| w["used"] == json!(used) && w["resets_at"] == json!(resets_at));
        if let Some(at) = same {
            if label.len() < windows[at]["label"].as_str().unwrap_or("").len() {
                windows[at]["label"] = json!(label);
                windows[at]["short"] = json!(label.trim_start_matches("Gemini ").to_string());
            }
            continue;
        }
        windows.push(json!({
            "name": model,
            "label": label,
            "short": label.trim_start_matches("Gemini ").to_string(),
            "used": used,
            "resets_at": resets_at,
            "status": if used >= 1.0 { "rejected" } else { "allowed" },
        }));
    }
    if windows.is_empty() {
        return None;
    }
    Some(Fetched {
        plan,
        windows,
        source: "account",
        credits: None,
    })
}

pub async fn fetch(http: &reqwest::Client, base: &str, dir: &Path) -> Result<Fetched, String> {
    let creds = tokio::fs::read_to_string(creds_file(dir))
        .await
        .map_err(|_| "Gemini CLI is not signed in on this machine")?;
    let token = token_from(&creds, chrono::Utc::now().timestamp_millis())?;
    let post = |path: &str, body: Value| {
        http.post(format!("{base}/v1internal:{path}"))
            .bearer_auth(&token)
            .json(&body)
            .timeout(TIMEOUT)
            .send()
    };
    let res = post(
        "loadCodeAssist",
        json!({"metadata": {"ideType": "GEMINI_CLI", "pluginType": "GEMINI"}}),
    )
    .await
    .map_err(|e| format!("cannot reach Google: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Google answered {}", res.status()));
    }
    let assist: Value = res.json().await.map_err(|e| e.to_string())?;
    let project = assist["cloudaicompanionProject"]
        .as_str()
        .ok_or("Google gave no Gemini project for this sign-in")?;
    let plan = assist["currentTier"]["name"].as_str().map(str::to_string);
    let res = post("retrieveUserQuota", json!({"project": project}))
        .await
        .map_err(|e| format!("cannot reach Google: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Google answered {}", res.status()));
    }
    let quota: Value = res.json().await.map_err(|e| e.to_string())?;
    parse_quota(&quota, plan).ok_or_else(|| "no quota in Google's answer".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_quotas_are_shown_once() {
        let body = json!({"buckets": [
            {"remainingFraction": 0.75, "resetTime": "2026-11-12T10:00:00Z", "modelId": "gemini-2.5-pro"},
            {"remainingFraction": 0.75, "resetTime": "2026-11-12T10:00:00Z", "modelId": "gemini-2.5-pro-preview"},
            {"remainingFraction": 1.0, "resetTime": "2026-11-12T10:00:00Z", "modelId": "gemini-2.5-flash"},
            {"modelId": "broken"}
        ]});
        let got = parse_quota(&body, Some("Free".into())).unwrap();
        assert_eq!(got.windows.len(), 2);
        assert_eq!(got.windows[0]["label"], "Gemini 2.5 Pro");
        assert_eq!(got.windows[0]["short"], "2.5 Pro");
        assert_eq!(got.windows[0]["used"], 0.25);
        assert_eq!(got.windows[1]["used"], 0.0);
        assert_eq!(got.plan.as_deref(), Some("Free"));
        assert!(parse_quota(&json!({"buckets": []}), None).is_none());
    }

    #[test]
    fn an_expired_sign_in_is_not_used() {
        let creds = r#"{"access_token": "tok", "expiry_date": 2000}"#;
        assert_eq!(token_from(creds, 1000).unwrap(), "tok");
        assert!(token_from(creds, 2000).unwrap_err().contains("expired"));
        assert!(token_from("{}", 0).is_err());
    }

    #[tokio::test]
    async fn quota_is_fetched_from_the_configured_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            creds_file(dir.path()),
            r#"{"access_token": "fixture", "expiry_date": 99999999999999}"#,
        )
        .unwrap();
        let fake = crate::testing::FakeHttp::replies(vec![
            (
                200,
                json!({"cloudaicompanionProject": "proj-1", "currentTier": {"name": "Gemini Code Assist"}}),
            ),
            (
                200,
                json!({"buckets": [{"remainingFraction": 0.5, "resetTime": "2026-11-12T10:00:00Z", "modelId": "gemini-2.5-pro"}]}),
            ),
        ])
        .await;
        let got = fetch(&reqwest::Client::new(), &fake.url, dir.path())
            .await
            .unwrap();
        assert_eq!(got.windows[0]["used"], 0.5);
        assert_eq!(got.plan.as_deref(), Some("Gemini Code Assist"));
        let asked = fake.asked();
        assert_eq!(asked[0].path, "/v1internal:loadCodeAssist");
        assert_eq!(asked[1].path, "/v1internal:retrieveUserQuota");
        assert!(asked[1].body.contains("proj-1"));
        assert_eq!(
            asked[1].header("authorization").as_deref(),
            Some("Bearer fixture")
        );
    }
}
