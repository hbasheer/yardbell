use super::*;

const LIST: &str = "set -- .[!.]*";
const READ: &str = "head -c 8192";

async fn get(r: &Rig, url: &str) -> (StatusCode, serde_json::Value) {
    let c = cookie(&r.app).await;
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

fn last_script(r: &Rig) -> String {
    r.fake.calls().pop().unwrap().last().unwrap().clone()
}

#[tokio::test]
async fn a_path_out_of_the_folder_is_refused_before_the_machine_is_asked() {
    let r = rig();
    for url in [
        "/machines/hp/files?root=/r/slots/slot2&path=../../etc",
        "/machines/hp/files?root=/r/slots/slot2/../..&path=",
        "/machines/hp/files?root=slots/slot2&path=",
        "/machines/hp/file?root=/r/slots/slot2&path=/etc/passwd",
        "/machines/hp/file?root=/r/slots/slot2&path=src/../../../etc/passwd",
        "/machines/hp/files/search?root=/r/slots/slot2/..&q=x",
    ] {
        let (status, v) = get(&r, url).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{url}: {v}");
    }
    assert!(r.fake.calls().is_empty(), "{:?}", r.fake.calls());
}

#[tokio::test]
async fn a_folder_lists_its_entries_with_kind_and_size() {
    let r = rig();
    r.fake.stub(
        LIST,
        Output::ok_with(
            "regular file\t12\tREADME.md\ndirectory\t4096\tsrc\nRegular File\t3\t.env\n",
        ),
    );
    let (status, v) = get(&r, "/machines/hp/files?root=/r/slots/slot2&path=").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({
            "path": "",
            "entries": [
                {"name": "src", "kind": "dir", "size": 4096},
                {"name": ".env", "kind": "file", "size": 3},
                {"name": "README.md", "kind": "file", "size": 12},
            ],
            "more": false,
        })
    );
    let script = last_script(&r);
    assert!(
        script.contains("[ 1 != 1 ]"),
        "a folder the check found: {script}"
    );
    get(&r, "/machines/hp/files?root=/r/elsewhere&path=lib").await;
    let script = last_script(&r);
    assert!(
        script.contains("[ 0 != 1 ]"),
        "any other folder must be under the root: {script}"
    );
    assert!(script.contains("~/code/acme"), "{script}");
}

#[tokio::test]
async fn a_folder_the_machine_finds_outside_is_refused() {
    let r = rig();
    r.fake.stub(LIST, Output::ok_with("ERR outside\n"));
    let (status, v) = get(&r, "/machines/hp/files?root=/r/elsewhere&path=link").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "link is outside this folder");
}

#[tokio::test]
async fn a_text_file_is_read_and_a_binary_or_large_one_refused() {
    let r = rig();
    r.fake
        .stub(READ, Output::ok_with("SIZE\t15\nfn main() {}\nERR \n"));
    let (status, v) = get(&r, "/machines/hp/file?root=/r/slots/slot2&path=src/main.rs").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["text"], "fn main() {}\nERR \n");
    assert_eq!(v["size"], 15);
    assert_eq!(v["path"], "src/main.rs");

    r.fake.restub(READ, Output::ok_with("ERR binary\n"));
    let (status, v) = get(&r, "/machines/hp/file?root=/r/slots/slot2&path=logo.png").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(v["error"], "logo.png is a binary file, so it is not shown");

    r.fake.restub(READ, Output::ok_with("ERR large 5242880\n"));
    let (status, v) = get(&r, "/machines/hp/file?root=/r/slots/slot2&path=big.log").await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        v["error"],
        "big.log is 5.0 MB, larger than the 1.0 MB Yardbell shows"
    );

    let (status, _) = get(&r, "/machines/hp/file?root=/r/slots/slot2&path=").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn search_greps_contents_or_finds_names() {
    let r = rig();
    r.fake
        .stub("grep -rIl", Output::ok_with("./src/main.rs\n./README.md\n"));
    r.fake.stub("-iname", Output::ok_with("./src/main.rs\n"));
    let (status, v) = get(
        &r,
        "/machines/hp/files/search?root=/r/slots/slot2&q=hello&mode=contents",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({"matches": ["README.md", "src/main.rs"], "more": false})
    );
    assert!(last_script(&r).contains("timeout 10"));
    let (_, v) = get(&r, "/machines/hp/files/search?root=/r/slots/slot2&q=main").await;
    assert_eq!(v["matches"], json!(["src/main.rs"]));
    let (status, _) = get(&r, "/machines/hp/files/search?root=/r/slots/slot2&q=%20").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

fn transcript() -> String {
    [
        "@@scanned 3".to_string(),
        "@@file 0b4f-old.jsonl\t1700000000".to_string(),
        json!({"type": "user", "cwd": "/r/slots/slot2", "message": {"content": "Look at the inbox"}}).to_string(),
        "@@count 2".to_string(),
        "@@file 9a1c-new.jsonl\t1700000500".to_string(),
        json!({"type": "user", "cwd": "/r/slots/slot2", "message": {"content": "Fix the inbox filter\nthen push"}}).to_string(),
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Pushed the fix."}]}}).to_string(),
        json!({"type": "ai-title", "aiTitle": "Inbox filter fix"}).to_string(),
        "@@count 14".to_string(),
    ]
    .join("\n")
}

#[tokio::test]
async fn history_lists_past_claude_sessions_newest_first() {
    let r = rig();
    r.fake.stub("ai-title", Output::ok_with(&transcript()));
    let (status, v) = get(&r, "/machines/hp/history?path=/r/slots/slot2").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["scanned"], 3);
    assert_eq!(v["scope"], "folder");
    let sessions = v["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(
        sessions[0],
        json!({
            "id": "9a1c-new", "folder": "/r/slots/slot2", "title": "Inbox filter fix",
            "prompt": "Fix the inbox filter then push", "summary": "Pushed the fix.",
            "updated": 1_700_000_500, "messages": 14,
        })
    );
    assert_eq!(sessions[1]["title"], "Look at the inbox");
    assert!(last_script(&r).contains("/r/slots/slot2"));

    let (status, v) = get(&r, "/machines/hp/history?scope=all").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["scope"], "all");
    assert!(last_script(&r).contains("*/*.jsonl"));

    let (status, _) = get(&r, "/machines/hp/history?path=relative").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn resume_by_id_runs_claude_with_that_session() {
    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, body) = post_session(
        &r,
        r#"{"machine":"hp","path":"/r/slots/slot2","agent":"claude","resume_id":"9a1c-new"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let script = last_script(&r);
    assert!(script.contains("claude --resume"), "{script}");
    assert!(script.contains("9a1c-new"), "{script}");

    let (status, body) = post_session(
        &r,
        r#"{"machine":"hp","path":"/r/slots/slot2","agent":"claude","resume_id":"x;rm -rf ~"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = post_session(
        &r,
        r#"{"machine":"hp","path":"/r/slots/slot2","agent":"gemini","resume_id":"9a1c-new"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("only Claude Code sessions"), "{body}");
}
