use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use yardbell::local_server::{status, Status};

const MARKER: &str = "local-server";
const START_WAIT: Duration = Duration::from_secs(10);

static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: OnceLock<Arc<tokio::sync::Notify>> = OnceLock::new();

fn stop_signal() -> Arc<tokio::sync::Notify> {
    STOP.get_or_init(Default::default).clone()
}

pub fn enabled(dir: &Path) -> bool {
    dir.join(MARKER).exists()
}

pub fn enable(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(MARKER), "")
}

pub fn disable(dir: &Path) -> io::Result<()> {
    match std::fs::remove_file(dir.join(MARKER)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn address(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn ready_port() -> Option<u16> {
    match status(&yardbell::cli::default_config_path()) {
        Status::Ready { port } => Some(port),
        _ => None,
    }
}

// The server runs inside the app until the app quits or the user signs out. When another Yardbell
// already serves the port, for example the login service, serve fails to listen and the app
// signs in to that one instead.
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let path = yardbell::cli::default_config_path();
    let stop = stop_signal();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = yardbell::cli::serve(path, true, stop.notified()).await {
            eprintln!("yardbell: the server on this machine stopped: {e:#}");
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

pub fn stop() {
    if RUNNING.load(Ordering::SeqCst) {
        stop_signal().notify_waiters();
    }
}

pub async fn wait_until_up(port: u16) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + START_WAIT;
    while tokio::time::Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!(
        "the server on this machine did not start on port {port}, run yardbell doctor in a terminal to see why"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_turns_the_local_server_on() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("dev.yardbell.desktop");
        assert!(!enabled(&dir));
        enable(&dir).unwrap();
        assert!(enabled(&dir));
        disable(&dir).unwrap();
        assert!(!enabled(&dir));
        disable(&dir).unwrap();
    }

    #[tokio::test]
    async fn wait_until_up_sees_a_listening_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        wait_until_up(port).await.unwrap();
    }
}
