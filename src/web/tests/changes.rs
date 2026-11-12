use super::*;

const STATUS: &str = "@@YB-STATUS@@";
const DIFF: &str = "| head -c 2000001";
const COMMIT: &str = "git commit -q";

async fn get(r: &Rig, url: &str) -> (StatusCode, serde_json::Value) {
    let c = cookie(&r.app).await;
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

async fn post(r: &Rig, url: &str, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let c = cookie(&r.app).await;
    let (status, _, text) = post_json(&r.app, &c, url, &body.to_string()).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

fn status_output() -> String {
    let sha = "a".repeat(40);
    format!(
        "PREFIX\t\n{STATUS}\n# branch.oid {sha}\0# branch.head main\0\
         1 .M N... 100644 100644 100644 {sha} {sha} src/main.rs\0\
         2 R. N... 100644 100644 100644 {sha} {sha} R100 new.txt\0old.txt\0\
         ? notes.md\0\n@@YB-UNSTAGED@@\n2\t1\tsrc/main.rs\0\n@@YB-STAGED@@\n0\t0\t\0old.txt\0new.txt\0\
         \n@@YB-UNTRACKED@@\nU\t4\t0\tnotes.md\n"
    )
}

// Each script runs under `sh -c '...'`, so its own quotes come back escaped; undo that to read it.
fn scripts(r: &Rig) -> Vec<String> {
    r.fake
        .calls()
        .iter()
        .map(|c| c.last().unwrap().replace("'\\''", "'"))
        .collect()
}

#[tokio::test]
async fn changes_list_every_file_with_its_side_and_counts() {
    let r = rig();
    r.fake.stub(STATUS, Output::ok_with(&status_output()));
    let (status, v) = get(&r, "/machines/hp/changes?root=/r/slots/slot2").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["branch"], "main");
    assert_eq!(
        v["files"],
        json!([
            {"path": "src/main.rs", "status": "modified", "staged": false, "added": 2, "removed": 1, "binary": false},
            {"path": "new.txt", "old_path": "old.txt", "status": "renamed", "staged": true, "added": 0, "removed": 0, "binary": false},
            {"path": "notes.md", "status": "untracked", "staged": false, "added": 4, "removed": 0, "binary": false},
        ])
    );
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("[ 1 != 1 ]"),
        "a folder the check found: {script}"
    );
    assert!(script.contains("status --porcelain=v2 -z"), "{script}");
}

#[tokio::test]
async fn a_path_out_of_the_folder_is_refused_before_the_machine_is_asked() {
    let r = rig();
    for url in [
        "/machines/hp/changes?root=slots/slot2",
        "/machines/hp/changes?root=/r/slots/slot2/../..",
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=../../etc/passwd",
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=/etc/passwd",
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=~/x",
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=",
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=src/../../x",
    ] {
        let (status, v) = get(&r, url).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{url}: {v}");
    }
    let (status, _) = post(
        &r,
        "/machines/hp/changes/commit",
        json!({"root": "/r/slots/slot2", "message": "x", "paths": ["../secret"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(r.fake.calls().is_empty(), "{:?}", r.fake.calls());
}

#[tokio::test]
async fn only_a_listed_file_on_its_listed_side_is_diffed() {
    let r = rig();
    r.fake.stub(STATUS, Output::ok_with(&status_output()));
    r.fake.stub(
        DIFF,
        Output::ok_with("diff --git a/x b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n"),
    );
    let (status, v) = get(
        &r,
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=src/other.rs",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(v["error"], "src/other.rs has no unstaged changes to show");
    let (status, _) = get(
        &r,
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=src/main.rs&staged=true",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "src/main.rs has nothing staged"
    );
    assert!(scripts(&r).iter().all(|s| !s.contains(DIFF)), "no diff ran");

    let (status, v) = get(
        &r,
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=src/main.rs",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(
        (v["added"].as_u64(), v["removed"].as_u64()),
        (Some(2), Some(1))
    );
    assert_eq!(
        v["lines"][2],
        json!({"k": "del", "o": 2, "n": null, "t": "b"})
    );
    assert_eq!(
        (v["total"].as_u64(), v["next"].as_u64()),
        (Some(5), Some(5))
    );
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("--no-textconv -U3 -- 'src/main.rs' |"),
        "{script}"
    );

    get(
        &r,
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=new.txt&staged=true&context=999999",
    )
    .await;
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("--cached -M -U100000 -- 'old.txt' 'new.txt' |"),
        "{script}"
    );
    get(
        &r,
        "/machines/hp/changes/diff?root=/r/slots/slot2&path=notes.md",
    )
    .await;
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("--no-index -U3 -- /dev/null 'notes.md'"),
        "{script}"
    );
}

#[tokio::test]
async fn a_folder_that_is_not_a_repository_says_so() {
    let r = rig();
    r.fake.stub(STATUS, Output::ok_with("ERR notrepo\n"));
    let (status, v) = get(&r, "/machines/hp/changes?root=/r/slots/slot2").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["error"], "that folder is not in a git repository");
}

#[tokio::test]
async fn a_commit_sends_its_message_on_stdin_with_the_listed_paths() {
    let r = rig();
    r.fake.stub(STATUS, Output::ok_with(&status_output()));
    r.fake.stub(
        COMMIT,
        Output::ok_with(&format!("SHA\t{}\n", "b".repeat(40))),
    );
    let message = "Fix it; rm -rf ~ \"quoted\" 'single'\n\n$(id) `id`";
    let (status, v) = post(
        &r,
        "/machines/hp/changes/commit",
        json!({"root": "/r/slots/slot2", "message": message, "paths": ["new.txt", "notes.md"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["short"], "bbbbbbb");
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("git add -- 'notes.md'"),
        "only the new file is added: {script}"
    );
    assert!(
        script.contains("-F - -- 'new.txt' 'old.txt' 'notes.md'"),
        "a rename takes its old path along: {script}"
    );
    assert!(
        !script.contains("rm -rf"),
        "the message is never in the script"
    );
    assert_eq!(
        r.fake.inputs().last().unwrap().as_deref(),
        Some(format!("{message}\n").as_str())
    );

    let (status, _) = post(
        &r,
        "/machines/hp/changes/commit",
        json!({"root": "/r/slots/slot2", "message": "All of it"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("git add -A -- .") && script.contains("-F - -- ."),
        "{script}"
    );
}

#[tokio::test]
async fn a_commit_without_a_message_or_of_unlisted_files_is_refused() {
    let r = rig();
    r.fake.stub(STATUS, Output::ok_with(&status_output()));
    for message in ["", "  \n\t"] {
        let (status, v) = post(
            &r,
            "/machines/hp/changes/commit",
            json!({"root": "/r/slots/slot2", "message": message}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
        assert_eq!(v["error"], "write a commit message first");
    }
    assert!(r.fake.calls().is_empty());
    let (status, v) = post(
        &r,
        "/machines/hp/changes/commit",
        json!({"root": "/r/slots/slot2", "message": "x", "paths": ["README.md"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "README.md has no changes to commit");
    assert!(scripts(&r).iter().all(|s| !s.contains(COMMIT)));

    r.fake
        .stub(COMMIT, Output::ok_with("ERR Author identity unknown\n"));
    let (status, v) = post(
        &r,
        "/machines/hp/changes/commit",
        json!({"root": "/r/slots/slot2", "message": "x"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["error"], "git did not commit: Author identity unknown");
}

#[tokio::test]
async fn a_draft_message_names_the_changed_files() {
    let r = rig();
    r.fake.stub(STATUS, Output::ok_with(&status_output()));
    let (status, v) = get(&r, "/machines/hp/changes/draft?root=/r/slots/slot2").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({"message": "Update main.rs and new.txt, add notes.md", "from": "files"})
    );
}

#[tokio::test]
async fn text_is_pasted_into_a_known_session_with_enter_only_when_asked() {
    let r = rig();
    r.fake.stub("load-buffer", Output::ok_with(""));
    let (status, v) = post(
        &r,
        "/sessions/hp/hp-eng-1301/text",
        json!({"text": "src/a.rs:3\n> x\nWhy?"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let script = scripts(&r).pop().unwrap();
    assert!(
        script.contains("paste-buffer") && !script.contains("Enter"),
        "{script}"
    );
    assert_eq!(
        r.fake.inputs().last().unwrap().as_deref(),
        Some("src/a.rs:3\n> x\nWhy?")
    );
    post(
        &r,
        "/sessions/hp/hp-eng-1301/text",
        json!({"text": "go", "enter": true}),
    )
    .await;
    assert!(scripts(&r).pop().unwrap().ends_with("Enter </dev/null"));

    let before = r.fake.calls().len();
    let (status, _) = post(&r, "/sessions/hp/hp-nobody/text", json!({"text": "x"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post(&r, "/sessions/hp/hp-eng-1301/text", json!({"text": "  "})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(r.fake.calls().len(), before);
}

#[tokio::test]
async fn the_changes_script_is_served() {
    let r = rig();
    let (status, v) = get(&r, "/workspace-changes.js").await;
    assert_eq!(status, StatusCode::OK);
    assert!(v.as_str().unwrap().contains("window.YardbellChanges"));
    let html = String::from_utf8(Assets::get("workspace.html").unwrap().data.into_owned()).unwrap();
    let at = |s: &str| {
        html.find(&format!(r#"<script src="{s}"></script>"#))
            .unwrap()
    };
    assert!(at("/highlight.js") < at("/workspace-changes.js"));
    assert!(at("/workspace-changes.js") < at("/workspace-side.js"));
}
