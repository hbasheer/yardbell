use crate::config::PRIVATE_FILE;
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const FILE_NAME: &str = "secrets.yml";
pub const PRIVATE_DIR: u32 = 0o700;
pub const MCP_TOKEN: &str = "yardbell-mcp-token";
pub const COOKIE_KEY: &str = "yardbell-cookie-key";
const OWN: [&str; 2] = [MCP_TOKEN, COOKIE_KEY];
const OPEN: &str = "${secret:";
const NAME_MAX: usize = 64;
const VALUE_MAX: usize = 16 * 1024;

const HEADER: &str = "# Yardbell's secrets. yardbell.yml refers to them as ${secret:NAME}.\n\
# Keep this file private (mode 600). The MCP servers section of Settings edits it.\n";

static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z0-9_-]+$").expect("static regex"));

pub fn path_for(cfg_path: &Path) -> PathBuf {
    cfg_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FILE_NAME)
}

pub fn reference(name: &str) -> String {
    format!("{OPEN}{name}}}")
}

pub fn is_own(name: &str) -> bool {
    OWN.contains(&name)
}

// Yardbell's own stored values: hidden from the Secrets list, and written only by Yardbell.
pub fn is_reserved(name: &str) -> bool {
    name.starts_with("mcp_oauth_") || name.starts_with("pipeline_hook_")
}

pub fn check_name(name: &str) -> Result<(), String> {
    if name.len() > NAME_MAX || !NAME_RE.is_match(name) {
        return Err(format!(
            "secret name {name:?} must be 1 to {NAME_MAX} letters, digits, - and _"
        ));
    }
    Ok(())
}

pub fn has_reference(text: &str) -> bool {
    text.contains(OPEN)
}

// Every ${secret:NAME} in text, in order. A reference that is not closed or has a bad name is an
// error, so a typo never reaches a server as literal text.
pub fn references(text: &str) -> Result<Vec<&str>, String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(OPEN) {
        let after = &rest[at + OPEN.len()..];
        let Some(end) = after.find('}') else {
            return Err("a ${secret: reference is not closed with }".into());
        };
        let name = &after[..end];
        check_name(name).map_err(|e| format!("in a ${{secret:...}} reference, {e}"))?;
        names.push(name);
        rest = &after[end + 1..];
    }
    Ok(names)
}

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("the secret {0} is not set")]
    Missing(String),
    #[error("cannot read {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    // serde_yaml's own message can quote the text it choked on, which may be a secret.
    #[error("cannot parse {path}{at}: each entry needs to look like NAME: value")]
    Parse { path: String, at: String },
    #[error("{0}")]
    Invalid(String),
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Stored {
    Full {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated: Option<String>,
    },
    Plain(String),
}

#[derive(Clone, PartialEq)]
struct Entry {
    value: String,
    updated: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Info {
    pub name: String,
    pub updated: Option<String>,
}

#[derive(Clone)]
pub struct Secrets {
    path: PathBuf,
    entries: BTreeMap<String, Entry>,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secrets")
            .field("path", &self.path)
            .field("names", &self.entries.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl Secrets {
    pub fn load(path: &Path) -> Result<Secrets, SecretsError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(source) => {
                return Err(SecretsError::Read {
                    path: path.display().to_string(),
                    source,
                })
            }
        };
        let stored: Option<BTreeMap<String, Stored>> =
            serde_yaml::from_str(&text).map_err(|e| SecretsError::Parse {
                path: path.display().to_string(),
                at: e
                    .location()
                    .map(|l| format!(" at line {}", l.line()))
                    .unwrap_or_default(),
            })?;
        let mut entries = BTreeMap::new();
        for (name, stored) in stored.unwrap_or_default() {
            check_name(&name)
                .map_err(|e| SecretsError::Invalid(format!("{e}, in {}", path.display())))?;
            let entry = match stored {
                Stored::Full { value, updated } => Entry { value, updated },
                Stored::Plain(value) => Entry {
                    value,
                    updated: None,
                },
            };
            entries.insert(name, entry);
        }
        Ok(Secrets {
            path: path.to_path_buf(),
            entries,
        })
    }

    pub fn for_config(cfg_path: &Path) -> Result<Secrets, SecretsError> {
        Secrets::load(&path_for(cfg_path))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(name)
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries.get(name).map(|e| e.value.as_str())
    }

    pub fn values(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|(name, e)| (name.as_str(), e.value.as_str()))
    }

    pub fn list(&self) -> Vec<Info> {
        self.entries
            .iter()
            .map(|(name, e)| Info {
                name: name.clone(),
                updated: e.updated.clone(),
            })
            .collect()
    }

    pub fn set(&mut self, name: &str, value: &str, now: DateTime<Utc>) -> Result<(), String> {
        check_name(name)?;
        if value.is_empty() {
            return Err(format!("enter a value for {name}"));
        }
        if value.len() > VALUE_MAX {
            return Err(format!("the value for {name} is longer than 16 KB"));
        }
        self.entries.insert(
            name.to_string(),
            Entry {
                value: value.to_string(),
                updated: Some(now.to_rfc3339_opts(SecondsFormat::Secs, true)),
            },
        );
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> bool {
        self.entries.remove(name).is_some()
    }

    pub fn resolve(&self, text: &str) -> Result<String, SecretsError> {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find(OPEN) {
            out.push_str(&rest[..at]);
            let after = &rest[at + OPEN.len()..];
            let end = after.find('}').ok_or_else(|| {
                SecretsError::Invalid("a ${secret: reference is not closed".into())
            })?;
            let name = &after[..end];
            let value = self
                .get(name)
                .ok_or_else(|| SecretsError::Missing(name.to_string()))?;
            out.push_str(value);
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    // Written whole to a private temporary file and renamed into place, so a reader never sees
    // half a file and a failed write leaves the old one.
    pub fn save(&self) -> Result<(), SecretsError> {
        let failed = |source| SecretsError::Read {
            path: self.path.display().to_string(),
            source,
        };
        let stored: BTreeMap<&str, Stored> = self
            .entries
            .iter()
            .map(|(name, e)| {
                (
                    name.as_str(),
                    Stored::Full {
                        value: e.value.clone(),
                        updated: e.updated.clone(),
                    },
                )
            })
            .collect();
        let body = if stored.is_empty() {
            String::new()
        } else {
            serde_yaml::to_string(&stored)
                .map_err(|e| SecretsError::Invalid(format!("cannot write secrets: {e}")))?
        };
        let dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(PRIVATE_DIR)
            .create(dir)
            .map_err(failed)?;
        if let Err(e) = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(PRIVATE_DIR))
        {
            tracing::warn!(dir = %dir.display(), error = %e, "cannot make the secrets folder private");
        }
        let tmp = self.path.with_extension("yml.tmp");
        let write = || -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(PRIVATE_FILE)
                .open(&tmp)?;
            file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE))?;
            file.write_all(HEADER.as_bytes())?;
            file.write_all(body.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        };
        write().map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            failed(e)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-10-28T09:30:00Z".parse().unwrap()
    }

    fn store(dir: &Path) -> Secrets {
        let mut s = Secrets::load(&dir.join(FILE_NAME)).unwrap();
        s.set("linear", "lin_api_SECRET", now()).unwrap();
        s
    }

    #[test]
    fn a_missing_file_is_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let s = Secrets::for_config(&dir.path().join("yardbell.yml")).unwrap();
        assert!(s.list().is_empty());
        assert_eq!(s.path(), dir.path().join("secrets.yml"));
    }

    #[test]
    fn references_resolve_and_plain_text_stays() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        assert_eq!(
            s.resolve("Bearer ${secret:linear}").unwrap(),
            "Bearer lin_api_SECRET"
        );
        assert_eq!(
            s.resolve("${secret:linear}/${secret:linear}").unwrap(),
            "lin_api_SECRET/lin_api_SECRET"
        );
        assert_eq!(s.resolve("Bearer plain").unwrap(), "Bearer plain");
        assert_eq!(s.resolve("$secret:linear}").unwrap(), "$secret:linear}");
    }

    #[test]
    fn a_missing_secret_names_the_secret_and_no_value() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let err = s.resolve("Bearer ${secret:github}").unwrap_err();
        assert_eq!(err.to_string(), "the secret github is not set");
        assert!(!format!("{err:?}").contains("lin_api_SECRET"));
    }

    #[test]
    fn malformed_references_are_refused() {
        assert_eq!(
            references("a ${secret:x} b ${secret:y-2}").unwrap(),
            ["x", "y-2"]
        );
        assert!(references("Bearer ${secret:linear").is_err());
        assert!(references("Bearer ${secret:}").is_err());
        assert!(references("Bearer ${secret:a b}").is_err());
        assert!(references("no reference").unwrap().is_empty());
    }

    #[test]
    fn saved_privately_in_a_private_folder_and_read_back() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("yardbell");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = store(&dir);
        s.save().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join(FILE_NAME)), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert!(!dir.join("secrets.yml.tmp").exists());
        let back = Secrets::load(&dir.join(FILE_NAME)).unwrap();
        assert_eq!(back.get("linear"), Some("lin_api_SECRET"));
        assert_eq!(
            back.list(),
            vec![Info {
                name: "linear".into(),
                updated: Some("2026-10-28T09:30:00Z".into())
            }]
        );
    }

    #[test]
    fn a_hand_written_file_with_plain_values_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "linear: lin_api_x\ngithub:\n  value: ghp_y\n").unwrap();
        let s = Secrets::load(&path).unwrap();
        assert_eq!(s.get("linear"), Some("lin_api_x"));
        assert_eq!(s.get("github"), Some("ghp_y"));
        assert_eq!(s.list()[1].updated, None);
    }

    #[test]
    fn errors_and_debug_output_never_show_a_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "linear: [lin_api_LEAK\n").unwrap();
        let err = Secrets::load(&path).unwrap_err().to_string();
        assert!(!err.contains("lin_api_LEAK"), "{err}");
        assert!(err.contains("at line"), "{err}");
        std::fs::write(&path, "linear:\n  value: [lin_api_LEAK]\n").unwrap();
        let err = Secrets::load(&path).unwrap_err().to_string();
        assert!(!err.contains("lin_api_LEAK"), "{err}");
        std::fs::write(&path, "'bad name': lin_api_LEAK\n").unwrap();
        let err = Secrets::load(&path).unwrap_err().to_string();
        assert!(!err.contains("lin_api_LEAK"), "{err}");
        let clean = tempfile::tempdir().unwrap();
        let s = store(clean.path());
        assert!(!format!("{s:?}").contains("lin_api_SECRET"));
    }

    #[test]
    fn values_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = store(dir.path());
        assert!(s.set("a b", "x", now()).is_err());
        assert!(s.set("ok", "", now()).is_err());
        assert!(s.set(&"n".repeat(65), "x", now()).is_err());
        assert!(s.remove("linear"));
        assert!(!s.remove("linear"));
    }
}
