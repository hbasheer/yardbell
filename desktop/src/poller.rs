use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use yardbell::events::{Event, Tracker};
use yardbell::state::StateView;

use crate::client::ClientError;

pub const INTERVAL: Duration = Duration::from_secs(5);
const UNREACHABLE_AFTER: u32 = 3;

pub enum Outcome {
    View(Box<StateView>, Vec<Event>),
    Unreachable,
    SignedOut,
    Waiting,
}

#[derive(Default)]
pub struct Poller {
    failures: u32,
}

impl Poller {
    pub fn on_result(
        &mut self,
        tracker: &mut Tracker,
        result: Result<StateView, ClientError>,
        now: Instant,
    ) -> Outcome {
        match result {
            Ok(view) => {
                self.failures = 0;
                let events = tracker.observe(&view, now);
                Outcome::View(Box::new(view), events)
            }
            Err(ClientError::SignedOut) => Outcome::SignedOut,
            Err(_) => {
                self.failures = self.failures.saturating_add(1);
                if self.failures < UNREACHABLE_AFTER {
                    return Outcome::Waiting;
                }
                tracker.reset();
                Outcome::Unreachable
            }
        }
    }
}

#[derive(Default)]
pub struct Generation(AtomicU64);

impl Generation {
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.current() == generation
    }

    pub fn bump(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn bump_from(&self, generation: u64) -> bool {
        self.0
            .compare_exchange(
                generation,
                generation + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use yardbell::config::HostTerminal;
    use yardbell::snapshot::Activity;
    use yardbell::state::{EndedView, MachineView, SessionView};

    fn machine() -> MachineView {
        MachineView {
            name: "devbox".into(),
            up: true,
            reason: None,
            last_seen: None,
            local: false,
            health: None,
            accounts: Vec::new(),
            mesh_on: None,
        }
    }

    fn view(sessions: Vec<SessionView>, ended: Vec<EndedView>) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: vec![machine()],
            folders: vec![],
            sessions,
            ended,
            host_terminal: HostTerminal::None,
            mesh: None,
            server: None,
            proposals: 0,
        }
    }

    fn working() -> StateView {
        view(
            vec![SessionView {
                id: "s1".into(),
                machine: "devbox".into(),
                agent: "claude".into(),
                pid: 1,
                folder: "acme/api".into(),
                ticket: String::new(),
                branch: String::new(),
                activity: Activity::Active,
                attachable: true,
                tmux: Some("acme-api".into()),
                stale: false,
                ports: vec![],
                pull: None,
                path: String::new(),
                worktree: false,
                setup: None,
            }],
            vec![],
        )
    }

    fn finished() -> StateView {
        view(
            vec![],
            vec![EndedView {
                id: "s1".into(),
                machine: "devbox".into(),
                agent: "claude".into(),
                folder: "acme/api".into(),
                ticket: String::new(),
                path: String::new(),
                branch: String::new(),
                worktree: false,
            }],
        )
    }

    fn unreachable() -> Result<StateView, ClientError> {
        Err(ClientError::Unreachable("http://100.1.2.3:4100".into()))
    }

    fn events(outcome: Outcome) -> Vec<Event> {
        match outcome {
            Outcome::View(_, events) => events,
            Outcome::Unreachable => panic!("expected a view, got Unreachable"),
            Outcome::SignedOut => panic!("expected a view, got SignedOut"),
            Outcome::Waiting => panic!("expected a view, got Waiting"),
        }
    }

    #[test]
    fn poller_unreachable_after_three_failures() {
        let mut poller = Poller::default();
        let mut tracker = Tracker::new();
        let t0 = Instant::now();
        let at = |secs| t0 + Duration::from_secs(secs);

        assert_eq!(
            events(poller.on_result(&mut tracker, Ok(working()), at(0))),
            vec![]
        );
        assert!(matches!(
            poller.on_result(&mut tracker, unreachable(), at(5)),
            Outcome::Waiting
        ));
        assert!(matches!(
            poller.on_result(&mut tracker, unreachable(), at(10)),
            Outcome::Waiting
        ));
        assert!(matches!(
            poller.on_result(&mut tracker, unreachable(), at(15)),
            Outcome::Unreachable
        ));
        assert_eq!(
            events(poller.on_result(&mut tracker, Ok(finished()), at(20))),
            vec![],
            "the reset tracker must not report what changed while unreachable"
        );
    }

    #[test]
    fn poller_keeps_reporting_unreachable_until_a_view_arrives() {
        let mut poller = Poller::default();
        let mut tracker = Tracker::new();
        let now = Instant::now();
        for _ in 0..3 {
            poller.on_result(&mut tracker, unreachable(), now);
        }
        assert!(matches!(
            poller.on_result(&mut tracker, unreachable(), now),
            Outcome::Unreachable
        ));
        events(poller.on_result(&mut tracker, Ok(working()), now));
        assert!(matches!(
            poller.on_result(&mut tracker, unreachable(), now),
            Outcome::Waiting
        ));
    }

    #[test]
    fn a_view_between_failures_starts_the_count_again() {
        let mut poller = Poller::default();
        let mut tracker = Tracker::new();
        let now = Instant::now();
        let failed = || {
            Err(ClientError::Other(
                "the server answered 502 Bad Gateway".into(),
            ))
        };
        poller.on_result(&mut tracker, failed(), now);
        poller.on_result(&mut tracker, failed(), now);
        events(poller.on_result(&mut tracker, Ok(working()), now));
        poller.on_result(&mut tracker, failed(), now);
        assert!(matches!(
            poller.on_result(&mut tracker, failed(), now),
            Outcome::Waiting
        ));
        assert!(matches!(
            poller.on_result(&mut tracker, failed(), now),
            Outcome::Unreachable
        ));
    }

    #[test]
    fn poller_signed_out() {
        let mut poller = Poller::default();
        let mut tracker = Tracker::new();
        assert!(matches!(
            poller.on_result(&mut tracker, Err(ClientError::SignedOut), Instant::now()),
            Outcome::SignedOut
        ));
    }

    #[test]
    fn results_from_an_earlier_generation_are_stale() {
        let generation = Generation::default();
        let first = generation.current();
        assert!(generation.is_current(first));

        let second = generation.bump();
        assert_ne!(second, first);
        assert!(!generation.is_current(first));
        assert!(generation.is_current(second));
        assert_eq!(generation.current(), second);
    }

    #[test]
    fn only_the_current_generation_can_end_itself() {
        let generation = Generation::default();
        let first = generation.current();
        assert!(generation.bump_from(first));
        assert!(!generation.is_current(first));

        let second = generation.current();
        assert!(
            !generation.bump_from(first),
            "a stale 401 must not end the next session"
        );
        assert!(generation.is_current(second));
    }

    #[test]
    fn one_of_two_racing_sign_outs_wins() {
        let generation = Arc::new(Generation::default());
        let token = generation.current();
        let barrier = Arc::new(Barrier::new(2));
        let racers: Vec<_> = (0..2)
            .map(|_| {
                let (generation, barrier) = (generation.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    generation.bump_from(token)
                })
            })
            .collect();
        let won: Vec<bool> = racers.into_iter().map(|r| r.join().unwrap()).collect();
        assert_eq!(won.iter().filter(|w| **w).count(), 1, "{won:?}");
        assert_eq!(generation.current(), token + 1);
    }
}
