use rand::distributions::Alphanumeric;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const TOKEN_PREFIX: &str = "ybd_";
const TOKEN_CHARS: usize = 40;
const NAME_MAX: usize = 60;
const SEEN_WRITE_INTERVAL: u64 = 3600;

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Device {
    id: String,
    name: String,
    token_sha256: String,
    paired_at: u64,
    last_seen: Option<u64>,
    #[serde(skip)]
    persisted_seen: Option<u64>,
}

impl Device {
    fn view(&self) -> DeviceView {
        DeviceView {
            id: self.id.clone(),
            name: self.name.clone(),
            paired_at: self.paired_at,
            last_seen: self.last_seen,
        }
    }
}

pub struct Devices {
    path: PathBuf,
    list: Mutex<Vec<Device>>,
    revocations: tokio::sync::watch::Sender<u64>,
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn clean_name(name: &str) -> String {
    let trimmed: String = name.trim().chars().take(NAME_MAX).collect();
    let trimmed = trimmed.trim_end().to_string();
    if trimmed.is_empty() {
        "Phone".to_string()
    } else {
        trimmed
    }
}

fn write_atomic(path: &Path, devices: &[Device]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(devices).map_err(|e| format!("encode devices: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("protect {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

impl Devices {
    pub fn load(path: PathBuf) -> Devices {
        let mut list: Vec<Device> = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                tracing::warn!(path = %path.display(), error = %e, "devices file unreadable, starting empty");
                Vec::new()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "devices file unreadable, starting empty");
                Vec::new()
            }
        };
        for device in &mut list {
            device.persisted_seen = device.last_seen;
        }
        Devices {
            path,
            list: Mutex::new(list),
            revocations: tokio::sync::watch::Sender::new(0),
        }
    }

    pub fn issue(&self, name: &str, now: u64) -> Result<(DeviceView, String), String> {
        let mut rng = rand::thread_rng();
        let suffix: String = (&mut rng)
            .sample_iter(Alphanumeric)
            .take(TOKEN_CHARS)
            .map(char::from)
            .collect();
        let token = format!("{TOKEN_PREFIX}{suffix}");
        let mut id_bytes = [0u8; 8];
        rng.fill_bytes(&mut id_bytes);
        let device = Device {
            id: id_bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            name: clean_name(name),
            token_sha256: hash_token(&token),
            paired_at: now,
            last_seen: None,
            persisted_seen: None,
        };
        let view = device.view();
        let mut list = self.list.lock().unwrap();
        list.push(device);
        if let Err(e) = write_atomic(&self.path, &list) {
            list.pop();
            return Err(e);
        }
        Ok((view, token))
    }

    pub fn check(&self, token: &str, now: u64) -> Option<String> {
        let digest = hash_token(token);
        let mut list = self.list.lock().unwrap();
        let index = list
            .iter()
            .position(|d| constant_time_eq(&d.token_sha256, &digest))?;
        let id = list[index].id.clone();
        list[index].last_seen = Some(now);
        let due = match list[index].persisted_seen {
            Some(seen) => now.saturating_sub(seen) >= SEEN_WRITE_INTERVAL,
            None => true,
        };
        if due {
            match write_atomic(&self.path, &list) {
                Ok(()) => list[index].persisted_seen = Some(now),
                Err(e) => tracing::warn!(error = %e, "could not record device last seen"),
            }
        }
        Some(id)
    }

    pub fn list(&self) -> Vec<DeviceView> {
        let list = self.list.lock().unwrap();
        list.iter().rev().map(Device::view).collect()
    }

    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let mut list = self.list.lock().unwrap();
        let Some(index) = list.iter().position(|d| d.id == id) else {
            return Ok(false);
        };
        let removed = list.remove(index);
        if let Err(e) = write_atomic(&self.path, &list) {
            list.insert(index, removed);
            return Err(e);
        }
        drop(list);
        self.revocations.send_modify(|count| *count += 1);
        Ok(true)
    }

    fn is_paired(&self, id: &str) -> bool {
        self.list.lock().unwrap().iter().any(|d| d.id == id)
    }

    pub fn until_revoked(
        self: &Arc<Self>,
        id: String,
    ) -> impl Future<Output = ()> + Send + 'static {
        let devices = self.clone();
        let mut revocations = self.revocations.subscribe();
        async move {
            while devices.is_paired(&id) {
                if revocations.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, PathBuf, Devices) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let devices = Devices::load(path.clone());
        (dir, path, devices)
    }

    #[test]
    fn issued_token_checks_and_survives_reload() {
        let (_dir, path, devices) = store();
        let (view, token) = devices.issue("Pixel", 100).unwrap();
        assert!(token.starts_with("ybd_"));
        assert_eq!(token.len(), 44);
        assert_eq!(devices.check(&token, 101), Some(view.id.clone()));
        let reloaded = Devices::load(path);
        assert_eq!(reloaded.check(&token, 102), Some(view.id));
    }

    #[test]
    fn wrong_token_is_refused() {
        let (_dir, _path, devices) = store();
        devices.issue("Pixel", 100).unwrap();
        assert_eq!(devices.check("ybd_nope", 101), None);
    }

    #[test]
    fn revoke_ends_the_token() {
        let (_dir, _path, devices) = store();
        let (view, token) = devices.issue("Pixel", 100).unwrap();
        assert_eq!(devices.revoke(&view.id), Ok(true));
        assert_eq!(devices.check(&token, 101), None);
        assert_eq!(devices.revoke(&view.id), Ok(false));
    }

    #[test]
    fn file_holds_no_plain_token() {
        let (_dir, path, devices) = store();
        let (_, token) = devices.issue("Pixel", 100).unwrap();
        assert!(!std::fs::read_to_string(path).unwrap().contains(&token));
    }

    #[test]
    fn names_are_trimmed_and_capped() {
        let (_dir, _path, devices) = store();
        assert_eq!(devices.issue("  ", 1).unwrap().0.name, "Phone");
        assert_eq!(devices.issue(&"a".repeat(100), 1).unwrap().0.name.len(), 60);
        assert_eq!(devices.issue("  Pixel  ", 1).unwrap().0.name, "Pixel");
    }

    #[test]
    fn last_seen_is_written_at_most_hourly() {
        let (_dir, path, devices) = store();
        let (_, token) = devices.issue("Pixel", 1).unwrap();
        let on_disk = || -> Option<u64> {
            let text = std::fs::read_to_string(&path).unwrap();
            let rows: serde_json::Value = serde_json::from_str(&text).unwrap();
            rows[0]["last_seen"].as_u64()
        };
        devices.check(&token, 1000).unwrap();
        assert_eq!(on_disk(), Some(1000));
        devices.check(&token, 1010).unwrap();
        assert_eq!(on_disk(), Some(1000));
        devices.check(&token, 4601).unwrap();
        assert_eq!(on_disk(), Some(4601));
    }

    #[cfg(unix)]
    #[test]
    fn file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, path, devices) = store();
        devices.issue("Pixel", 1).unwrap();
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
