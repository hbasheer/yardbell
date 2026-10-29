use super::*;
use crate::pipeline::legacy::{ParkKind, Parked, Question, Record, Stage};

async fn get_json(r: &Rig, c: &str, url: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, serde_json::from_str(&body).unwrap_or(json!(body)))
}

async fn post(
    r: &Rig,
    c: &str,
    url: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let (status, _, body) = post_json(&r.app, c, url, &body.to_string()).await;
    (status, serde_json::from_str(&body).unwrap_or(json!(body)))
}

async fn fake_linear() -> String {
    let app = axum::Router::new().fallback(|| async {
        json!({"data":{"viewer":{"assignedIssues":{"nodes":[
            {"id":"u-1","identifier":"COM-1","title":"Fix login","url":"https://linear.app/c/issue/COM-1","state":{"name":"Todo"}},
            {"id":"u-2","identifier":"COM-2","title":"Docs","url":"https://linear.app/c/issue/COM-2","state":{"name":"In Progress"}},
            {"id":"u-3","identifier":"COM-3","title":"Search","url":"https://linear.app/c/issue/COM-3","state":{"name":"Todo"}}
        ]}}}})
        .to_string()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{addr}/graphql")
}

async fn with_linear(r: &Rig) {
    r.app
        .pipeline
        .use_linear(crate::pipeline::linear::Linear::with_url(
            &fake_linear().await,
        ));
    let mut secrets = r.app.secrets().unwrap();
    secrets
        .set("linear", "lin_api_test", chrono::Utc::now())
        .unwrap();
    secrets.save().unwrap();
}

fn parked(id: &str, kind: ParkKind) -> Record {
    Record {
        id: id.into(),
        run: "r1".into(),
        stage: Stage::Parked,
        parked: Some(Parked {
            kind,
            reason: "x".into(),
            from: Stage::Triage,
            screen: String::new(),
        }),
        questions: vec![Question {
            asked: "Which page?".into(),
            ..Question::default()
        }],
        ..Record::default()
    }
}

#[tokio::test]
async fn the_pipeline_lists_records_and_runs() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.app.pipeline.put(parked("COM-1", ParkKind::Questions));
    r.app.pipeline.put(Record {
        id: "COM-2".into(),
        run: "r1".into(),
        stage: Stage::Done,
        ..Record::default()
    });
    let (status, body) = get_json(&r, &c, "/api/pipeline").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["records"].as_array().unwrap().len(), 2);
    assert_eq!(body["runs"][0]["run"], "r1");
    assert_eq!(body["runs"][0]["done"], 1);
    assert_eq!(body["runs"][0]["parked"], 1);
    assert_eq!(body["runs"][0]["active"], 0);
}

#[tokio::test]
async fn tickets_come_from_linear_with_running_marked() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, body) = get_json(&r, &c, "/api/pipeline/tickets").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("the secret linear is not set"),
        "{body}"
    );
    with_linear(&r).await;
    r.app.pipeline.put(Record {
        id: "COM-1".into(),
        stage: Stage::Implement,
        ..Record::default()
    });
    let (status, body) = get_json(&r, &c, "/api/pipeline/tickets").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tickets = body["tickets"].as_array().unwrap();
    assert_eq!(tickets.len(), 3);
    assert_eq!(
        (&tickets[0]["id"], &tickets[0]["running"]),
        (&json!("COM-1"), &json!(true))
    );
    assert_eq!(tickets[1]["running"], false);
}

#[tokio::test]
async fn starting_a_run_by_ids_and_by_state() {
    let r = rig();
    let c = cookie(&r.app).await;
    with_linear(&r).await;
    let (status, body) = post(&r, &c, "/api/pipeline/runs", json!({ "ids": ["COM-2"] })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["records"][0]["id"], "COM-2");
    assert_eq!(r.app.pipeline.get("COM-2").unwrap().stage, Stage::Queued);
    let (status, body) = post(&r, &c, "/api/pipeline/runs", json!({ "state": "todo" })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ids: Vec<&str> = body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["COM-1", "COM-3"]);
    let (status, body) = post(&r, &c, "/api/pipeline/runs", json!({ "ids": ["COM-9"] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("COM-9 is not one of your open tickets"),
        "{body}"
    );
}

#[tokio::test]
async fn a_running_ticket_is_refused_with_409() {
    let r = rig();
    let c = cookie(&r.app).await;
    with_linear(&r).await;
    r.app.pipeline.put(Record {
        id: "COM-1".into(),
        stage: Stage::Review,
        ..Record::default()
    });
    let (status, body) = post(&r, &c, "/api/pipeline/runs", json!({ "ids": ["COM-1"] })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("COM-1 is already in a run"),
        "{body}"
    );
}

#[tokio::test]
async fn answer_retry_drop() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.app.pipeline.put(parked("COM-1", ParkKind::Questions));
    let (status, body) = post(
        &r,
        &c,
        "/api/pipeline/tickets/COM-1/answer",
        json!({ "text": "The account page" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["stage"], "triage");
    let (status, _) = post(&r, &c, "/api/pipeline/tickets/COM-1/drop", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r.app.pipeline.get("COM-1").unwrap().stage, Stage::Dropped);
    let (status, _) = post(&r, &c, "/api/pipeline/tickets/COM-1/retry", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = post(&r, &c, "/api/pipeline/tickets/COM-9/retry", json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_answer_to_a_push_park_is_400() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.app.pipeline.put(parked("COM-1", ParkKind::Push));
    let (status, body) = post(
        &r,
        &c,
        "/api/pipeline/tickets/COM-1/answer",
        json!({ "text": "go" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("COM-1 is not waiting for an answer"),
        "{body}"
    );
}
