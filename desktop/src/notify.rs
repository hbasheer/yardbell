use std::sync::atomic::{AtomicUsize, Ordering};

use notify_rust::{Notification, NotificationResponse};
use yardbell::events::{message, Event, Message};
use yardbell::state::StateView;

use crate::settings::Switches;

const APP_NAME: &str = "Yardbell";

#[derive(Debug, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
    pub open: Target,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Main,
    Terminal { machine: String, tmux: String },
}

pub fn note_for(event: &Event, view: &StateView) -> Note {
    let Message { title, body } = message(event, view, 0);
    Note {
        title,
        body,
        open: target_for(event),
    }
}

fn target_for(event: &Event) -> Target {
    let Event::AgentIdle { machine, tmux, .. } = event else {
        return Target::Main;
    };
    match tmux.as_deref().filter(|tmux| !tmux.is_empty()) {
        Some(tmux) => Target::Terminal {
            machine: machine.clone(),
            tmux: tmux.to_string(),
        },
        None => Target::Main,
    }
}

pub fn allowed(event: &Event, s: &Switches) -> bool {
    match event {
        Event::AgentIdle { .. } => s.agent_idle,
        Event::SessionEnded { .. } => s.session_ended,
        Event::MachineDown { .. } | Event::MachineUp { .. } => s.machine,
        Event::MemoryHigh { .. } => s.memory,
    }
}

const OPEN_ACTION: &str = "default";
// A wait holds a thread (on Linux also its own bus connection, on macOS a
// main-run-loop timer) until the notification is clicked, closed or cleared.
const MAX_WAITING: usize = 8;

static WAITING: Slots = Slots::new(MAX_WAITING);

struct Slots {
    taken: AtomicUsize,
    cap: usize,
}

struct Slot<'a>(&'a Slots);

impl Slots {
    const fn new(cap: usize) -> Slots {
        Slots {
            taken: AtomicUsize::new(0),
            cap,
        }
    }

    fn acquire(&self) -> Option<Slot<'_>> {
        self.taken
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |taken| {
                (taken < self.cap).then_some(taken + 1)
            })
            .ok()
            .map(|_| Slot(self))
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.taken.fetch_sub(1, Ordering::SeqCst);
    }
}

fn is_click(response: &NotificationResponse) -> bool {
    match response {
        NotificationResponse::Default => true,
        NotificationResponse::Action(action) => action == OPEN_ACTION,
        _ => false,
    }
}

fn notification(title: &str, body: &str, waiting: bool) -> Notification {
    let mut notification = Notification::new();
    notification.appname(APP_NAME).summary(title).body(body);
    // Only a notification with a wait behind it can route its click, and on
    // macOS the action button is also what makes notify-rust wait for one.
    if waiting {
        notification.action(OPEN_ACTION, "Open");
    }
    notification
}

pub fn show(note: Note, on_click: impl FnOnce(Target) + Send + 'static) {
    let slot = WAITING.acquire();
    let spawned = std::thread::Builder::new()
        .name("notification".into())
        .spawn(move || {
            let Note { title, body, open } = note;
            let shown = notification(&title, &body, slot.is_some())
                .show()
                .and_then(|handle| {
                    let Some(_waiting) = slot else {
                        return Ok(());
                    };
                    handle.wait_for_response(move |response: &NotificationResponse| {
                        if is_click(response) {
                            on_click(open);
                        }
                    })
                });
            if let Err(e) = shown {
                eprintln!("yardbell: can't show the notification {title:?}: {e}");
            }
        });
    if let Err(e) = spawned {
        eprintln!("yardbell: can't show a notification: {e}");
    }
}

// mac-notification-sys otherwise posts as Finder by swapping the process's
// bundle id, and an unbundled dev build has no registered id of its own.
#[cfg(target_os = "macos")]
pub fn send_as(identifier: &str) {
    let sender = if tauri::is_dev() {
        "com.apple.Terminal"
    } else {
        identifier
    };
    if let Err(e) = notify_rust::set_application(sender) {
        eprintln!("yardbell: can't send notifications as {sender}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_rust::CloseReason;
    use yardbell::config::HostTerminal;
    use yardbell::state::AgentView;

    fn view() -> StateView {
        StateView {
            agents: vec![
                AgentView {
                    name: "claude".into(),
                    label: "Claude Code".into(),
                },
                AgentView {
                    name: "codex".into(),
                    label: "Codex".into(),
                },
            ],
            default_agent: "claude".into(),
            machines: vec![],
            folders: vec![],
            sessions: vec![],
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
            server: None,
        }
    }

    fn idle(agent: &str, tmux: Option<&str>) -> Event {
        Event::AgentIdle {
            machine: "devbox".into(),
            session_id: "s1".into(),
            tmux: tmux.map(str::to_string),
            folder: "acme/api".into(),
            agent: agent.into(),
        }
    }

    fn ended() -> Event {
        Event::SessionEnded {
            machine: "devbox".into(),
            session_id: "s1".into(),
            folder: "acme/api".into(),
            agent: "claude".into(),
        }
    }

    fn down(reason: Option<&str>) -> Event {
        Event::MachineDown {
            machine: "laptop".into(),
            reason: reason.map(str::to_string),
        }
    }

    fn up() -> Event {
        Event::MachineUp {
            machine: "laptop".into(),
        }
    }

    fn memory() -> Event {
        Event::MemoryHigh {
            machine: "devbox".into(),
            percent: 96,
        }
    }

    fn note(title: &str, body: &str, open: Target) -> Note {
        Note {
            title: title.into(),
            body: body.into(),
            open,
        }
    }

    #[test]
    fn note_texts() {
        let v = view();
        assert_eq!(
            note_for(&idle("codex", Some("acme-api")), &v),
            note(
                "acme/api is waiting",
                "Codex on devbox finished or needs you",
                Target::Terminal {
                    machine: "devbox".into(),
                    tmux: "acme-api".into()
                }
            )
        );
        assert_eq!(
            note_for(&ended(), &v),
            note("acme/api ended", "Claude Code on devbox", Target::Main)
        );
        assert_eq!(
            note_for(&down(Some("ssh timeout")), &v),
            note("laptop is down", "ssh timeout", Target::Main)
        );
        assert_eq!(
            note_for(&down(None), &v),
            note("laptop is down", "", Target::Main)
        );
        assert_eq!(
            note_for(&up(), &v),
            note("laptop is back", "", Target::Main)
        );
        assert_eq!(
            note_for(&memory(), &v),
            note("devbox memory at 96%", "", Target::Main)
        );
    }

    #[test]
    fn unknown_agents_use_their_name() {
        assert_eq!(
            note_for(&idle("amp", Some("acme-api")), &view()).body,
            "amp on devbox finished or needs you"
        );
    }

    #[test]
    fn idle_agents_without_a_tmux_session_open_main() {
        assert_eq!(note_for(&idle("codex", None), &view()).open, Target::Main);
        assert_eq!(
            note_for(&idle("codex", Some("")), &view()).open,
            Target::Main
        );
    }

    #[test]
    fn switches_filter() {
        let events = [
            idle("codex", Some("t")),
            ended(),
            down(None),
            up(),
            memory(),
        ];
        let on = Switches::default();
        let cases = [
            (on, [true, true, true, true, true]),
            (
                Switches {
                    agent_idle: false,
                    ..on
                },
                [false, true, true, true, true],
            ),
            (
                Switches {
                    session_ended: false,
                    ..on
                },
                [true, false, true, true, true],
            ),
            (
                Switches {
                    machine: false,
                    ..on
                },
                [true, true, false, false, true],
            ),
            (
                Switches {
                    memory: false,
                    ..on
                },
                [true, true, true, true, false],
            ),
            (
                Switches {
                    autostart: true,
                    ..on
                },
                [true, true, true, true, true],
            ),
        ];
        for (switches, expected) in cases {
            let got: Vec<bool> = events.iter().map(|e| allowed(e, &switches)).collect();
            assert_eq!(got, expected, "{switches:?}");
        }
    }

    #[test]
    fn the_body_and_the_open_button_count_as_a_click() {
        assert!(is_click(&NotificationResponse::Default));
        assert!(is_click(&NotificationResponse::Action("default".into())));
        assert!(!is_click(&NotificationResponse::Action("snooze".into())));
        assert!(!is_click(&NotificationResponse::Closed(
            CloseReason::Expired
        )));
        assert!(!is_click(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
        assert!(!is_click(&NotificationResponse::Reply("ok".into())));
    }

    #[test]
    fn only_a_notification_that_waits_for_its_click_offers_open() {
        let waiting = notification("acme/api is waiting", "Codex on devbox", true);
        assert_eq!(waiting.actions, ["default", "Open"]);
        assert_eq!(waiting.summary, "acme/api is waiting");
        assert_eq!(waiting.body, "Codex on devbox");
        assert_eq!(waiting.appname, "Yardbell");
        let overflow = notification("acme/api is waiting", "Codex on devbox", false);
        assert!(overflow.actions.is_empty(), "{:?}", overflow.actions);
        assert_eq!(overflow.summary, "acme/api is waiting");
    }

    #[test]
    fn waits_are_capped_and_a_finished_wait_frees_its_slot() {
        let slots = Slots::new(MAX_WAITING);
        let mut held: Vec<_> = (0..MAX_WAITING)
            .map(|n| {
                slots
                    .acquire()
                    .unwrap_or_else(|| panic!("slot {n} refused"))
            })
            .collect();
        assert!(slots.acquire().is_none(), "a wait beyond the cap");
        held.pop();
        let freed = slots.acquire();
        assert!(freed.is_some(), "a finished wait frees its slot");
        assert!(slots.acquire().is_none(), "the freed slot is taken again");
        drop(freed);
        drop(held);
        assert!(slots.acquire().is_some());
    }
}
