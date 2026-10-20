use std::fs;
use std::path::PathBuf;

pub trait Store: Send + Sync {
    fn load(&self) -> Option<(String, String)>;
    fn server(&self) -> Option<String>;
    fn save(&self, server: &str, cookie: &str) -> Result<(), String>;
    fn clear(&self);
}

const SERVICE: &str = "yardbell";
const SERVER_FILE: &str = "server";

pub struct Keychain {
    config_dir: PathBuf,
}

impl Keychain {
    pub fn new(config_dir: PathBuf) -> Keychain {
        Keychain { config_dir }
    }

    fn server_file(&self) -> PathBuf {
        self.config_dir.join(SERVER_FILE)
    }

    fn read_server(&self) -> Option<String> {
        let server = fs::read_to_string(self.server_file()).ok()?;
        let server = server.trim();
        (!server.is_empty()).then(|| server.to_string())
    }
}

impl Store for Keychain {
    fn load(&self) -> Option<(String, String)> {
        let server = self.read_server()?;
        let cookie = keyring::Entry::new(SERVICE, &server)
            .ok()?
            .get_password()
            .ok()?;
        Some((server, cookie))
    }

    fn server(&self) -> Option<String> {
        self.read_server()
    }

    fn save(&self, server: &str, cookie: &str) -> Result<(), String> {
        fs::create_dir_all(&self.config_dir)
            .map_err(|e| format!("can't create {}: {e}", self.config_dir.display()))?;
        keyring::Entry::new(SERVICE, server)
            .and_then(|entry| entry.set_password(cookie))
            .map_err(|e| format!("can't store the session in the keychain: {e}"))?;
        fs::write(self.server_file(), server)
            .map_err(|e| format!("can't write {}: {e}", self.server_file().display()))
    }

    fn clear(&self) {
        if let Some(server) = self.read_server() {
            if let Ok(entry) = keyring::Entry::new(SERVICE, &server) {
                let _ = entry.delete_credential();
            }
        }
        let _ = fs::remove_file(self.server_file());
    }
}

#[cfg(test)]
pub struct MemoryStore(pub std::sync::Mutex<Option<(String, String)>>);

#[cfg(test)]
impl Store for MemoryStore {
    fn load(&self) -> Option<(String, String)> {
        self.0.lock().unwrap().clone()
    }

    fn server(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .map(|(server, _)| server.clone())
    }

    fn save(&self, server: &str, cookie: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some((server.to_string(), cookie.to_string()));
        Ok(())
    }

    fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let store = MemoryStore(Default::default());
        assert_eq!(store.load(), None);
        store.save("http://h:1", "c:/+=").unwrap();
        assert_eq!(store.load(), Some(("http://h:1".into(), "c:/+=".into())));
        assert_eq!(store.server().as_deref(), Some("http://h:1"));
        store.clear();
        assert_eq!(store.load(), None);
        assert_eq!(store.server(), None);
    }

    #[test]
    fn keychain_without_server_file_loads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Keychain::new(dir.path().to_path_buf()).load(), None);
    }

    #[test]
    fn keychain_reads_the_stored_server_from_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Keychain::new(dir.path().to_path_buf());
        assert_eq!(store.server(), None);
        fs::write(dir.path().join(SERVER_FILE), "http://h:1\n").unwrap();
        assert_eq!(store.server().as_deref(), Some("http://h:1"));
    }
}
