use serde_json::{json, Value};

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
    }))
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
        assert_eq!(from_stream(&json!({"type": "result"})), None);
        assert_eq!(
            from_stream(&json!({"type": "rate_limit_event", "rate_limit_info": {}})),
            None
        );
    }
}
