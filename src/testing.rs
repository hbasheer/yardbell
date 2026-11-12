use crate::shell::{Output, Runner};
use futures::future::BoxFuture;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct FakeRunner {
    stubs: Mutex<Vec<(String, Output)>>,
    calls: Mutex<Vec<Vec<String>>>,
    inputs: Mutex<Vec<Option<String>>>,
    spawned: Mutex<Vec<(u32, Vec<String>, bool)>>,
}

impl FakeRunner {
    pub fn stub(&self, pattern: &str, out: Output) {
        self.stubs.lock().unwrap().push((pattern.into(), out));
    }

    pub fn restub(&self, pattern: &str, out: Output) {
        self.stubs.lock().unwrap().retain(|(p, _)| p != pattern);
        self.stub(pattern, out);
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    pub fn inputs(&self) -> Vec<Option<String>> {
        self.inputs.lock().unwrap().clone()
    }

    pub fn spawned(&self) -> Vec<(u32, Vec<String>, bool)> {
        self.spawned.lock().unwrap().clone()
    }

    pub fn die(&self, pid: u32) {
        for entry in self.spawned.lock().unwrap().iter_mut() {
            if entry.0 == pid {
                entry.2 = false;
            }
        }
    }

    fn lookup(&self, argv: &[String]) -> Output {
        let joined = argv.join(" ");
        self.stubs
            .lock()
            .unwrap()
            .iter()
            .find(|(pattern, _)| joined.contains(pattern.as_str()))
            .map(|(_, out)| out.clone())
            .unwrap_or_else(|| Output::failed(127, "unstubbed"))
    }
}

impl Runner for FakeRunner {
    fn run(
        &self,
        argv: Vec<String>,
        stdin: Option<String>,
        _timeout: Duration,
    ) -> BoxFuture<'_, Output> {
        let out = self.lookup(&argv);
        self.calls.lock().unwrap().push(argv);
        self.inputs.lock().unwrap().push(stdin);
        Box::pin(async move { out })
    }

    fn spawn(&self, argv: Vec<String>, _log: PathBuf) -> std::io::Result<u32> {
        let mut spawned = self.spawned.lock().unwrap();
        let pid = 1000 + spawned.len() as u32;
        spawned.push((pid, argv, true));
        Ok(pid)
    }

    fn alive(&self, pid: u32) -> bool {
        self.spawned
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _, alive)| *p == pid && *alive)
    }

    fn kill(&self, pid: u32) {
        self.die(pid);
    }
}

#[derive(Clone, Debug)]
pub struct Asked {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Asked {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    }
}

// A stand-in HTTP service on a free local port: it answers every request with the next reply
// given (the last one repeats) and records what it was asked.
pub struct FakeHttp {
    pub url: String,
    asked: std::sync::Arc<Mutex<Vec<Asked>>>,
}

impl FakeHttp {
    pub async fn json(body: serde_json::Value) -> FakeHttp {
        FakeHttp::replies(vec![(200, body)]).await
    }

    pub async fn replies(replies: Vec<(u16, serde_json::Value)>) -> FakeHttp {
        use axum::http::StatusCode;
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let replies = std::sync::Arc::new(replies);
        let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let seen = seen.clone();
            let replies = replies.clone();
            async move {
                let method = req.method().to_string();
                let path = req.uri().path().to_string();
                let headers = req
                    .headers()
                    .iter()
                    .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect();
                let bytes = axum::body::to_bytes(req.into_body(), 1 << 20)
                    .await
                    .unwrap_or_default();
                let n = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(Asked {
                        method,
                        path,
                        headers,
                        body: String::from_utf8_lossy(&bytes).into_owned(),
                    });
                    seen.len() - 1
                };
                let (status, body) = replies[n.min(replies.len() - 1)].clone();
                (StatusCode::from_u16(status).unwrap(), axum::Json(body))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeHttp { url, asked }
    }

    pub fn asked(&self) -> Vec<Asked> {
        self.asked.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::{Output, Runner};
    use std::time::Duration;

    #[tokio::test]
    async fn fake_runner_matches_first_stub() {
        let fake = FakeRunner::default();
        fake.stub("ssh", Output::ok_with("first"));
        fake.stub("ssh hp", Output::ok_with("second"));
        let out = fake
            .run(
                vec!["ssh".into(), "hp".into()],
                None,
                Duration::from_secs(1),
            )
            .await;
        assert_eq!(out.stdout, "first");
        let miss = fake
            .run(vec!["ping".into()], None, Duration::from_secs(1))
            .await;
        assert_eq!(miss.status, Some(127));
        assert_eq!(fake.calls().len(), 2);
    }
}
