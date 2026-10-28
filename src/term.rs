use axum::extract::ws::Message;
use axum::http::{header, HeaderMap};
use futures::{Sink, SinkExt, Stream, StreamExt};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::io::{Read, Write};
use std::sync::Mutex;

pub const EXIT_MESSAGE: &str = "session ended or machine unreachable";

pub struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn spawn(argv: &[String], rows: u16, cols: u16) -> std::io::Result<Pty> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| std::io::Error::other("empty command"))?;
    let pair = native_pty_system()
        .openpty(size(rows, cols))
        .map_err(std::io::Error::other)?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(std::io::Error::other)?;
    drop(pair.slave);
    let killer = child.clone_killer();
    Ok(Pty {
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        killer: Mutex::new(killer),
    })
}

impl Pty {
    // portable-pty's own writer types a newline and Ctrl-D as it is dropped. tmux reads its
    // clients' terminals itself, so a closing page could still type them into the session, and a
    // shell there ends.
    pub fn writer(&self) -> std::io::Result<Box<dyn Write + Send>> {
        let master = self.master.lock().expect("pty lock");
        let fd = master
            .as_raw_fd()
            .ok_or_else(|| std::io::Error::other("the terminal has no descriptor"))?;
        let fd = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
        Ok(Box::new(std::fs::File::from(fd)))
    }

    pub fn reader(&self) -> std::io::Result<Box<dyn Read + Send>> {
        self.master
            .lock()
            .expect("pty lock")
            .try_clone_reader()
            .map_err(std::io::Error::other)
    }

    pub fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        self.master
            .lock()
            .expect("pty lock")
            .resize(size(rows, cols))
            .map_err(std::io::Error::other)
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.lock().expect("pty lock").process_id()
    }

    pub fn wait(&self) -> Option<u32> {
        self.child
            .lock()
            .expect("pty lock")
            .wait()
            .ok()
            .map(|s| s.exit_code())
    }

    pub fn kill(&self) {
        let _ = self.killer.lock().expect("pty lock").kill();
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.kill();
        if let Some(pid) = self.pid() {
            std::thread::spawn(move || unsafe {
                libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
            });
        }
    }
}

pub fn origin_ok(headers: &HeaderMap) -> bool {
    let get = |name| {
        headers
            .get(name)
            .and_then(|v: &axum::http::HeaderValue| v.to_str().ok())
    };
    let (Some(origin), Some(host)) = (get(header::ORIGIN), get(header::HOST)) else {
        return false;
    };
    origin == format!("http://{host}") || origin == format!("https://{host}")
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum ClientFrame {
    #[serde(rename = "in")]
    Input { d: String },
    #[serde(rename = "resize")]
    Resize { rows: u16, cols: u16 },
    #[serde(rename = "scroll")]
    Scroll { lines: i32 },
    #[serde(rename = "view")]
    View { on: bool },
    #[serde(rename = "focus")]
    Focus,
}

pub enum Job {
    Lines(i32),
    Bottom(tokio::sync::oneshot::Sender<()>),
    View(bool),
    Typed,
}

pub type Control = tokio::sync::mpsc::UnboundedSender<Job>;

// Copy mode takes every key for itself, so typing after a scroll would go nowhere. The pane is
// put back on the live screen first, and the input waits for that.
async fn leave_scrollback(control: &Option<Control>, scrolled_back: &mut bool) {
    if !std::mem::take(scrolled_back) {
        return;
    }
    let Some(control) = control else { return };
    let (done, wait) = tokio::sync::oneshot::channel();
    if control.send(Job::Bottom(done)).is_ok() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), wait).await;
    }
}

pub async fn bridge<Tx, Rx>(
    mut tx: Tx,
    mut rx: Rx,
    pty: Pty,
    exit_message: &str,
    control: Option<Control>,
) where
    Tx: Sink<Message> + Unpin,
    Rx: Stream<Item = Message> + Unpin,
{
    let pty = std::sync::Arc::new(pty);
    let (Ok(mut reader), Ok(mut writer)) = (pty.reader(), pty.writer()) else {
        let _ = tx.send(exit_frame("could not open a terminal")).await;
        return;
    };
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = in_rx.recv() {
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    let mut scrolled_back = false;
    loop {
        tokio::select! {
            chunk = out_rx.recv() => match chunk {
                Some(bytes) => {
                    if tx.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                None => {
                    let waiter = pty.clone();
                    let _ = tokio::task::spawn_blocking(move || waiter.wait()).await;
                    let _ = tx.send(exit_frame(exit_message)).await;
                    let _ = tx.send(Message::Close(None)).await;
                    break;
                }
            },
            msg = rx.next() => match msg {
                Some(Message::Text(text)) => match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(ClientFrame::Input { d }) => {
                        leave_scrollback(&control, &mut scrolled_back).await;
                        if let Some(control) = &control {
                            let _ = control.send(Job::Typed);
                        }
                        let _ = in_tx.send(d.into_bytes());
                    }
                    Ok(ClientFrame::Resize { rows, cols }) => {
                        let _ = pty.resize(rows.max(1), cols.max(1));
                    }
                    Ok(ClientFrame::Scroll { lines }) => {
                        if let Some(control) = &control {
                            scrolled_back |= lines < 0;
                            let _ = control.send(Job::Lines(lines));
                        }
                    }
                    Ok(ClientFrame::View { on }) => {
                        if let Some(control) = &control {
                            let _ = control.send(Job::View(on));
                        }
                    }
                    Ok(ClientFrame::Focus) => {
                        if let Some(control) = &control {
                            let _ = control.send(Job::Typed);
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "ignored terminal frame"),
                },
                Some(Message::Binary(bytes)) => {
                    leave_scrollback(&control, &mut scrolled_back).await;
                    let _ = in_tx.send(bytes.to_vec());
                }
                Some(Message::Close(_)) | None => break,
                Some(_) => {}
            },
        }
    }
    pty.kill();
}

fn exit_frame(msg: &str) -> Message {
    Message::Text(
        serde_json::json!({ "t": "exit", "msg": msg })
            .to_string()
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::Message;
    use futures::{SinkExt, StreamExt};
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn read_until(pty: &Pty, needle: &str) -> String {
        let mut reader = pty.reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut out = String::new();
        while Instant::now() < deadline && !out.contains(needle) {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                out.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        out
    }

    #[test]
    fn pty_echo() {
        let pty = spawn(&argv(&["cat"]), 24, 80).unwrap();
        pty.writer().unwrap().write_all(b"hi\n").unwrap();
        assert!(read_until(&pty, "hi").contains("hi"));
    }

    #[test]
    fn pty_resize() {
        let pty = spawn(&argv(&["bash", "-c", "sleep 0.5; stty size"]), 24, 80).unwrap();
        pty.resize(40, 100).unwrap();
        assert!(read_until(&pty, "40 100").contains("40 100"));
    }

    #[test]
    fn pty_exit_code() {
        let pty = spawn(&argv(&["bash", "-c", "exit 3"]), 24, 80).unwrap();
        assert_eq!(pty.wait(), Some(3));
    }

    #[test]
    fn drop_kills_child() {
        let pty = spawn(&argv(&["sleep", "30"]), 24, 80).unwrap();
        let pid = pty.pid().unwrap();
        drop(pty);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "child {pid} still running or left as a zombie"
        );
    }

    #[test]
    fn origin_checks() {
        let mut h = axum::http::HeaderMap::new();
        h.insert("host", "100.9.9.9:4000".parse().unwrap());
        assert!(!origin_ok(&h));
        h.insert("origin", "http://evil.example".parse().unwrap());
        assert!(!origin_ok(&h));
        h.insert("origin", "http://100.9.9.9:4000".parse().unwrap());
        assert!(origin_ok(&h));
        h.insert("origin", "https://100.9.9.9:4000".parse().unwrap());
        assert!(origin_ok(&h));
    }

    #[tokio::test]
    async fn bridge_relays_and_reports_exit() {
        let (mut client_tx, server_rx) = futures::channel::mpsc::unbounded::<Message>();
        let (server_tx, mut client_rx) = futures::channel::mpsc::unbounded::<Message>();
        let pty = spawn(
            &argv(&["bash", "-c", "read line; printf 'got:%s' \"$line\"; exit 3"]),
            24,
            80,
        )
        .unwrap();
        let task = tokio::spawn(bridge(server_tx, server_rx, pty, EXIT_MESSAGE, None));
        client_tx
            .send(Message::Text(
                r#"{"t":"resize","rows":30,"cols":90}"#.into(),
            ))
            .await
            .unwrap();
        client_tx
            .send(Message::Text(r#"{"t":"in","d":"abc\r"}"#.into()))
            .await
            .unwrap();
        let mut output = String::new();
        let mut exit = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while let Ok(Some(msg)) = tokio::time::timeout_at(deadline, client_rx.next()).await {
            match msg {
                Message::Binary(b) => output.push_str(&String::from_utf8_lossy(&b)),
                Message::Text(t) => exit = Some(t.to_string()),
                Message::Close(_) => break,
                _ => {}
            }
        }
        assert!(output.contains("got:abc"), "{output:?}");
        let exit = exit.expect("no exit frame");
        assert!(
            exit.contains("session ended or machine unreachable"),
            "{exit}"
        );
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn bridge_scrolls_and_returns_to_live_screen_before_input() {
        let (mut client_tx, server_rx) = futures::channel::mpsc::unbounded::<Message>();
        let (server_tx, mut client_rx) = futures::channel::mpsc::unbounded::<Message>();
        let (scroll_tx, mut scroll_rx) = tokio::sync::mpsc::unbounded_channel();
        let pty = spawn(
            &argv(&["bash", "-c", "read line; printf 'got:%s' \"$line\""]),
            24,
            80,
        )
        .unwrap();
        let task = tokio::spawn(bridge(
            server_tx,
            server_rx,
            pty,
            EXIT_MESSAGE,
            Some(scroll_tx),
        ));
        client_tx
            .send(Message::Text(r#"{"t":"scroll","lines":-4}"#.into()))
            .await
            .unwrap();
        client_tx
            .send(Message::Text(r#"{"t":"in","d":"abc\r"}"#.into()))
            .await
            .unwrap();
        let wait = Duration::from_secs(2);
        let Ok(Some(Job::Lines(-4))) = tokio::time::timeout(wait, scroll_rx.recv()).await else {
            panic!("scroll frame was not forwarded");
        };
        let Ok(Some(Job::Bottom(done))) = tokio::time::timeout(wait, scroll_rx.recv()).await else {
            panic!("input did not leave scrollback first");
        };
        done.send(()).unwrap();
        let mut output = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while let Ok(Some(msg)) = tokio::time::timeout_at(deadline, client_rx.next()).await {
            match msg {
                Message::Binary(b) => output.push_str(&String::from_utf8_lossy(&b)),
                Message::Close(_) => break,
                _ => {}
            }
        }
        assert!(output.contains("got:abc"), "{output:?}");
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn bridge_close_types_nothing_more_into_the_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let typed = dir.path().join("typed");
        let (mut client_tx, server_rx) = futures::channel::mpsc::unbounded::<Message>();
        let (server_tx, mut client_rx) = futures::channel::mpsc::unbounded::<Message>();
        // Like a tmux client, it takes raw keys and still reads them for a moment after the hangup.
        let pty = spawn(
            &argv(&[
                "bash",
                "-c",
                r#"trap '' HUP; stty raw -echo; printf ready; while IFS= read -r -d '' -n 1 -t 1 c; do printf '%s' "$c" >> "$0"; done"#,
                typed.to_str().unwrap(),
            ]),
            24,
            80,
        )
        .unwrap();
        let pid = pty.pid().unwrap();
        let task = tokio::spawn(bridge(server_tx, server_rx, pty, EXIT_MESSAGE, None));
        let mut output = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !output.contains("ready") {
            match tokio::time::timeout_at(deadline, client_rx.next()).await {
                Ok(Some(Message::Binary(b))) => output.push_str(&String::from_utf8_lossy(&b)),
                Ok(Some(_)) => {}
                _ => panic!("the terminal never got ready: {output:?}"),
            }
        }
        client_tx
            .send(Message::Text(r#"{"t":"in","d":"abc"}"#.into()))
            .await
            .unwrap();
        drop(client_tx);
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::path::Path::new(&format!("/proc/{pid}")).exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            String::from_utf8_lossy(&std::fs::read(&typed).unwrap()),
            "abc"
        );
    }

    #[tokio::test]
    async fn bridge_client_close_kills_pty() {
        let (client_tx, server_rx) = futures::channel::mpsc::unbounded::<Message>();
        let (server_tx, _client_rx) = futures::channel::mpsc::unbounded::<Message>();
        let pty = spawn(&argv(&["sleep", "30"]), 24, 80).unwrap();
        let pid = pty.pid().unwrap();
        let task = tokio::spawn(bridge(server_tx, server_rx, pty, EXIT_MESSAGE, None));
        drop(client_tx);
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let running = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| !s.contains(") Z"))
            .unwrap_or(false);
        assert!(!running, "pty child survived client close");
    }
}
