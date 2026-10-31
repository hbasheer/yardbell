use super::{reply_of, tool_of, Failure, Tool, ToolReply};
use super::{PROTOCOLS_KNOWN, PROTOCOL_OFFERED, REPLY_MAX, TOOL_PAGES_MAX};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const STDERR_KEPT: usize = 4096;

pub struct StdioOptions {
    pub command: String,
    pub env: Vec<(String, String)>,
    pub saved: Vec<String>,
    pub timeout: Duration,
}

struct Running {
    child: Child,
    group: Option<u32>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: Arc<Mutex<String>>,
}

pub struct StdioClient {
    options: StdioOptions,
    running: Option<Running>,
    next_id: u64,
}

fn other(text: impl Into<String>) -> Failure {
    Failure::Other(text.into())
}

fn stop_group(group: Option<u32>) {
    if let Some(pid) = group {
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        stop_group(self.group);
    }
}

async fn keep_tail(mut stderr: impl AsyncRead + Unpin, tail: Arc<Mutex<String>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(read) = stderr.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        let mut kept = tail.lock().expect("stderr tail");
        kept.push_str(&String::from_utf8_lossy(&chunk[..read]));
        if kept.len() > STDERR_KEPT {
            let from = kept.ceil_char_boundary(kept.len() - STDERR_KEPT);
            kept.drain(..from);
        }
    }
}

impl StdioClient {
    pub fn new(options: StdioOptions) -> StdioClient {
        StdioClient {
            options,
            running: None,
            next_id: 0,
        }
    }

    fn scrub(&self, text: &str) -> String {
        crate::mcp_read::scrubbed(text, &self.options.saved)
    }

    fn spawn(&mut self) -> Result<(), Failure> {
        let mut words = self.options.command.split_whitespace();
        let program = words
            .next()
            .ok_or_else(|| other("the server has no command"))?;
        let mut child = Command::new(program)
            .args(words)
            .envs(self.options.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    other(format!("{program} was not found on this machine"))
                }
                _ => other(format!("could not start {program}: {e}")),
            })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(other(format!("could not talk to {program}")));
        };
        let tail = Arc::new(Mutex::new(String::new()));
        tokio::spawn(keep_tail(stderr, tail.clone()));
        self.running = Some(Running {
            group: child.id(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr: tail,
        });
        Ok(())
    }

    async fn write(&mut self, message: &Value) -> Result<(), Failure> {
        let line = format!("{message}\n");
        let running = self
            .running
            .as_mut()
            .ok_or_else(|| other("the server is not running"))?;
        if running.stdin.write_all(line.as_bytes()).await.is_err()
            || running.stdin.flush().await.is_err()
        {
            return Err(self.ended().await);
        }
        Ok(())
    }

    async fn ended(&mut self) -> Failure {
        let mut said = String::new();
        if let Some(running) = self.running.as_mut() {
            let _ = tokio::time::timeout(Duration::from_secs(1), running.child.wait()).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            said = running.stderr.lock().expect("stderr tail").clone();
        }
        self.running = None;
        let last = said
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default();
        if last.is_empty() {
            return other("the server stopped without an answer");
        }
        other(format!("the server stopped: {}", self.scrub(last.trim())))
    }

    async fn read_line(&mut self) -> Result<String, Failure> {
        let running = self
            .running
            .as_mut()
            .ok_or_else(|| other("the server is not running"))?;
        let mut bytes = Vec::new();
        loop {
            let available = match running.stdout.fill_buf().await {
                Ok(available) => available,
                Err(_) => return Err(self.ended().await),
            };
            if available.is_empty() {
                return Err(self.ended().await);
            }
            let end = available.iter().position(|b| *b == b'\n');
            let used = end.map_or(available.len(), |at| at + 1);
            bytes.extend_from_slice(&available[..used]);
            running.stdout.consume(used);
            if bytes.len() > REPLY_MAX {
                return Err(other("the server's reply is too large"));
            }
            if end.is_some() {
                return Ok(String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }

    async fn answer(&mut self, id: u64) -> Result<Value, Failure> {
        loop {
            let line = self.read_line().await?;
            let Ok(message) = serde_json::from_str::<Value>(&self.scrub(&line)) else {
                continue;
            };
            if message.get("method").is_some() {
                if message.get("id").is_some() {
                    let refused = json!({
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": { "code": -32601, "message": "Yardbell does not answer server requests" },
                    });
                    self.write(&refused).await?;
                }
                continue;
            }
            if message["id"] == id {
                return Ok(message);
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        self.next_id += 1;
        let id = self.next_id;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let limit = self.options.timeout;
        let exchange = async {
            self.write(&body).await?;
            self.answer(id).await
        };
        let message = match tokio::time::timeout(limit, exchange).await {
            Ok(message) => message?,
            Err(_) => {
                self.close().await;
                return Err(other(format!(
                    "the server did not answer in time, within {}s",
                    limit.as_secs_f32()
                )));
            }
        };
        if let Some(error) = message.get("error") {
            let said = error["message"].as_str().unwrap_or("no reason given");
            return Err(other(format!("the server refused {method}: {said}")));
        }
        Ok(message["result"].clone())
    }

    pub async fn connect(&mut self) -> Result<String, Failure> {
        self.close().await;
        self.spawn()?;
        let params = json!({
            "protocolVersion": PROTOCOL_OFFERED,
            "capabilities": {},
            "clientInfo": { "name": "yardbell", "version": env!("CARGO_PKG_VERSION") },
        });
        let result = self.request("initialize", params).await?;
        let version = result["protocolVersion"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if !PROTOCOLS_KNOWN.contains(&version.as_str()) {
            self.close().await;
            return Err(other(format!(
                "the server speaks MCP version {version:?}, which Yardbell does not know"
            )));
        }
        self.write(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await?;
        Ok(version)
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Tool>, Failure> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..TOOL_PAGES_MAX {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let result = self.request("tools/list", params).await?;
            tools.extend(
                result["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(tool_of),
            );
            cursor = result["nextCursor"].as_str().map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<ToolReply, Failure> {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
        .map(|r| reply_of(&r))
    }

    pub async fn close(&mut self) {
        if let Some(mut running) = self.running.take() {
            stop_group(running.group.take());
            let _ = tokio::time::timeout(Duration::from_secs(2), running.child.wait()).await;
        }
    }
}
