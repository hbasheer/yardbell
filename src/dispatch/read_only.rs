use super::store::write_private;
use super::Dispatch;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// The folders whose most recent session Yardbell started was a reviewer or scanner, so resuming
// there (claude --continue, codex resume --last picks that conversation up) stays read-only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Last {
    machine: String,
    path: String,
    agent: String,
}

impl Dispatch {
    fn read_only_file(&self) -> PathBuf {
        self.shared.dir.join("read-only.json")
    }

    fn read_only_folders(&self) -> Vec<Last> {
        std::fs::read(self.read_only_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn last_was_read_only(&self, machine: &str, path: &str, agent: &str) -> bool {
        self.read_only_folders()
            .iter()
            .any(|l| l.machine == machine && l.path == path && l.agent == agent)
    }

    pub fn started_in(&self, machine: &str, path: &str, agent: &str, read_only: bool) {
        let mut all = self.read_only_folders();
        let before = all.len();
        all.retain(|l| !(l.machine == machine && l.path == path && l.agent == agent));
        if read_only {
            all.push(Last {
                machine: machine.into(),
                path: path.into(),
                agent: agent.into(),
            });
        } else if all.len() == before {
            return;
        }
        let bytes = serde_json::to_vec_pretty(&all).unwrap_or_default();
        if let Err(e) = write_private(&self.read_only_file(), &bytes) {
            tracing::warn!(error = %e, "could not note a read-only session");
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    #[test]
    fn the_last_start_in_a_folder_decides_a_resume() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = super::Dispatch::new(Arc::new(FakeRunner::default()), dir.path().into());
        assert!(!dispatch.last_was_read_only("hp", "/r/app", "claude"));
        dispatch.started_in("hp", "/r/app", "claude", true);
        assert!(dispatch.last_was_read_only("hp", "/r/app", "claude"));
        assert!(!dispatch.last_was_read_only("hp", "/r/app", "codex"));
        assert!(!dispatch.last_was_read_only("mini", "/r/app", "claude"));
        dispatch.started_in("hp", "/r/app", "claude", false);
        assert!(!dispatch.last_was_read_only("hp", "/r/app", "claude"));
    }
}
