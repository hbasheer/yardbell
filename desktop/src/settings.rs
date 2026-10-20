use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE: &str = "settings.json";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Switches {
    pub agent_idle: bool,
    pub session_ended: bool,
    pub machine: bool,
    pub memory: bool,
    pub autostart: bool,
}

impl Default for Switches {
    fn default() -> Switches {
        Switches {
            agent_idle: true,
            session_ended: true,
            machine: true,
            memory: true,
            autostart: false,
        }
    }
}

pub fn load_switches(dir: &Path) -> Switches {
    let path = dir.join(FILE);
    let Ok(text) = fs::read_to_string(&path) else {
        return Switches::default();
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        eprintln!("yardbell: ignoring {}: {e}", path.display());
        Switches::default()
    })
}

pub fn save_switches(dir: &Path, s: &Switches) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(FILE), serde_json::to_vec_pretty(s)?)
}

pub struct Settings {
    dir: PathBuf,
    switches: Mutex<Switches>,
}

impl Settings {
    pub fn new(dir: PathBuf, switches: Switches) -> Settings {
        Settings {
            dir,
            switches: Mutex::new(switches),
        }
    }

    pub fn switches(&self) -> Switches {
        *self.switches.lock().unwrap()
    }

    pub fn set(&self, switches: Switches) -> io::Result<()> {
        *self.switches.lock().unwrap() = switches;
        save_switches(&self.dir, &switches)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn notifications_start_on_and_autostart_off() {
        assert_eq!(
            Switches::default(),
            Switches {
                agent_idle: true,
                session_ended: true,
                machine: true,
                memory: true,
                autostart: false,
            }
        );
    }

    #[test]
    fn switches_persist() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("dev.yardbell.desktop");
        assert_eq!(load_switches(&dir), Switches::default());

        let custom = Switches {
            agent_idle: false,
            session_ended: true,
            machine: false,
            memory: true,
            autostart: true,
        };
        save_switches(&dir, &custom).unwrap();
        assert_eq!(load_switches(&dir), custom);

        fs::write(dir.join("settings.json"), "{\"agent_idle\": fal").unwrap();
        assert_eq!(load_switches(&dir), Switches::default());

        fs::write(dir.join("settings.json"), "{\"memory\": \"no\"}").unwrap();
        assert_eq!(load_switches(&dir), Switches::default());
    }

    #[test]
    fn missing_switches_keep_their_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("settings.json"), "{\"memory\": false}").unwrap();
        assert_eq!(
            load_switches(tmp.path()),
            Switches {
                memory: false,
                ..Switches::default()
            }
        );
    }
}
