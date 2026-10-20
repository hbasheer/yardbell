use crate::config::{Config, MeshProvider};
use crate::onboarding::peers::{self, Peer};
use crate::shell::{Duration, Runner};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

pub fn label(p: MeshProvider) -> &'static str {
    match p {
        MeshProvider::Nordvpn => "NordVPN Meshnet",
        MeshProvider::Tailscale => "Tailscale",
        MeshProvider::Headscale => "Headscale",
        MeshProvider::Netbird => "NetBird",
        MeshProvider::Zerotier => "ZeroTier",
        MeshProvider::None => "Mesh VPN",
    }
}

pub fn status_argv(p: MeshProvider) -> Option<Vec<String>> {
    match p {
        MeshProvider::Nordvpn => Some(argv(&["nordvpn", "settings"])),
        MeshProvider::Tailscale | MeshProvider::Headscale => {
            Some(argv(&["tailscale", "status", "--json"]))
        }
        MeshProvider::Netbird => Some(argv(&["netbird", "status", "--json"])),
        MeshProvider::Zerotier => Some(argv(&["zerotier-cli", "info"])),
        MeshProvider::None => None,
    }
}

pub fn up_argv(p: MeshProvider) -> Option<Vec<String>> {
    match p {
        MeshProvider::Nordvpn => Some(argv(&["nordvpn", "set", "meshnet", "on"])),
        MeshProvider::Tailscale | MeshProvider::Headscale => Some(argv(&["tailscale", "up"])),
        MeshProvider::Netbird => Some(argv(&["netbird", "up"])),
        MeshProvider::Zerotier | MeshProvider::None => None,
    }
}

pub fn peers_argv(p: MeshProvider) -> Option<Vec<String>> {
    match p {
        MeshProvider::Nordvpn => Some(argv(&["nordvpn", "meshnet", "peer", "list"])),
        MeshProvider::Tailscale | MeshProvider::Headscale | MeshProvider::Netbird => status_argv(p),
        MeshProvider::Zerotier | MeshProvider::None => None,
    }
}

pub fn parse_status(p: MeshProvider, out: &str) -> Option<bool> {
    match p {
        MeshProvider::Nordvpn => out.lines().find_map(|l| {
            let value = l.trim().strip_prefix("Meshnet:")?.trim();
            Some(value.eq_ignore_ascii_case("enabled"))
        }),
        MeshProvider::Tailscale | MeshProvider::Headscale => {
            let v: serde_json::Value = serde_json::from_str(out).ok()?;
            Some(v.get("BackendState")?.as_str()? == "Running")
        }
        MeshProvider::Netbird => {
            let v: serde_json::Value = serde_json::from_str(out).ok()?;
            let connected = v.get("management")?.get("connected")?.as_bool()?;
            let has_ip = v
                .get("netbirdIp")
                .and_then(|i| i.as_str())
                .is_some_and(|i| !i.is_empty());
            Some(connected && has_ip)
        }
        MeshProvider::Zerotier => {
            let line = out.lines().find(|l| l.starts_with("200 info"))?;
            Some(line.split_whitespace().last() == Some("ONLINE"))
        }
        MeshProvider::None => None,
    }
}

pub fn parse_peers(p: MeshProvider, out: &str) -> Option<Vec<Peer>> {
    match p {
        MeshProvider::Nordvpn => peers::parse_nordvpn(out),
        MeshProvider::Tailscale | MeshProvider::Headscale => peers::parse_tailscale(out),
        MeshProvider::Netbird => parse_netbird(out),
        MeshProvider::Zerotier | MeshProvider::None => None,
    }
}

fn parse_netbird(out: &str) -> Option<Vec<Peer>> {
    let v: serde_json::Value = serde_json::from_str(out).ok()?;
    let details = v.get("peers")?.get("details")?.as_array()?;
    Some(
        details
            .iter()
            .filter_map(|p| {
                let ip = p.get("netbirdIp")?.as_str()?.split('/').next()?.to_string();
                Some(Peer {
                    hostname: p
                        .get("fqdn")
                        .and_then(|f| f.as_str())
                        .unwrap_or(&ip)
                        .to_string(),
                    nickname: None,
                    online: p.get("status").and_then(|s| s.as_str()) == Some("Connected"),
                    os: String::new(),
                    ip,
                })
            })
            .collect(),
    )
}

pub fn is_mesh_ip(ip: &str) -> bool {
    let Ok(addr) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let [a, b, ..] = addr.octets();
    a == 100 && (64..=127).contains(&b)
}

pub fn addresses(out: &str) -> Vec<String> {
    out.split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .filter(|w| w[0] == "inet")
        .map(|w| w[1].split('/').next().unwrap_or(w[1]).to_string())
        .collect()
}

pub fn off_hint(p: MeshProvider, has_cli: bool) -> String {
    match (p, has_cli) {
        (MeshProvider::Nordvpn, false) => "Open the NordVPN app and turn on Meshnet.".into(),
        (MeshProvider::Zerotier, _) => "Run zerotier-cli join <network id> on this machine.".into(),
        (MeshProvider::None, _) => "Connect this machine to your mesh VPN.".into(),
        (p, true) => match up_argv(p) {
            Some(cmd) => format!("Run {}, or use Turn on.", cmd.join(" ")),
            None => format!("Turn on {} on this machine.", label(p)),
        },
        (p, false) => format!("Open {} and connect.", label(p)),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshView {
    pub provider: MeshProvider,
    pub label: String,
    pub on: Option<bool>,
    pub can_turn_on: bool,
    pub hint: Option<String>,
}

const CACHE_FOR: Duration = Duration::from_secs(4);
const CHECK_TIMEOUT: Duration = Duration::from_secs(4);
const UP_TIMEOUT: Duration = Duration::from_secs(25);

pub fn host_provider(cfg: &Config) -> MeshProvider {
    cfg.host().map(|m| cfg.mesh_for(m)).unwrap_or(cfg.mesh)
}

pub struct HostMesh {
    runner: Arc<dyn Runner>,
    cache: Mutex<Option<(Instant, MeshView)>>,
}

impl HostMesh {
    pub fn new(runner: Arc<dyn Runner>) -> HostMesh {
        HostMesh {
            runner,
            cache: Mutex::new(None),
        }
    }

    pub async fn check(&self, cfg: &Config) -> MeshView {
        if let Some((at, view)) = self.cache.lock().expect("mesh cache").clone() {
            if at.elapsed() < CACHE_FOR {
                return view;
            }
        }
        let view = self.compute(cfg).await;
        *self.cache.lock().expect("mesh cache") = Some((Instant::now(), view.clone()));
        view
    }

    async fn compute(&self, cfg: &Config) -> MeshView {
        let p = host_provider(cfg);
        let mut has_cli = false;
        let mut on = None;
        if let Some(cmd) = status_argv(p) {
            let out = self.runner.run(cmd, None, CHECK_TIMEOUT).await;
            has_cli = out.status.is_some() && out.status != Some(127);
            if out.ok() {
                on = parse_status(p, &out.stdout);
            }
        }
        if on.is_none() {
            on = self.interface_has_mesh(cfg).await;
        }
        MeshView {
            provider: p,
            label: label(p).to_string(),
            on,
            can_turn_on: has_cli && up_argv(p).is_some(),
            hint: (on == Some(false)).then(|| off_hint(p, has_cli)),
        }
    }

    async fn interface_has_mesh(&self, cfg: &Config) -> Option<bool> {
        let expected = cfg.bind_addresses().into_iter().nth(1);
        for cmd in [vec!["ip", "-o", "-4", "addr", "show"], vec!["ifconfig"]] {
            let out = self
                .runner
                .run(
                    cmd.iter().map(|s| s.to_string()).collect(),
                    None,
                    CHECK_TIMEOUT,
                )
                .await;
            if !out.ok() {
                continue;
            }
            let found = addresses(&out.stdout);
            return Some(match &expected {
                Some(ip) => found.iter().any(|a| a == ip),
                None => found.iter().any(|a| is_mesh_ip(a)),
            });
        }
        None
    }

    pub async fn turn_on(&self, cfg: &Config) -> Result<String, String> {
        let p = host_provider(cfg);
        let Some(cmd) = up_argv(p) else {
            return Err(format!(
                "{} cannot be turned on from Yardbell. {}",
                label(p),
                off_hint(p, true)
            ));
        };
        let out = self.runner.run(cmd, None, UP_TIMEOUT).await;
        *self.cache.lock().expect("mesh cache") = None;
        let text = format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
            .trim()
            .to_string();
        if out.ok() {
            return Ok(if text.is_empty() {
                format!("{} is on", label(p))
            } else {
                text
            });
        }
        if out.timed_out {
            return Err(format!("{} did not answer in time", label(p)));
        }
        Err(if text.is_empty() {
            format!("could not turn on {}", label(p))
        } else {
            text
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, MeshProvider as P};
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::path::Path;
    use std::sync::Arc;

    fn cfg(mesh: P) -> Config {
        let mut cfg = Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        cfg.mesh = mesh;
        cfg
    }

    const IP_ON: &str = "4: nordlynx    inet 100.64.0.10/10 scope global nordlynx\n";
    const IP_OFF: &str = "2: wlan0    inet 192.168.1.20/24 scope global wlan0\n";

    #[tokio::test]
    async fn host_uses_provider_cli_when_present() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("nordvpn settings", Output::ok_with("Meshnet: enabled\n"));
        let view = HostMesh::new(fake).check(&cfg(P::Nordvpn)).await;
        assert_eq!(view.on, Some(true));
        assert!(view.can_turn_on);
        assert!(view.hint.is_none());
    }

    #[tokio::test]
    async fn host_without_cli_falls_back_to_interface() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ip -o -4 addr", Output::ok_with(IP_OFF));
        let view = HostMesh::new(fake).check(&cfg(P::Nordvpn)).await;
        assert_eq!(view.on, Some(false));
        assert!(!view.can_turn_on);
        assert_eq!(
            view.hint.as_deref(),
            Some("Open the NordVPN app and turn on Meshnet.")
        );
    }

    #[tokio::test]
    async fn host_interface_check_uses_ifconfig_when_ip_missing() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "ifconfig",
            Output::ok_with(
                "utun4: flags\n\tinet 100.64.0.10 --> 100.64.0.10 netmask 0xffc00000\n",
            ),
        );
        let view = HostMesh::new(fake).check(&cfg(P::None)).await;
        assert_eq!(view.on, Some(true));
    }

    #[tokio::test]
    async fn host_provider_off_offers_turn_on() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "tailscale status --json",
            Output::ok_with(r#"{"BackendState":"Stopped"}"#),
        );
        let view = HostMesh::new(fake).check(&cfg(P::Tailscale)).await;
        assert_eq!(view.on, Some(false));
        assert!(view.can_turn_on);
        assert_eq!(
            view.hint.as_deref(),
            Some("Run tailscale up, or use Turn on.")
        );
    }

    #[tokio::test]
    async fn host_check_is_cached_briefly() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ip -o -4 addr", Output::ok_with(IP_ON));
        let mesh = HostMesh::new(fake.clone());
        mesh.check(&cfg(P::None)).await;
        mesh.check(&cfg(P::None)).await;
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn turn_on_runs_provider_command() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "nordvpn set meshnet on",
            Output::ok_with("Meshnet is set to 'enabled' successfully."),
        );
        let mesh = HostMesh::new(fake.clone());
        let msg = mesh.turn_on(&cfg(P::Nordvpn)).await.unwrap();
        assert!(msg.contains("enabled"));
        assert_eq!(mesh.turn_on(&cfg(P::Zerotier)).await.unwrap_err(), "ZeroTier cannot be turned on from Yardbell. Run zerotier-cli join <network id> on this machine.");
    }

    #[tokio::test]
    async fn turn_on_reports_failure_output() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "tailscale up",
            Output::failed(
                1,
                "To authenticate, visit:\n\thttps://login.tailscale.com/a/abc",
            ),
        );
        let err = HostMesh::new(fake)
            .turn_on(&cfg(P::Tailscale))
            .await
            .unwrap_err();
        assert!(err.contains("https://login.tailscale.com/a/abc"), "{err}");
    }

    #[test]
    fn status_and_up_commands() {
        assert_eq!(status_argv(P::Nordvpn).unwrap(), ["nordvpn", "settings"]);
        assert_eq!(
            status_argv(P::Tailscale).unwrap(),
            ["tailscale", "status", "--json"]
        );
        assert_eq!(
            status_argv(P::Headscale).unwrap(),
            ["tailscale", "status", "--json"]
        );
        assert_eq!(
            status_argv(P::Netbird).unwrap(),
            ["netbird", "status", "--json"]
        );
        assert_eq!(status_argv(P::Zerotier).unwrap(), ["zerotier-cli", "info"]);
        assert!(status_argv(P::None).is_none());
        assert_eq!(
            up_argv(P::Nordvpn).unwrap(),
            ["nordvpn", "set", "meshnet", "on"]
        );
        assert_eq!(up_argv(P::Tailscale).unwrap(), ["tailscale", "up"]);
        assert_eq!(up_argv(P::Netbird).unwrap(), ["netbird", "up"]);
        assert!(up_argv(P::Zerotier).is_none());
        assert!(up_argv(P::None).is_none());
    }

    #[test]
    fn nordvpn_status() {
        let on = include_str!("../tests/fixtures/nordvpn_settings.txt");
        assert_eq!(parse_status(P::Nordvpn, on), Some(true));
        assert_eq!(
            parse_status(
                P::Nordvpn,
                &on.replace("Meshnet: enabled", "Meshnet: disabled")
            ),
            Some(false)
        );
        assert_eq!(parse_status(P::Nordvpn, "You are not logged in."), None);
    }

    #[test]
    fn tailscale_status() {
        let json = include_str!("../tests/fixtures/tailscale_status.json");
        assert_eq!(parse_status(P::Tailscale, json), Some(true));
        assert_eq!(
            parse_status(P::Headscale, &json.replace("\"Running\"", "\"Stopped\"")),
            Some(false)
        );
        assert_eq!(parse_status(P::Tailscale, "not json"), None);
    }

    #[test]
    fn netbird_status_and_peers() {
        let json = include_str!("../tests/fixtures/netbird_status.json");
        assert_eq!(parse_status(P::Netbird, json), Some(true));
        assert_eq!(
            parse_status(
                P::Netbird,
                &json.replace(
                    "\"connected\":true},\"signal\"",
                    "\"connected\":false},\"signal\""
                )
            ),
            Some(false)
        );
        let peers = parse_peers(P::Netbird, json).unwrap();
        assert_eq!(peers.len(), 2);
        let pro = peers.iter().find(|p| p.ip == "100.92.10.4").unwrap();
        assert_eq!(pro.hostname, "pro.netbird.cloud");
        assert!(pro.online);
        assert!(!peers.iter().find(|p| p.ip == "100.92.10.9").unwrap().online);
    }

    #[test]
    fn zerotier_status() {
        assert_eq!(
            parse_status(P::Zerotier, "200 info 8056c2e21c 1.14.0 ONLINE\n"),
            Some(true)
        );
        assert_eq!(
            parse_status(P::Zerotier, "200 info 8056c2e21c 1.14.0 OFFLINE\n"),
            Some(false)
        );
        assert!(parse_peers(P::Zerotier, "").is_none());
    }

    #[test]
    fn peers_for_nordvpn_and_tailscale() {
        assert!(!parse_peers(
            P::Nordvpn,
            include_str!("../tests/fixtures/nordvpn_peers.txt")
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            parse_peers(
                P::Headscale,
                include_str!("../tests/fixtures/tailscale_status.json")
            )
            .unwrap()
            .len(),
            2
        );
    }

    #[test]
    fn mesh_addresses() {
        assert!(is_mesh_ip("100.64.0.1"));
        assert!(is_mesh_ip("100.127.255.254"));
        assert!(!is_mesh_ip("100.128.0.1"));
        assert!(!is_mesh_ip("192.168.1.10"));
        assert!(!is_mesh_ip("100.63.1.1"));
        let ip_output = "1: lo    inet 127.0.0.1/8 scope host lo\n4: nordlynx    inet 100.96.1.16/10 scope global nordlynx\n";
        assert_eq!(addresses(ip_output), vec!["127.0.0.1", "100.96.1.16"]);
        let ifconfig =
            "utun4: flags=8051<UP>\n\tinet 100.80.12.34 --> 100.80.12.34 netmask 0xffc00000\n";
        assert_eq!(addresses(ifconfig), vec!["100.80.12.34"]);
    }

    #[test]
    fn hints() {
        assert_eq!(
            off_hint(P::Nordvpn, false),
            "Open the NordVPN app and turn on Meshnet."
        );
        assert_eq!(
            off_hint(P::Nordvpn, true),
            "Run nordvpn set meshnet on, or use Turn on."
        );
        assert_eq!(
            off_hint(P::Zerotier, true),
            "Run zerotier-cli join <network id> on this machine."
        );
        assert_eq!(
            off_hint(P::None, false),
            "Connect this machine to your mesh VPN."
        );
    }

    #[test]
    fn provider_labels() {
        assert_eq!(label(P::Nordvpn), "NordVPN Meshnet");
        assert_eq!(label(P::Headscale), "Headscale");
        assert_eq!(label(P::None), "Mesh VPN");
    }
}
