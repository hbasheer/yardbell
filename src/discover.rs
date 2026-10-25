use crate::config::MeshProvider;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 4000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

// What /app/hello answers, so a probe can tell a Yardbell server from any other web server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Found {
    pub machine: String,
    pub address: String,
}

#[derive(Deserialize)]
struct Hello {
    app: String,
    machine: String,
    address: String,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .unwrap_or_default()
}

pub async fn hello(http: &reqwest::Client, address: &str) -> Option<Found> {
    let hello: Hello = http
        .get(format!("http://{address}/app/hello"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    (hello.app == "yardbell").then_some(Found {
        machine: hello.machine,
        address: hello.address,
    })
}

pub async fn probe_all(addresses: Vec<String>) -> Vec<Found> {
    let http = http();
    let probes = addresses.iter().map(|address| hello(&http, address));
    dedupe(
        futures::future::join_all(probes)
            .await
            .into_iter()
            .flatten(),
    )
}

pub async fn ask(server: &str) -> Vec<Found> {
    let server = server.trim_end_matches('/');
    let Ok(res) = http().get(format!("{server}/app/servers")).send().await else {
        return Vec::new();
    };
    res.json().await.unwrap_or_default()
}

// The mesh's own command line lists the peers where it exists (Linux). The macOS NordVPN app has
// none, so callers also ask the servers they already know.
pub fn mesh_ips() -> Vec<String> {
    let providers = [
        MeshProvider::Nordvpn,
        MeshProvider::Tailscale,
        MeshProvider::Netbird,
    ];
    for provider in providers {
        let Some(argv) = crate::mesh::peers_argv(provider) else {
            continue;
        };
        let Ok(out) = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(peers) = crate::mesh::parse_peers(provider, &text) {
            return peers
                .into_iter()
                .filter(|p| p.online)
                .map(|p| p.ip)
                .collect();
        }
    }
    Vec::new()
}

pub fn addresses(ips: impl IntoIterator<Item = String>, port: u16) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ip in ips {
        for p in [port, DEFAULT_PORT] {
            let address = format!("{ip}:{p}");
            if !out.contains(&address) {
                out.push(address);
            }
        }
    }
    out
}

pub fn dedupe(found: impl IntoIterator<Item = Found>) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    for f in found {
        if !out.iter().any(|o| o.address == f.address) {
            out.push(f);
        }
    }
    out.sort_by(|a, b| a.machine.cmp(&b.machine).then(a.address.cmp(&b.address)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};

    fn found(machine: &str, address: &str) -> Found {
        Found {
            machine: machine.into(),
            address: address.into(),
        }
    }

    #[test]
    fn addresses_try_the_port_and_the_default() {
        assert_eq!(
            addresses(["100.1.1.1".to_string()], 4100),
            ["100.1.1.1:4100", "100.1.1.1:4000"]
        );
        assert_eq!(
            addresses(["100.1.1.1".to_string()], 4000),
            ["100.1.1.1:4000"]
        );
    }

    #[test]
    fn dedupe_keeps_one_per_address_in_name_order() {
        let list = dedupe([
            found("mini", "100.2:4000"),
            found("hp", "100.1:4000"),
            found("hp", "100.1:4000"),
        ]);
        assert_eq!(
            list,
            [found("hp", "100.1:4000"), found("mini", "100.2:4000")]
        );
    }

    #[tokio::test]
    async fn probes_find_yardbell_and_skip_other_servers() {
        let yardbell = Router::new().route(
            "/app/hello",
            get(|| async {
                Json(serde_json::json!({"app": "yardbell", "machine": "hp", "address": "100.1:4000"}))
            }),
        );
        let other = Router::new().route("/app/hello", get(|| async { "hello" }));
        let mut addresses = Vec::new();
        for app in [yardbell, other] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            addresses.push(listener.local_addr().unwrap().to_string());
            tokio::spawn(async move { axum::serve(listener, app).await });
        }
        addresses.push("127.0.0.1:1".into());
        assert_eq!(probe_all(addresses).await, [found("hp", "100.1:4000")]);
    }
}
