use chrono::{DateTime, Local};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Arc;

pub type Clock = Arc<dyn Fn() -> DateTime<Local> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum SshConfigError {
    #[error("name already used in ~/.ssh/config, pick another")]
    Exists,
    #[error("cannot update {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
}

pub struct SshConfig {
    path: PathBuf,
    clock: Clock,
}

impl SshConfig {
    pub fn new(path: PathBuf, clock: Clock) -> SshConfig {
        SshConfig { path, clock }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn has_host(&self, name: &str) -> std::io::Result<bool> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        };
        Ok(text.lines().any(|line| {
            let mut words = line.split_whitespace();
            let is_host = words.next().is_some_and(|w| w.eq_ignore_ascii_case("host"));
            is_host && words.any(|w| w.eq_ignore_ascii_case(name))
        }))
    }

    pub fn block(&self, name: &str, ip: &str, user: &str) -> String {
        format!(
            "Host {name}\n  HostName {ip}\n  User {user}\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n"
        )
    }

    pub fn append(&self, block: &str, name: &str) -> Result<PathBuf, SshConfigError> {
        let io = |source| SshConfigError::Io {
            path: self.path.display().to_string(),
            source,
        };
        if self.has_host(name).map_err(io)? {
            return Err(SshConfigError::Exists);
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        let stamp = (self.clock)().format("%Y%m%d%H%M%S");
        let backup = PathBuf::from(format!("{}.yardbell-{stamp}", self.path.display()));
        let existing = std::fs::read_to_string(&self.path).unwrap_or_default();
        let created = !self.path.exists();
        if !created {
            std::fs::copy(&self.path, &backup).map_err(io)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)
            .map_err(io)?;
        let sep = match existing.as_str() {
            "" => "",
            s if s.ends_with("\n\n") => "",
            s if s.ends_with('\n') => "\n",
            _ => "\n\n",
        };
        file.write_all(format!("{sep}{block}").as_bytes())
            .map_err(io)?;
        if created {
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                .map_err(io)?;
        }
        Ok(backup)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn frozen() -> Clock {
        Arc::new(|| {
            chrono::Local
                .with_ymd_and_hms(2026, 10, 18, 12, 0, 0)
                .unwrap()
        })
    }

    #[test]
    fn has_host_multi_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(
            &path,
            "Host *\n  ServerAliveInterval 30\n\nhost hp hp-alt\n  HostName 1.2.3.4\n",
        )
        .unwrap();
        let cfg = SshConfig::new(path, frozen());
        assert!(cfg.has_host("hp-alt").unwrap());
        assert!(cfg.has_host("HP").unwrap());
        assert!(!cfg.has_host("pro").unwrap());
        assert!(!cfg.has_host("*x").unwrap());
    }

    #[test]
    fn block_format() {
        let cfg = SshConfig::new(PathBuf::from("/nope"), frozen());
        assert_eq!(
            cfg.block("air", "100.1.1.1", "alex"),
            "Host air\n  HostName 100.1.1.1\n  User alex\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n"
        );
    }

    #[test]
    fn append_backs_up_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, "Host hp\n  HostName 1.2.3.4").unwrap();
        let cfg = SshConfig::new(path.clone(), frozen());
        let backup = cfg
            .append(&cfg.block("air", "100.1.1.1", "k"), "air")
            .unwrap();
        assert_eq!(backup, dir.path().join("config.yardbell-20261018120000"));
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "Host hp\n  HostName 1.2.3.4"
        );
        let now = std::fs::read_to_string(&path).unwrap();
        assert!(
            now.starts_with("Host hp\n  HostName 1.2.3.4\n\nHost air\n"),
            "{now:?}"
        );
    }

    #[test]
    fn refuses_existing_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, "Host air\n").unwrap();
        let cfg = SshConfig::new(path.clone(), frozen());
        assert!(cfg.append(&cfg.block("air", "1", "k"), "air").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Host air\n");
    }

    #[test]
    fn append_creates_missing_file_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh").join("config");
        let cfg = SshConfig::new(path.clone(), frozen());
        cfg.append(&cfg.block("air", "1", "k"), "air").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
