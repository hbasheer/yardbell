use std::io;
use std::net::IpAddr;

use tokio::net::{TcpListener, TcpStream};
use url::Url;

// Browser engines reserve the microphone and other powerful APIs for secure
// contexts, which a plain-http mesh address is not, while 127.0.0.1 is. Pages
// for such a server load through a local port that relays to it.
pub struct Forward {
    local: String,
    target: (String, u16),
    task: tokio::task::JoinHandle<()>,
}

impl Forward {
    pub fn url(&self) -> &str {
        &self.local
    }

    pub fn serves(&self, target: &(String, u16)) -> bool {
        self.target == *target
    }
}

impl Drop for Forward {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn page_target(server: &str) -> Option<(String, u16)> {
    let url = Url::parse(server).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?;
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if loopback {
        return None;
    }
    Some((host.to_string(), url.port_or_known_default()?))
}

pub async fn start(target: (String, u16)) -> io::Result<Forward> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let (host, target_port) = target.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else {
                return;
            };
            let host = host.clone();
            tokio::spawn(async move {
                match TcpStream::connect((host.as_str(), target_port)).await {
                    Ok(mut outbound) => {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                    Err(e) => eprintln!("yardbell: a page can't reach the server: {e}"),
                }
            });
        }
    });
    Ok(Forward {
        local: format!("http://127.0.0.1:{port}"),
        target,
        task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_remote_plain_http_servers_get_a_local_page_address() {
        let target = |host: &str, port| Some((host.to_string(), port));
        assert_eq!(
            page_target("http://100.101.7.20:4100"),
            target("100.101.7.20", 4100)
        );
        assert_eq!(
            page_target("http://yardbell.lan"),
            target("yardbell.lan", 80)
        );
        assert_eq!(page_target("http://127.0.0.1:4000"), None);
        assert_eq!(page_target("http://localhost:4000"), None);
        assert_eq!(page_target("http://[::1]:4000"), None);
        assert_eq!(page_target("https://100.101.7.20:4100"), None);
        assert_eq!(page_target("not a server"), None);
    }

    #[tokio::test]
    async fn pages_pass_through_the_forward_unchanged() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = [0u8; 1024];
                    let _ = socket.read(&mut request).await;
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                        )
                        .await;
                });
            }
        });
        let forward = start(("127.0.0.1".to_string(), port)).await.unwrap();
        assert!(forward.url().starts_with("http://127.0.0.1:"));
        assert!(forward.serves(&("127.0.0.1".to_string(), port)));
        let body = reqwest::get(format!("{}/dispatch", forward.url()))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "ok");
    }
}
