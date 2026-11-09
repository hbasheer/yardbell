use super::*;
use crate::pipeline::record::{RunState, Subject};

async fn get(r: &Rig, c: &str, url: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

fn ended_run(r: &Rig) -> crate::pipeline::record::Run {
    let cfg = r.app.config().unwrap();
    let def = r
        .app
        .pipelines
        .library()
        .copy_template("Implement my tickets", &cfg)
        .unwrap();
    let mut run = r
        .app
        .pipelines
        .start(&def.id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    run.state = RunState::Done;
    run.pending = None;
    run.state_of("plan").runs = 1;
    run.state_of("push").runs = 1;
    let st = run.state_of("implement");
    st.runs = 1;
    st.machine = "hp".into();
    st.path = "/r/app_wt/com-1".into();
    st.session = "hp-com-1".into();
    run.tokens.sources.insert(
        "hp:abc.jsonl".into(),
        crate::pipeline::tokens::Tokens::default(),
    );
    run.tokens.sources.insert(
        "mini:other.jsonl".into(),
        crate::pipeline::tokens::Tokens::default(),
    );
    r.app.pipelines.put(run.clone());
    run
}

fn url(run: &crate::pipeline::record::Run, step: &str) -> String {
    format!("/api/runs/{}/steps/{step}/transcript", run.id)
}

#[tokio::test]
async fn a_finished_steps_transcript_reads_as_a_conversation() {
    let r = rig();
    let c = cookie(&r.app).await;
    let run = ended_run(&r);
    let marker = format!("step: implement-1-{}", run.tag());
    let lines = [
        "@@file abc.jsonl".to_string(),
        json!({"type": "user", "timestamp": "2026-01-01T10:00:00Z", "message": {"content": format!("Implement it.\n{marker}")}}).to_string(),
        json!({"type": "assistant", "timestamp": "2026-01-01T10:01:00Z", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "bin/rspec"}}
        ]}})
        .to_string(),
        json!({"type": "user", "timestamp": "2026-01-01T10:02:00Z", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "3 examples, 0 failures"}
        ]}})
        .to_string(),
        json!({"type": "assistant", "timestamp": "2026-01-01T10:03:00Z", "message": {"content": [
            {"type": "text", "text": "Done, specs pass."}
        ]}})
        .to_string(),
    ];
    r.fake
        .stub("@@skipped", Output::ok_with(&(lines.join("\n") + "\n")));
    let (status, body) = get(&r, &c, &url(&run, "implement")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["available"], true, "{body}");
    assert_eq!(body["machine"], "hp");
    let t = &body["transcript"];
    assert_eq!(t["files"], json!(["abc.jsonl"]));
    let kinds: Vec<&str> = t["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["prompt", "tool", "agent"]);
    assert_eq!(t["items"][1]["input"], "bin/rspec");
    assert_eq!(t["items"][1]["result"], "3 examples, 0 failures");
    let asked = r
        .fake
        .calls()
        .into_iter()
        .map(|c| c.join(" "))
        .find(|c| c.contains("@@skipped"))
        .unwrap();
    assert!(
        asked.contains("'abc.jsonl'"),
        "the run's own file on hp: {asked}"
    );
    assert!(
        !asked.contains("other.jsonl"),
        "not a file of another machine"
    );
    assert!(asked.contains(&marker), "{asked}");
}

#[tokio::test]
async fn a_step_without_a_transcript_says_why() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut run = ended_run(&r);
    run.state_of("review").runs = 1;
    r.app.pipelines.put(run.clone());
    for (step, why) in [
        ("plan", "ran in Dispatch"),
        ("push", "carried out by Yardbell itself"),
        ("review", "never started an agent session"),
    ] {
        let (status, body) = get(&r, &c, &url(&run, step)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["available"], false, "{step}: {body}");
        assert!(
            body["why"].as_str().unwrap().contains(why),
            "{step}: {body}"
        );
    }
    r.fake.stub("@@skipped", Output::ok_with(""));
    let (_, body) = get(&r, &c, &url(&run, "implement")).await;
    assert!(
        body["why"]
            .as_str()
            .unwrap()
            .starts_with("No transcript of Implement was found in /r/app_wt/com-1 on hp"),
        "{body}"
    );
    r.fake.restub(
        "@@skipped",
        Output::failed(255, "ssh: connect to host hp: No route to host"),
    );
    let (_, body) = get(&r, &c, &url(&run, "implement")).await;
    assert!(
        body["why"]
            .as_str()
            .unwrap()
            .contains("could not read the transcript on hp: ssh: connect to host hp"),
        "{body}"
    );
}

#[tokio::test]
async fn only_claude_code_transcripts_are_read() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut run = ended_run(&r);
    let def = run.definition.as_mut().unwrap();
    let step = def.steps.iter_mut().find(|s| s.id == "implement").unwrap();
    if let crate::pipeline::definition::StepKind::Agent { agent, .. } = &mut step.kind {
        *agent = "codex".into();
    }
    r.app.pipelines.put(run.clone());
    let (_, body) = get(&r, &c, &url(&run, "implement")).await;
    assert_eq!(
        body["why"],
        "Implement ran on codex. Yardbell can only read Claude Code transcripts."
    );
}

#[tokio::test]
async fn a_missing_run_or_step_is_not_found() {
    let r = rig();
    let c = cookie(&r.app).await;
    let run = ended_run(&r);
    let (status, _) = get(&r, &c, "/api/runs/nope/steps/implement/transcript").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = get(&r, &c, &url(&run, "qa")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"], "qa has not run in this run");
}
