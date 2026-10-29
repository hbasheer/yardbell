use super::legacy::Ticket;
use super::legacy_prompts::TicketText;
use crate::triggers::{parse_linear, LINEAR_API, LINEAR_QUERY, LINEAR_SECRET};
use serde_json::{json, Value};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);

const TICKET: &str = "query($id: String!) { issue(id: $id) { identifier description \
state { type } comments(first: 50) { nodes { body user { name } } } } }";
const STATES: &str =
    "query($id: String!) { issue(id: $id) { identifier team { states { nodes { id name } } } } }";
const MOVE: &str = "mutation($id: String!, $state: String!) { issueUpdate(id: $id, \
input: { stateId: $state }) { success } }";

pub struct Linear {
    url: String,
    http: reqwest::Client,
}

impl Default for Linear {
    fn default() -> Self {
        Linear::new()
    }
}

impl Linear {
    // YARDBELL_LINEAR_URL points Yardbell at a stand-in for Linear, for the browser tests.
    pub fn new() -> Linear {
        match std::env::var("YARDBELL_LINEAR_URL") {
            Ok(url) if !url.trim().is_empty() => Linear::with_url(url.trim()),
            _ => Linear::with_url(LINEAR_API),
        }
    }

    pub fn with_url(url: &str) -> Linear {
        Linear {
            url: url.to_string(),
            http: reqwest::Client::new(),
        }
    }

    // Every error starts with "Linear" and never repeats the key.
    async fn call(&self, key: &str, query: &str, variables: Value) -> Result<String, String> {
        let res = self
            .http
            .post(&self.url)
            .header("Authorization", key)
            .timeout(TIMEOUT)
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| format!("Linear did not answer: {}", e.without_url()))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|_| "Linear's answer could not be read".to_string())?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(format!(
                "Linear refused the API key in the secret {LINEAR_SECRET}. Replace it under Settings, MCP servers, Secrets"
            ));
        }
        if !status.is_success() && !body.trim_start().starts_with('{') {
            return Err(format!("Linear answered {status}"));
        }
        Ok(body)
    }

    async fn data(&self, key: &str, query: &str, variables: Value) -> Result<Value, String> {
        let body = self.call(key, query, variables).await?;
        let v: Value =
            serde_json::from_str(&body).map_err(|_| "Linear's answer was not JSON".to_string())?;
        if let Some(first) = v["errors"].as_array().and_then(|e| e.first()) {
            return Err(format!(
                "Linear said: {}",
                first["message"].as_str().unwrap_or("an error")
            ));
        }
        Ok(v["data"].clone())
    }

    pub async fn open(&self, key: &str) -> Result<Vec<Ticket>, String> {
        let body = self.call(key, LINEAR_QUERY, json!({})).await?;
        Ok(parse_linear(&body)?
            .into_iter()
            .map(|t| Ticket {
                linear_id: t.id,
                id: t.ticket,
                title: t.title,
                url: t.url,
                state: t.state,
            })
            .collect())
    }

    // The ticket's text, and whether it is closed (done or canceled).
    pub async fn ticket(&self, key: &str, linear_id: &str) -> Result<(TicketText, bool), String> {
        let data = self.data(key, TICKET, json!({ "id": linear_id })).await?;
        let issue = &data["issue"];
        if issue.is_null() {
            return Err(format!("Linear has no ticket {linear_id}"));
        }
        let comments = issue["comments"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                (
                    c["user"]["name"].as_str().unwrap_or("Someone").to_string(),
                    c["body"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let closed = matches!(
            issue["state"]["type"].as_str(),
            Some("completed" | "canceled")
        );
        Ok((
            TicketText {
                description: issue["description"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                comments,
            },
            closed,
        ))
    }

    pub async fn move_to(&self, key: &str, linear_id: &str, state: &str) -> Result<(), String> {
        let data = self.data(key, STATES, json!({ "id": linear_id })).await?;
        let issue = &data["issue"];
        let name = issue["identifier"].as_str().unwrap_or(linear_id);
        let target = issue["team"]["states"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| {
                s["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(state.trim()))
            })
            .and_then(|s| s["id"].as_str())
            .ok_or_else(|| format!("Linear has no state named {state} for {name}'s team"))?;
        let done = self
            .data(key, MOVE, json!({ "id": linear_id, "state": target }))
            .await?;
        if done["issueUpdate"]["success"].as_bool() != Some(true) {
            return Err(format!("Linear did not move {name} to {state}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::Json;
    use std::sync::{Arc, Mutex};

    const KEY: &str = "lin_api_secret_key";

    async fn fake(moves: Arc<Mutex<Vec<Value>>>) -> String {
        let app = axum::Router::new().route(
            "/graphql",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let moves = moves.clone();
                async move {
                    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(KEY) {
                        return (StatusCode::UNAUTHORIZED, "nope".to_string());
                    }
                    let query = body["query"].as_str().unwrap_or_default().to_string();
                    let id = body["variables"]["id"].as_str().unwrap_or_default().to_string();
                    let answer = if query.contains("assignedIssues") {
                        json!({"data":{"viewer":{"assignedIssues":{"nodes":[
                            {"id":"u-1","identifier":"COM-1","title":"Fix login","url":"https://linear.app/c/issue/COM-1","state":{"name":"Todo"}},
                            {"id":"u-2","identifier":"COM-2","title":"Docs","url":"https://linear.app/c/issue/COM-2","state":{"name":"In Progress"}}
                        ]}}}})
                    } else if query.contains("issueUpdate") {
                        moves.lock().unwrap().push(body["variables"].clone());
                        json!({"data":{"issueUpdate":{"success":true}}})
                    } else if query.contains("states") {
                        json!({"data":{"issue":{"identifier":"COM-1","team":{"states":{"nodes":[
                            {"id":"s-todo","name":"Todo"},{"id":"s-review","name":"In Review"}
                        ]}}}}})
                    } else if query.contains("comments") {
                        let kind = if id == "u-closed" { "completed" } else { "started" };
                        json!({"data":{"issue":{"identifier":"COM-1","description":"The redirect loops.","state":{"type":kind},
                            "comments":{"nodes":[{"body":"Safari only.","user":{"name":"carol"}},{"body":"From a bot.","user":null}]}}}})
                    } else {
                        return (StatusCode::BAD_REQUEST, "unknown query".to_string());
                    };
                    (StatusCode::OK, answer.to_string())
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}/graphql")
    }

    #[tokio::test]
    async fn open_lists_my_tickets() {
        let linear = Linear::with_url(&fake(Arc::default()).await);
        let tickets = linear.open(KEY).await.unwrap();
        assert_eq!(tickets.len(), 2);
        assert_eq!(tickets[0].id, "COM-1");
        assert_eq!(tickets[0].linear_id, "u-1");
        assert_eq!(tickets[1].state, "In Progress");
    }

    #[tokio::test]
    async fn a_ticket_with_its_comments() {
        let linear = Linear::with_url(&fake(Arc::default()).await);
        let (text, closed) = linear.ticket(KEY, "u-1").await.unwrap();
        assert_eq!(text.description, "The redirect loops.");
        assert_eq!(
            text.comments,
            vec![
                ("carol".to_string(), "Safari only.".to_string()),
                ("Someone".to_string(), "From a bot.".to_string())
            ]
        );
        assert!(!closed);
    }

    #[tokio::test]
    async fn a_closed_ticket_says_so() {
        let linear = Linear::with_url(&fake(Arc::default()).await);
        let (_, closed) = linear.ticket(KEY, "u-closed").await.unwrap();
        assert!(closed);
    }

    #[tokio::test]
    async fn move_finds_the_state_by_name() {
        let moves = Arc::new(Mutex::new(Vec::new()));
        let linear = Linear::with_url(&fake(moves.clone()).await);
        linear.move_to(KEY, "u-1", "in review").await.unwrap();
        let moves = moves.lock().unwrap();
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0]["id"], "u-1");
        assert_eq!(moves[0]["state"], "s-review");
    }

    #[tokio::test]
    async fn an_unknown_state_is_named() {
        let linear = Linear::with_url(&fake(Arc::default()).await);
        let err = linear.move_to(KEY, "u-1", "Shipped").await.unwrap_err();
        assert_eq!(err, "Linear has no state named Shipped for COM-1's team");
    }

    #[tokio::test]
    async fn a_bad_key_is_an_error_without_the_key() {
        let linear = Linear::with_url(&fake(Arc::default()).await);
        let wrong = "lin_api_wrong_key_123";
        for err in [
            linear.open(wrong).await.unwrap_err(),
            linear.ticket(wrong, "u-1").await.unwrap_err(),
            linear.move_to(wrong, "u-1", "Todo").await.unwrap_err(),
        ] {
            assert!(err.starts_with("Linear"), "{err}");
            assert!(!err.contains(wrong), "{err}");
        }
        let down = Linear::with_url("http://127.0.0.1:1/graphql");
        assert!(down.open(KEY).await.unwrap_err().starts_with("Linear"));
    }
}
