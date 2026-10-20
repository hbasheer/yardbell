use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Peer {
    pub hostname: String,
    pub nickname: Option<String>,
    pub ip: String,
    pub online: bool,
    pub os: String,
}

impl Peer {
    pub fn suggested_name(&self) -> String {
        let base = self.nickname.clone().unwrap_or_else(|| {
            self.hostname
                .split('.')
                .next()
                .unwrap_or(&self.hostname)
                .to_string()
        });
        base.to_lowercase()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    }
}

pub fn parse_nordvpn(text: &str) -> Option<Vec<Peer>> {
    let mut peers = Vec::new();
    let mut saw_device = false;
    for block in text.split("\n\n") {
        let mut hostname = None;
        let mut nickname = None;
        let mut ip = String::new();
        let mut online = false;
        let mut os = String::new();
        let mut this_device = false;
        for line in block.lines() {
            let line = line.trim();
            if line == "This device:" {
                this_device = true;
                saw_device = true;
                continue;
            }
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match key {
                "Hostname" => hostname = Some(value.to_string()),
                "Nickname" if value != "-" && !value.is_empty() => {
                    nickname = Some(value.to_string())
                }
                "IP" => ip = value.to_string(),
                "Status" => online = value == "connected",
                "OS" => os = value.to_string(),
                _ => {}
            }
        }
        let Some(hostname) = hostname else {
            continue;
        };
        if this_device || ip.is_empty() {
            continue;
        }
        peers.push(Peer {
            hostname,
            nickname,
            ip,
            online,
            os,
        });
    }
    if !saw_device && peers.is_empty() {
        return None;
    }
    Some(peers)
}

pub fn parse_tailscale(json: &str) -> Option<Vec<Peer>> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let peers = v.get("Peer")?.as_object()?;
    Some(
        peers
            .values()
            .filter_map(|p| {
                let ip = p["TailscaleIPs"]
                    .as_array()?
                    .iter()
                    .filter_map(|i| i.as_str())
                    .find(|i| !i.contains(':'))?;
                Some(Peer {
                    hostname: p["HostName"].as_str().unwrap_or_default().to_string(),
                    nickname: None,
                    ip: ip.to_string(),
                    online: p["Online"].as_bool().unwrap_or(false),
                    os: p["OS"].as_str().unwrap_or_default().to_string(),
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_nordvpn_fixture() {
        let peers = parse_nordvpn(include_str!("../../tests/fixtures/nordvpn_peers.txt")).unwrap();
        assert!(peers.iter().all(|p| !p.ip.is_empty()));
        assert!(
            !peers.iter().any(|p| p.ip == "100.96.1.16"),
            "this device must be skipped"
        );
        let mini = peers.iter().find(|p| p.ip == "100.80.12.34").unwrap();
        assert_eq!(mini.hostname, "user-andes.nord");
        assert_eq!(mini.nickname.as_deref(), Some("studio-mini"));
        assert!(mini.online);
        assert_eq!(mini.os, "macos");
        let atlas = peers
            .iter()
            .find(|p| p.hostname == "user-atlas.nord")
            .unwrap();
        assert!(!atlas.online);
        assert_eq!(peers.len(), 4);
    }

    #[test]
    fn parse_tailscale_fixture() {
        let peers =
            parse_tailscale(include_str!("../../tests/fixtures/tailscale_status.json")).unwrap();
        let mut ips: Vec<&str> = peers.iter().map(|p| p.ip.as_str()).collect();
        ips.sort();
        assert_eq!(ips, vec!["100.64.0.11", "100.64.0.12"]);
        assert!(peers.iter().find(|p| p.hostname == "hp").unwrap().online);
    }

    #[test]
    fn parse_garbage_none() {
        assert!(parse_nordvpn("You are not logged in.").is_none());
        assert!(parse_tailscale("nope").is_none());
    }

    #[test]
    fn suggested_name() {
        let p = Peer {
            hostname: "user-andes.nord".into(),
            nickname: Some("studio-mini".into()),
            ip: "1".into(),
            online: true,
            os: "macos".into(),
        };
        assert_eq!(p.suggested_name(), "studio-mini");
        let q = Peer {
            nickname: None,
            ..p
        };
        assert_eq!(q.suggested_name(), "user-andes");
    }
}
