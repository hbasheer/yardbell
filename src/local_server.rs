use crate::config::{expand_tilde, Config, Machine};
use crate::mesh::Detected;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use std::path::Path;

const ROOTS: [&str; 4] = ["~/code", "~/Projects", "~/src", "~/dev"];
const TEMPLATE: &str = "port: 4000\n\
poll_seconds: 5\n\
mesh: none\n\
ticket_pattern: '^[a-z]+-\\d+'\n\
forward_services: [web, rails, api, mailpit]\n\
workspaces: ['*', '*/*']\n\
machines: []\n";

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum Status {
    Missing,
    NoPasscode { port: u16 },
    Ready { port: u16 },
    Broken { error: String },
}

pub fn status(path: &Path) -> Status {
    if !path.exists() {
        return Status::Missing;
    }
    match Config::load(path) {
        Ok(cfg) if cfg.passcode_hash.is_some() => Status::Ready { port: cfg.port },
        Ok(cfg) => Status::NoPasscode { port: cfg.port },
        Err(e) => Status::Broken {
            error: e.to_string(),
        },
    }
}

pub fn machine_name(hostname: &str) -> String {
    let short = hostname.split('.').next().unwrap_or_default();
    let name: String = short
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let name = name.trim_matches('-').to_string();
    if name.is_empty() {
        "this-machine".into()
    } else {
        name
    }
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

fn project_root() -> String {
    ROOTS
        .iter()
        .find(|r| expand_tilde(r).is_dir())
        .map_or("~".into(), |r| r.to_string())
}

pub fn set_up(path: &Path, passcode: &str, mesh: Detected) -> Result<u16, String> {
    if passcode.chars().count() < 6 {
        return Err("use at least 6 characters".into());
    }
    let mut cfg =
        match status(path) {
            Status::Ready { .. } => return Err(
                "a Yardbell server is already set up on this machine, sign in with its passcode"
                    .into(),
            ),
            Status::Broken { error } => return Err(error),
            Status::NoPasscode { .. } => Config::load(path).map_err(|e| e.to_string())?,
            Status::Missing => new_config(&hostname(), &project_root(), mesh)?,
        };
    let mut key = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut key);
    cfg.passcode_hash = Some(crate::auth::hash(passcode));
    cfg.cookie_key = Some(base64::engine::general_purpose::STANDARD.encode(key));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    cfg.save(path).map_err(|e| e.to_string())?;
    Ok(cfg.port)
}

fn new_config(hostname: &str, root: &str, mesh: Detected) -> Result<Config, String> {
    let mut cfg: Config = serde_yaml::from_str(TEMPLATE).map_err(|e| e.to_string())?;
    cfg.mesh = mesh.provider;
    cfg.machines.push(Machine {
        name: machine_name(hostname),
        ssh: None,
        mesh_ip: mesh.ip,
        port_prefix: None,
        root: root.into(),
        local: true,
        workspaces: None,
        mesh: None,
        recent: Vec::new(),
    });
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nordvpn() -> Detected {
        Detected {
            provider: crate::config::MeshProvider::Nordvpn,
            ip: Some("100.64.0.10".into()),
        }
    }

    #[test]
    fn machine_names_come_from_the_hostname() {
        assert_eq!(
            machine_name("Hassans-MacBook-Pro.local"),
            "hassans-macbook-pro"
        );
        assert_eq!(machine_name("hp"), "hp");
        assert_eq!(machine_name("my_box"), "my-box");
        assert_eq!(machine_name(""), "this-machine");
    }

    #[test]
    fn set_up_writes_a_local_config_with_the_passcode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell").join("yardbell.yml");
        assert_eq!(status(&path), Status::Missing);
        assert_eq!(
            set_up(&path, "short", Detected::default()).unwrap_err(),
            "use at least 6 characters"
        );
        assert_eq!(set_up(&path, "secret-1", nordvpn()).unwrap(), 4000);
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.machines.len(), 1);
        assert!(cfg.machines[0].local);
        assert_eq!(cfg.forward_services, ["web", "rails", "api", "mailpit"]);
        assert!(cfg.ticket_regex().is_some());
        assert_eq!(cfg.mesh, crate::config::MeshProvider::Nordvpn);
        assert_eq!(cfg.machines[0].mesh_ip.as_deref(), Some("100.64.0.10"));
        assert_eq!(cfg.bind_addresses(), ["127.0.0.1", "100.64.0.10"]);
        assert!(
            crate::auth::Auth::new(
                cfg.passcode_hash.clone().unwrap(),
                std::sync::Arc::new(std::time::Instant::now)
            )
            .verify("secret-1", std::net::IpAddr::from([127, 0, 0, 1]))
                == crate::auth::Verdict::Ok
        );
        assert_eq!(status(&path), Status::Ready { port: 4000 });
        assert!(set_up(&path, "secret-2", Detected::default())
            .unwrap_err()
            .contains("already set up"));
    }

    #[test]
    fn set_up_keeps_an_existing_config_that_has_no_passcode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        std::fs::write(
            &path,
            "port: 4100\nmachines:\n  - {name: studio, local: true, root: ~/work}\n",
        )
        .unwrap();
        assert_eq!(status(&path), Status::NoPasscode { port: 4100 });
        assert_eq!(set_up(&path, "secret-1", nordvpn()).unwrap(), 4100);
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.machines[0].name, "studio");
        assert_eq!(
            cfg.mesh,
            crate::config::MeshProvider::None,
            "an existing config keeps its VPN"
        );
        assert!(cfg.passcode_hash.is_some());
    }

    #[test]
    fn a_broken_config_is_reported_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        std::fs::write(&path, "port: [").unwrap();
        assert!(matches!(status(&path), Status::Broken { .. }));
        assert!(set_up(&path, "secret-1", Detected::default()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "port: [");
    }
}
