use super::*;
use crate::shell::Output;
use crate::testing::FakeRunner;
use chrono::TimeZone;

struct Rig {
    ob: Onboarding,
    fake: Arc<FakeRunner>,
    dir: tempfile::TempDir,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let cfg_path = dir.path().join("yardbell.yml");
    std::fs::copy(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/yardbell.yml"),
        &cfg_path,
    )
    .unwrap();
    let fake = Arc::new(FakeRunner::default());
    let ssh = Ssh::new(dir.path().join("state"));
    let tunnels = Arc::new(Tunnels::new(
        fake.clone(),
        vec!["127.0.0.1".into()],
        dir.path().join("logs"),
        Arc::new(Instant::now),
    ));
    let ssh_config = SshConfig::new(
        dir.path().join("ssh_config"),
        Arc::new(|| {
            chrono::Local
                .with_ymd_and_hms(2026, 10, 18, 12, 0, 0)
                .unwrap()
        }),
    );
    let ob = Onboarding::new(
        fake.clone(),
        ssh,
        cfg_path,
        ssh_config,
        tunnels,
        State::default(),
        dir.path().join("id_ed25519"),
    );
    Rig { ob, fake, dir }
}

#[tokio::test]
async fn peers_filters_known_ips() {
    let r = rig();
    let text = include_str!("../../tests/fixtures/nordvpn_peers.txt")
        .replace("100.80.12.34", "100.64.0.11");
    r.fake
        .stub("nordvpn meshnet peer list", Output::ok_with(&text));
    let step = r.ob.peers().await;
    assert!(step.ok, "{}", step.message);
    let ips: Vec<String> = step.data["peers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["ip"].as_str().unwrap().to_string())
        .collect();
    assert!(!ips.contains(&"100.64.0.11".to_string()));
    assert_eq!(ips.len(), 3);
}

#[tokio::test]
async fn peers_falls_back_to_tailscale() {
    let r = rig();
    r.fake.stub(
        "tailscale status --json",
        Output::ok_with(include_str!("../../tests/fixtures/tailscale_status.json")),
    );
    let step = r.ob.peers().await;
    assert!(step.ok);
    assert_eq!(
        step.data["peers"].as_array().unwrap().len(),
        0,
        "both tailscale peers use configured IPs"
    );
}

#[tokio::test]
async fn peers_parse_failure_message() {
    let r = rig();
    let step = r.ob.peers().await;
    assert!(!step.ok);
    assert_eq!(
        step.message,
        "could not read mesh peers, enter the IP manually"
    );
}

#[tokio::test]
async fn reachable_offline() {
    let r = rig();
    r.fake.stub("ping", Output::failed(1, ""));
    let step = r.ob.reachable("100.1.1.1").await;
    assert!(!step.ok);
    assert_eq!(step.message, "peer offline");
}

#[tokio::test]
async fn reachable_port_closed() {
    let r = rig();
    r.fake.stub("ping", Output::ok_with(""));
    r.fake.stub("/dev/tcp/100.1.1.1/22", Output::failed(1, ""));
    let step = r.ob.reachable("100.1.1.1").await;
    assert!(!step.ok);
    assert_eq!(
        step.message,
        "port 22 closed: enable Remote Login / sshd on the machine"
    );
}

#[tokio::test]
async fn reachable_ok() {
    let r = rig();
    r.fake.stub("ping", Output::ok_with(""));
    r.fake.stub("/dev/tcp/100.1.1.1/22", Output::ok_with(""));
    assert!(r.ob.reachable("100.1.1.1").await.ok);
}

#[tokio::test]
async fn key_auth_ok() {
    let r = rig();
    r.fake.stub("alex@100.1.1.1 true", Output::ok_with(""));
    let step = r.ob.key_auth("alex", "100.1.1.1").await;
    assert!(step.ok, "{}", step.message);
}

#[tokio::test]
async fn key_auth_fail_returns_copy_id_terminal() {
    let r = rig();
    std::fs::write(r.dir.path().join("id_ed25519"), "k").unwrap();
    r.fake.stub(
        "alex@100.1.1.1 true",
        Output::failed(
            255,
            "alex@100.1.1.1: Permission denied (publickey,password).",
        ),
    );
    let step = r.ob.key_auth("alex", "100.1.1.1").await;
    assert!(!step.ok);
    let url = step.data["terminal_url"].as_str().unwrap();
    let token = url.strip_prefix("/term/_onboarding/").unwrap();
    let argv = r.ob.take_terminal(token).unwrap();
    assert_eq!(argv[0], "ssh-copy-id");
    assert_eq!(argv.last().unwrap(), "alex@100.1.1.1");
    assert!(argv[2].ends_with("id_ed25519.pub"));
    assert!(
        r.ob.take_terminal(token).is_none(),
        "token must be single use"
    );
    assert!(r.fake.calls().iter().all(|c| c[0] != "ssh-keygen"));
}

#[tokio::test]
async fn key_auth_generates_missing_key() {
    let r = rig();
    r.fake.stub(
        "alex@100.1.1.1 true",
        Output::failed(
            255,
            "alex@100.1.1.1: Permission denied (publickey,password).",
        ),
    );
    r.fake.stub("ssh-keygen", Output::ok_with(""));
    r.ob.key_auth("alex", "100.1.1.1").await;
    assert!(r.fake.calls().iter().any(|c| c[0] == "ssh-keygen"));
}

#[tokio::test]
async fn ssh_config_preview_and_write() {
    let r = rig();
    let preview = r.ob.ssh_config_preview("air", "alex", "100.1.1.1").await;
    assert!(preview.ok);
    assert!(preview.data["block"]
        .as_str()
        .unwrap()
        .contains("HostName 100.1.1.1"));
    let write = r.ob.write_ssh_config("air", "alex", "100.1.1.1").await;
    assert!(write.ok, "{}", write.message);
    let again = r.ob.ssh_config_preview("air", "alex", "100.1.1.1").await;
    assert!(!again.ok);
    assert_eq!(
        again.message,
        "name already used in ~/.ssh/config, pick another"
    );
}

#[tokio::test]
async fn preview_rejects_name_used_in_yardbell() {
    let r = rig();
    let step = r.ob.ssh_config_preview("hp", "alex", "100.1.1.1").await;
    assert!(!step.ok);
    assert_eq!(step.message, "name already used in Yardbell, pick another");
}

#[tokio::test]
async fn detect_missing_tools_hints() {
    let r = rig();
    r.fake.stub(
        "uname",
        Output::ok_with("Linux\nhas git\nhas docker\npacman\nroot ~/code/acme\n"),
    );
    let step = r.ob.detect("air").await;
    assert!(step.ok, "{}", step.message);
    assert_eq!(step.data["os"], "Linux");
    assert_eq!(step.data["root"], "~/code/acme");
    let missing = step.data["missing"].as_array().unwrap();
    let tmux = missing.iter().find(|m| m["tool"] == "tmux").unwrap();
    assert_eq!(tmux["hint"], "sudo pacman -S tmux");
    let agent = missing.iter().find(|m| m["tool"] == "an AI agent").unwrap();
    assert!(agent["hint"].as_str().unwrap().contains("claude-code"));
    assert_eq!(step.data["agents"], serde_json::json!([]));
    let call = r.fake.calls().pop().unwrap();
    assert!(
        call.last()
            .unwrap()
            .contains(r#"; exec "${SHELL:-/bin/sh}" -lic '"#),
        "{call:?}"
    );
}

#[tokio::test]
async fn detect_lists_installed_agents() {
    let r = rig();
    r.fake.stub(
        "uname",
        Output::ok_with("Linux\nhas tmux\nhas git\nhas docker\nagent codex\nagent goose\n"),
    );
    let step = r.ob.detect("air").await;
    assert_eq!(step.data["agents"], serde_json::json!(["codex", "goose"]));
    assert_eq!(step.data["missing"], serde_json::json!([]));
    assert_eq!(step.message, "Linux, all tools found, agents: codex, goose");
    let call = r.fake.calls().pop().unwrap();
    assert!(call.last().unwrap().contains("agent goose"), "{call:?}");
}

#[tokio::test]
async fn detect_hints_for_mac_and_apt() {
    let r = rig();
    r.fake.stub("uname", Output::ok_with("Darwin\n"));
    let step = r.ob.detect("air").await;
    let tmux = step.data["missing"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["tool"] == "tmux")
        .unwrap()
        .clone();
    assert_eq!(tmux["hint"], "brew install tmux");
    assert!(step.data["root"].is_null());
    assert_eq!(hint("Linux", false, "git"), "sudo apt install git");
}

#[test]
fn next_prefix_skips_used() {
    let r = rig();
    let cfg = Config::load(&r.ob.cfg_path).unwrap();
    assert_eq!(next_prefix(&cfg).unwrap(), 3);
}

#[test]
fn next_prefix_full_errors() {
    let r = rig();
    let mut cfg = Config::load(&r.ob.cfg_path).unwrap();
    for p in 3..=6u8 {
        cfg.machines.push(Machine {
            name: format!("m{p}"),
            ssh: None,
            mesh_ip: None,
            port_prefix: Some(p),
            root: "/r".into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        });
    }
    assert_eq!(
        next_prefix(&cfg).unwrap_err(),
        "all 6 port prefixes are in use"
    );
}

#[tokio::test]
async fn save_appends_machine() {
    let r = rig();
    let step = r.ob.save("air", "100.1.1.1", "~/code/acme").await;
    assert!(step.ok, "{}", step.message);
    let cfg = Config::load(&r.ob.cfg_path).unwrap();
    let air = cfg.machine("air").unwrap();
    assert_eq!(air.port_prefix, Some(3));
    assert_eq!(air.ssh.as_deref(), Some("air"));
    assert_eq!(air.mesh_ip.as_deref(), Some("100.1.1.1"));
}

#[tokio::test]
async fn remove_kills_tunnel_and_leaves_ssh_config() {
    let r = rig();
    std::fs::write(r.dir.path().join("ssh_config"), "Host hp\n").unwrap();
    let cfg = Config::load(&r.ob.cfg_path).unwrap();
    r.ob.tunnels.sync(
        cfg.machine("hp").unwrap(),
        &[crate::snapshot::Port {
            service: "rails".into(),
            remote_port: 3020,
            listening: true,
        }],
    );
    let step = r.ob.remove("hp").await;
    assert!(step.ok, "{}", step.message);
    assert_eq!(
        step.message,
        "removed from Yardbell, ~/.ssh/config left unchanged"
    );
    assert!(Config::load(&r.ob.cfg_path)
        .unwrap()
        .machine("hp")
        .is_none());
    assert!(r.fake.spawned().iter().all(|s| !s.2));
    assert_eq!(
        std::fs::read_to_string(r.dir.path().join("ssh_config")).unwrap(),
        "Host hp\n"
    );
}

#[tokio::test]
async fn remove_refuses_host_machine() {
    let r = rig();
    let step = r.ob.remove("mini").await;
    assert!(!step.ok);
}

#[tokio::test]
async fn rejects_unsafe_inputs_before_running_anything() {
    let r = rig();
    let bad_ip = r.ob.reachable("127.0.0.1 ;touch /tmp/x;#").await;
    assert!(!bad_ip.ok);
    assert_eq!(bad_ip.message, "invalid IP or hostname");
    let bad_user = r.ob.key_auth("-oProxyCommand=x", "100.1.1.1").await;
    assert!(!bad_user.ok);
    assert_eq!(bad_user.message, "invalid username");
    let bad_name = r.ob.detect("-oX").await;
    assert!(!bad_name.ok);
    assert_eq!(bad_name.message, "name must use only a-z, 0-9 and -");
    let newline =
        r.ob.write_ssh_config("air", "k\nProxyCommand x", "100.1.1.1")
            .await;
    assert!(!newline.ok);
    assert!(!r.dir.path().join("ssh_config").exists());
    let bad_save = r.ob.save("air", "1.1.1.1\nx", "~/p").await;
    assert!(!bad_save.ok);
    assert!(r.fake.calls().is_empty(), "{:?}", r.fake.calls());
}

#[test]
fn accepts_mesh_hostnames() {
    assert!(valid_host("studio-mini"));
    assert!(valid_host("user-andes.nord"));
    assert!(valid_host("100.80.12.34"));
    assert!(!valid_host("-oProxyCommand=x"));
    assert!(!valid_host(""));
    assert!(valid_user("alex"));
    assert!(!valid_user("root;id"));
}

#[tokio::test]
async fn key_auth_explains_unknown_host_key() {
    let r = rig();
    std::fs::write(r.dir.path().join("id_ed25519"), "k").unwrap();
    r.fake.stub(
        "alex@100.1.1.1 true",
        Output::failed(255, "Host key verification failed.\r\n"),
    );
    let step = r.ob.key_auth("alex", "100.1.1.1").await;
    assert!(!step.ok);
    assert_eq!(
        step.message,
        "first connection to this machine: confirm its fingerprint (type yes) and enter the password if asked"
    );
    assert!(step.data["terminal_url"].is_string());
}

#[tokio::test]
async fn key_auth_shows_other_ssh_errors_verbatim() {
    let r = rig();
    std::fs::write(r.dir.path().join("id_ed25519"), "k").unwrap();
    r.fake.stub(
        "alex@100.1.1.1 true",
        Output::failed(255, "ControlPath too long ('/x/cm/abc' >= 108 bytes)\n"),
    );
    let step = r.ob.key_auth("alex", "100.1.1.1").await;
    assert!(!step.ok);
    assert_eq!(
        step.message,
        "ssh failed: ControlPath too long ('/x/cm/abc' >= 108 bytes)"
    );
    assert!(
        step.data.is_null(),
        "no password terminal for a non-auth error"
    );
}

fn set_mesh(r: &Rig, mesh: crate::config::MeshProvider) {
    let mut cfg = Config::load(&r.ob.cfg_path).unwrap();
    cfg.mesh = mesh;
    cfg.save(&r.ob.cfg_path).unwrap();
}

#[tokio::test]
async fn peers_use_configured_netbird() {
    let r = rig();
    set_mesh(&r, crate::config::MeshProvider::Netbird);
    r.fake.stub(
        "netbird status --json",
        Output::ok_with(include_str!("../../tests/fixtures/netbird_status.json")),
    );
    r.fake.stub(
        "nordvpn",
        Output::ok_with(include_str!("../../tests/fixtures/nordvpn_peers.txt")),
    );
    let step = r.ob.peers().await;
    assert!(step.ok, "{}", step.message);
    let ips: Vec<&str> = step.data["peers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["ip"].as_str().unwrap())
        .collect();
    assert_eq!(ips, vec!["100.92.10.4", "100.92.10.9"]);
    assert!(r.fake.calls().iter().all(|c| c[0] != "nordvpn"));
}

#[tokio::test]
async fn peers_nordvpn_app_without_cli_explains() {
    let r = rig();
    set_mesh(&r, crate::config::MeshProvider::Nordvpn);
    let step = r.ob.peers().await;
    assert!(!step.ok);
    assert_eq!(
        step.message,
        "NordVPN has no command line on this machine (the macOS app), so peers cannot be listed. Copy the IP from the Meshnet tab in the NordVPN app."
    );
}

#[tokio::test]
async fn peers_zerotier_explains() {
    let r = rig();
    set_mesh(&r, crate::config::MeshProvider::Zerotier);
    let step = r.ob.peers().await;
    assert!(!step.ok);
    assert_eq!(
        step.message,
        "ZeroTier's command line does not list peer addresses. Copy the IP from ZeroTier Central."
    );
}
