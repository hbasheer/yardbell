use std::collections::HashMap;
use std::sync::Mutex;

// Several browser terminals can show one tmux session: a Workspace pane, a hidden tab, the phone.
// tmux sizes the window to the last one used, so the agent kept redrawing for the wrong screen.
// The viewer in use owns the size; tmux is told to ignore the size of every other one.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plan {
    pub owner: Option<String>,
    pub ignored: Vec<String>,
}

#[derive(Default)]
struct Viewer {
    id: String,
    active: bool,
    claimed: u64,
}

#[derive(Default)]
pub struct Viewers {
    sessions: Mutex<HashMap<(String, String), Vec<Viewer>>>,
    clock: Mutex<u64>,
}

impl Viewers {
    pub fn set(&self, machine: &str, session: &str, id: &str, active: bool) -> Plan {
        let claimed = {
            let mut clock = self.clock.lock().expect("viewers lock");
            *clock += 1;
            *clock
        };
        let mut sessions = self.sessions.lock().expect("viewers lock");
        let viewers = sessions
            .entry((machine.to_string(), session.to_string()))
            .or_default();
        match viewers.iter_mut().find(|v| v.id == id) {
            Some(v) => {
                if active && !v.active {
                    v.claimed = claimed;
                }
                v.active = active;
            }
            None => viewers.push(Viewer {
                id: id.to_string(),
                active,
                claimed: if active { claimed } else { 0 },
            }),
        }
        plan(viewers)
    }

    pub fn claim(&self, machine: &str, session: &str, id: &str) -> Plan {
        let claimed = {
            let mut clock = self.clock.lock().expect("viewers lock");
            *clock += 1;
            *clock
        };
        let mut sessions = self.sessions.lock().expect("viewers lock");
        let viewers = sessions
            .entry((machine.to_string(), session.to_string()))
            .or_default();
        if let Some(v) = viewers.iter_mut().find(|v| v.id == id) {
            v.active = true;
            v.claimed = claimed;
        }
        plan(viewers)
    }

    pub fn leave(&self, machine: &str, session: &str, id: &str) -> Plan {
        let key = (machine.to_string(), session.to_string());
        let mut sessions = self.sessions.lock().expect("viewers lock");
        let Some(viewers) = sessions.get_mut(&key) else {
            return Plan::default();
        };
        viewers.retain(|v| v.id != id);
        let plan = plan(viewers);
        if viewers.is_empty() {
            sessions.remove(&key);
        }
        plan
    }
}

fn plan(viewers: &[Viewer]) -> Plan {
    let owner = viewers
        .iter()
        .filter(|v| v.active)
        .max_by_key(|v| v.claimed)
        .map(|v| v.id.clone());
    let ignored = viewers
        .iter()
        .filter(|v| Some(&v.id) != owner.as_ref())
        .map(|v| v.id.clone())
        .collect();
    Plan { owner, ignored }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(owner: Option<&str>, ignored: &[&str]) -> Plan {
        Plan {
            owner: owner.map(str::to_string),
            ignored: ignored.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn the_latest_viewer_in_use_owns_the_size() {
        let v = Viewers::default();
        assert_eq!(v.set("hp", "s", "mac", true), plan(Some("mac"), &[]));
        assert_eq!(
            v.set("hp", "s", "phone", true),
            plan(Some("phone"), &["mac"])
        );
        assert_eq!(v.claim("hp", "s", "mac"), plan(Some("mac"), &["phone"]));
    }

    #[test]
    fn a_hidden_viewer_never_owns_it() {
        let v = Viewers::default();
        v.set("hp", "s", "mac", true);
        assert_eq!(v.set("hp", "s", "tab", false), plan(Some("mac"), &["tab"]));
        assert_eq!(v.set("hp", "s", "mac", false), plan(None, &["mac", "tab"]));
    }

    #[test]
    fn ownership_falls_back_to_the_previous_viewer_in_use() {
        let v = Viewers::default();
        v.set("hp", "s", "mac", true);
        v.set("hp", "s", "phone", true);
        assert_eq!(v.leave("hp", "s", "phone"), plan(Some("mac"), &[]));
        assert_eq!(v.leave("hp", "s", "mac"), plan(None, &[]));
        assert_eq!(v.leave("hp", "s", "gone"), plan(None, &[]));
    }

    #[test]
    fn sessions_are_kept_apart() {
        let v = Viewers::default();
        v.set("hp", "a", "one", true);
        assert_eq!(v.set("hp", "b", "two", true), plan(Some("two"), &[]));
        assert_eq!(v.set("mini", "a", "three", true), plan(Some("three"), &[]));
    }
}
