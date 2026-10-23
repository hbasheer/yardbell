use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub server: String,
    #[serde(default)]
    pub cookie: Option<String>,
    #[serde(default)]
    pub last_used: u64,
}

// The app's own data folder is private to it on Android, so the login cookie sits there as a
// plain file, like the browser keeps its cookies.
pub struct Store {
    file: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Store {
        Store {
            file: dir.join("servers.json"),
        }
    }

    pub fn all(&self) -> Vec<Server> {
        let mut all: Vec<Server> = std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        all.sort_by_key(|s| std::cmp::Reverse(s.last_used));
        all
    }

    pub fn get(&self, server: &str) -> Option<Server> {
        self.all().into_iter().find(|s| s.server == server)
    }

    pub fn put(&self, entry: Server) -> Result<(), String> {
        let mut all = self.all();
        all.retain(|s| s.server != entry.server);
        all.push(entry);
        self.write(&all)
    }

    pub fn forget(&self, server: &str) -> Result<(), String> {
        let mut all = self.all();
        all.retain(|s| s.server != server);
        self.write(&all)
    }

    fn write(&self, all: &[Server]) -> Result<(), String> {
        let fail = |e: std::io::Error| format!("can't save the server list: {e}");
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(fail)?;
        }
        let tmp = self.file.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(all).unwrap_or_default()).map_err(fail)?;
        std::fs::rename(&tmp, &self.file).map_err(fail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_are_kept_most_recent_first_and_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert!(store.all().is_empty());
        let entry = |server: &str, last_used| Server {
            server: server.into(),
            cookie: Some("c".into()),
            last_used,
        };
        store.put(entry("http://a:4000", 1)).unwrap();
        store.put(entry("http://b:4000", 2)).unwrap();
        store.put(entry("http://a:4000", 3)).unwrap();
        let names: Vec<String> = store.all().into_iter().map(|s| s.server).collect();
        assert_eq!(names, ["http://a:4000", "http://b:4000"]);
        store.forget("http://a:4000").unwrap();
        assert_eq!(store.all().len(), 1);
        assert_eq!(
            Store::new(dir.path())
                .get("http://b:4000")
                .unwrap()
                .last_used,
            2
        );
    }
}
