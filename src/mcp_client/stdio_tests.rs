use super::stdio::{StdioClient, StdioOptions};
use super::{client_for, Client, Failure};
use crate::mcp_client::oauth::Auth;
use crate::mcp_client::oauth_tests::store;
use std::time::Duration;

const FAKE: &str = r#"
import json, os, subprocess, sys, time
mode = sys.argv[1]
if mode == "dies":
    sys.stderr.write("first line\nboom shh-secret-1\n")
    sys.exit(3)
def send(m):
    print(json.dumps(m), flush=True)
child = None
if mode == "family":
    child = subprocess.Popen(["sleep", "300"])
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m:
        continue
    method = m["method"]
    if method == "initialize":
        if mode == "noisy":
            sys.stderr.write("x" * 200000)
            sys.stderr.flush()
            print("not json at all", flush=True)
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "f", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"tools": [{"name": "one", "description": "d", "inputSchema": {"type": "object"}}]}})
    elif method == "tools/call":
        if mode == "family":
            send({"jsonrpc": "2.0", "method": "notifications/message", "params": {"pids": [os.getpid(), child.pid]}})
            print(json.dumps({"pids": [os.getpid(), child.pid]}), file=open(sys.argv[2], "w"), flush=True)
            time.sleep(300)
        if mode == "asks":
            send({"jsonrpc": "2.0", "id": "s1", "method": "sampling/createMessage", "params": {}})
            said = json.loads(sys.stdin.readline())
            text = "refused" if "error" in said else "accepted"
        else:
            text = json.dumps({"tok": os.environ.get("TOK"), "argv": sys.argv, "pid": os.getpid()})
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": text}]}})
"#;

struct Rig {
    dir: tempfile::TempDir,
}

impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("fake.py"), FAKE).unwrap();
        Rig { dir }
    }

    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).display().to_string()
    }

    fn options(&self, mode: &str) -> StdioOptions {
        StdioOptions {
            command: format!(
                "python3 {} {mode} {}",
                self.path("fake.py"),
                self.path("pids")
            ),
            env: vec![("TOK".into(), "shh-secret-1".into())],
            saved: vec!["shh-secret-1".into()],
            timeout: Duration::from_secs(10),
        }
    }
}

fn alive(pid: i64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat
            .rsplit(')')
            .next()
            .is_some_and(|rest| !rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}

async fn gone(pid: i64) -> bool {
    for _ in 0..50 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn stdio_does_the_handshake() {
    let r = Rig::new();
    let mut c = StdioClient::new(r.options("plain"));
    assert_eq!(c.connect().await.unwrap(), "2025-06-18");
    assert_eq!(c.list_tools().await.unwrap()[0].name, "one");
    assert!(
        !c.call_tool("one", serde_json::json!({}))
            .await
            .unwrap()
            .is_error
    );
    c.close().await;
}

#[tokio::test]
async fn stdio_ignores_stderr() {
    let r = Rig::new();
    let mut c = StdioClient::new(r.options("noisy"));
    assert_eq!(c.connect().await.unwrap(), "2025-06-18");
    assert_eq!(c.list_tools().await.unwrap().len(), 1);
    c.close().await;
}

#[tokio::test]
async fn stdio_secrets_go_in_the_environment() {
    let r = Rig::new();
    let mut o = r.options("plain");
    o.saved.clear();
    let mut c = StdioClient::new(o);
    c.connect().await.unwrap();
    let reply = c.call_tool("one", serde_json::json!({})).await.unwrap();
    let said: serde_json::Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(said["tok"], "shh-secret-1");
    assert!(!said["argv"].to_string().contains("shh-secret-1"));
    c.close().await;
}

#[tokio::test]
async fn a_time_limit_stops_the_process_group() {
    let r = Rig::new();
    let mut o = r.options("family");
    o.timeout = Duration::from_secs(2);
    let mut c = StdioClient::new(o);
    c.connect().await.unwrap();
    let e = c.call_tool("one", serde_json::json!({})).await.unwrap_err();
    assert!(
        matches!(&e, Failure::Other(t) if t.contains("in time")),
        "{e:?}"
    );
    let pids: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(r.path("pids")).unwrap()).unwrap();
    assert!(gone(pids["pids"][0].as_i64().unwrap()).await);
    assert!(gone(pids["pids"][1].as_i64().unwrap()).await);
}

#[tokio::test]
async fn no_process_is_left_after_a_call() {
    let r = Rig::new();
    let mut c = StdioClient::new(r.options("plain"));
    c.connect().await.unwrap();
    let reply = c.call_tool("one", serde_json::json!({})).await.unwrap();
    let pid = serde_json::from_str::<serde_json::Value>(&reply.text).unwrap()["pid"]
        .as_i64()
        .unwrap();
    assert!(alive(pid));
    c.close().await;
    assert!(gone(pid).await);
}

#[tokio::test]
async fn dropping_the_client_stops_the_process() {
    let r = Rig::new();
    let mut c = StdioClient::new(r.options("plain"));
    c.connect().await.unwrap();
    let reply = c.call_tool("one", serde_json::json!({})).await.unwrap();
    let pid = serde_json::from_str::<serde_json::Value>(&reply.text).unwrap()["pid"]
        .as_i64()
        .unwrap();
    drop(c);
    assert!(gone(pid).await);
}

#[tokio::test]
async fn a_missing_command_says_so() {
    let r = Rig::new();
    let mut o = r.options("plain");
    o.command = "no-such-program-here --flag".into();
    let e = StdioClient::new(o).connect().await.unwrap_err();
    assert!(
        matches!(&e, Failure::Other(t) if t.contains("no-such-program-here")),
        "{e:?}"
    );
}

#[tokio::test]
async fn an_early_exit_gives_stderrs_last_line_scrubbed() {
    let r = Rig::new();
    let e = StdioClient::new(r.options("dies"))
        .connect()
        .await
        .unwrap_err();
    let Failure::Other(text) = e else {
        panic!("{e:?}")
    };
    assert!(text.contains("boom"), "{text}");
    assert!(!text.contains("first line"), "{text}");
    assert!(!text.contains("shh-secret-1"), "{text}");
}

#[tokio::test]
async fn a_server_request_is_refused_over_stdio() {
    let r = Rig::new();
    let mut c = StdioClient::new(r.options("asks"));
    c.connect().await.unwrap();
    let reply = c.call_tool("one", serde_json::json!({})).await.unwrap();
    assert_eq!(reply.text, "refused");
    c.close().await;
}

fn server(value: serde_json::Value) -> crate::config::McpServer {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn client_for_resolves_secrets_into_the_environment() {
    let r = Rig::new();
    let dir = tempfile::tempdir().unwrap();
    let settings = store(&dir);
    settings.set_secret("tok", "shh-secret-1").unwrap();
    let cfg = settings.load().unwrap();
    let srv = server(serde_json::json!({
        "name": "local",
        "command": format!("python3 {} plain x", r.path("fake.py")),
        "env": { "TOK": "${secret:tok}" },
    }));
    let secrets = settings.secrets().unwrap();
    let auth = Auth::default();
    let mut c = client_for(
        &srv,
        &cfg,
        &secrets,
        &auth,
        &settings,
        vec![],
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(matches!(c, Client::Stdio(_)));
    c.connect().await.unwrap();
    let reply = c.call_tool("one", serde_json::json!({})).await.unwrap();
    assert!(reply.text.contains("shh-secret-1"));
    c.close().await;
}

#[tokio::test]
async fn client_for_refuses_a_command_listed_for_another_machine() {
    let dir = tempfile::tempdir().unwrap();
    let settings = store(&dir);
    let cfg = settings.load().unwrap();
    let srv =
        server(serde_json::json!({ "name": "far", "command": "true", "machines": ["other"] }));
    let secrets = settings.secrets().unwrap();
    let auth = Auth::default();
    let e = client_for(
        &srv,
        &cfg,
        &secrets,
        &auth,
        &settings,
        vec![],
        Duration::from_secs(1),
    )
    .await
    .err()
    .unwrap();
    assert!(
        matches!(&e, Failure::NotAllowed(t) if t.contains("far only runs on other, so a step cannot call it here")),
        "{e:?}"
    );
}

#[tokio::test]
async fn client_for_refuses_yardbell_itself() {
    let dir = tempfile::tempdir().unwrap();
    let settings = store(&dir);
    let cfg = settings.load().unwrap();
    let srv = server(
        serde_json::json!({ "name": "own", "url": format!("http://127.0.0.1:{}/mcp", cfg.port) }),
    );
    let secrets = settings.secrets().unwrap();
    let auth = Auth::default();
    let e = client_for(
        &srv,
        &cfg,
        &secrets,
        &auth,
        &settings,
        vec![],
        Duration::from_secs(1),
    )
    .await
    .err()
    .unwrap();
    assert!(
        matches!(&e, Failure::NotAllowed(t) if t.contains("Yardbell itself")),
        "{e:?}"
    );
}
