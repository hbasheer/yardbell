use crate::snapshot::Activity;
use crate::state::StateView;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

pub const IDLE_AFTER: Duration = Duration::from_secs(20);
pub const DOWN_AFTER: Duration = Duration::from_secs(60);
const MEMORY_HIGH_PERCENT: u64 = 95;
const MEMORY_REARM_PERCENT: u64 = 90;

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    AgentIdle {
        machine: String,
        session_id: String,
        tmux: Option<String>,
        folder: String,
        agent: String,
    },
    SessionEnded {
        machine: String,
        session_id: String,
        folder: String,
        agent: String,
    },
    MachineDown {
        machine: String,
        reason: Option<String>,
    },
    MachineUp {
        machine: String,
    },
    MemoryHigh {
        machine: String,
        percent: u8,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub title: String,
    pub body: String,
}

pub fn message(event: &Event, view: &StateView, waited_minutes: u64) -> Message {
    let (title, body) = match event {
        Event::AgentIdle {
            machine,
            folder,
            agent,
            ..
        } => {
            let who = format!("{} on {machine}", agent_label(view, agent));
            let body = match waited_minutes {
                0 => format!("{who} finished or needs you"),
                1 => format!("{who} has been waiting for 1 minute"),
                n => format!("{who} has been waiting for {n} minutes"),
            };
            (format!("{folder} is waiting"), body)
        }
        Event::SessionEnded {
            machine,
            folder,
            agent,
            ..
        } => (
            format!("{folder} ended"),
            format!("{} on {machine}", agent_label(view, agent)),
        ),
        Event::MachineDown { machine, reason } => (
            format!("{machine} is down"),
            reason.clone().unwrap_or_default(),
        ),
        Event::MachineUp { machine } => (format!("{machine} is back"), String::new()),
        Event::MemoryHigh { machine, percent } => {
            (format!("{machine} memory at {percent}%"), String::new())
        }
    };
    Message { title, body }
}

pub fn agent_label<'a>(view: &'a StateView, agent: &'a str) -> &'a str {
    view.agents
        .iter()
        .find(|known| known.name == agent)
        .map_or(agent, |known| known.label.as_str())
}

struct SessionState {
    machine: String,
    folder: String,
    agent: String,
    attachable: bool,
    was_active: bool,
    idle_since: Option<Instant>,
    notified: bool,
}

struct MachineState {
    was_up: bool,
    down_since: Option<Instant>,
    notified_down: bool,
    memory_armed: bool,
}

#[derive(Default)]
pub struct Tracker {
    sessions: HashMap<String, SessionState>,
    machines: HashMap<String, MachineState>,
    primed: bool,
}

impl Tracker {
    pub fn new() -> Tracker {
        Tracker::default()
    }

    pub fn reset(&mut self) {
        *self = Tracker::default();
    }

    pub fn observe(&mut self, view: &StateView, now: Instant) -> Vec<Event> {
        let mut events = Vec::new();
        self.observe_machines(view, now, &mut events);
        self.observe_sessions(view, now, &mut events);
        if !std::mem::replace(&mut self.primed, true) {
            events.clear();
        }
        events
    }

    fn observe_machines(&mut self, view: &StateView, now: Instant, events: &mut Vec<Event>) {
        let names: HashSet<&str> = view.machines.iter().map(|m| m.name.as_str()).collect();
        self.machines
            .retain(|name, _| names.contains(name.as_str()));

        for m in &view.machines {
            let state = self
                .machines
                .entry(m.name.clone())
                .or_insert_with(|| MachineState {
                    was_up: false,
                    down_since: None,
                    notified_down: false,
                    memory_armed: true,
                });

            if m.up {
                state.was_up = true;
                if state.notified_down {
                    events.push(Event::MachineUp {
                        machine: m.name.clone(),
                    });
                }
                state.down_since = None;
                state.notified_down = false;
            } else {
                let since = *state.down_since.get_or_insert(now);
                if state.was_up && now.duration_since(since) >= DOWN_AFTER && !state.notified_down {
                    state.notified_down = true;
                    events.push(Event::MachineDown {
                        machine: m.name.clone(),
                        reason: m.reason.clone(),
                    });
                }
            }

            let Some(health) = m.health.filter(|h| h.mem_total_kb > 0) else {
                continue;
            };
            let percent = health.mem_used_kb * 100 / health.mem_total_kb;
            if percent < MEMORY_REARM_PERCENT {
                state.memory_armed = true;
            } else if percent >= MEMORY_HIGH_PERCENT && state.memory_armed {
                state.memory_armed = false;
                events.push(Event::MemoryHigh {
                    machine: m.name.clone(),
                    percent: percent.min(u8::MAX as u64) as u8,
                });
            }
        }
    }

    fn observe_sessions(&mut self, view: &StateView, now: Instant, events: &mut Vec<Event>) {
        let live: HashSet<&str> = view
            .sessions
            .iter()
            .filter(|s| !s.stale)
            .map(|s| s.id.as_str())
            .collect();

        let present: HashSet<&str> = view.sessions.iter().map(|s| s.id.as_str()).collect();

        for (id, state) in &self.sessions {
            let machine_up = view
                .machines
                .iter()
                .any(|m| m.name == state.machine && m.up);
            if state.attachable && machine_up && !present.contains(id.as_str()) {
                events.push(Event::SessionEnded {
                    machine: state.machine.clone(),
                    session_id: id.clone(),
                    folder: state.folder.clone(),
                    agent: state.agent.clone(),
                });
            }
        }

        self.sessions.retain(|id, _| live.contains(id.as_str()));

        for s in view.sessions.iter().filter(|s| !s.stale) {
            let state = self
                .sessions
                .entry(s.id.clone())
                .or_insert_with(|| SessionState {
                    machine: s.machine.clone(),
                    folder: s.folder.clone(),
                    agent: s.agent.clone(),
                    attachable: s.attachable,
                    was_active: false,
                    idle_since: None,
                    notified: false,
                });

            match s.activity {
                Activity::Blocked => {
                    state.idle_since = None;
                    if !state.notified {
                        state.notified = true;
                        events.push(Event::AgentIdle {
                            machine: s.machine.clone(),
                            session_id: s.id.clone(),
                            tmux: s.tmux.clone(),
                            folder: s.folder.clone(),
                            agent: s.agent.clone(),
                        });
                    }
                }
                Activity::Active => {
                    state.was_active = true;
                    state.idle_since = None;
                    state.notified = false;
                }
                Activity::Idle => {
                    if !state.was_active || state.notified {
                        continue;
                    }
                    let since = *state.idle_since.get_or_insert(now);
                    if now.duration_since(since) >= IDLE_AFTER {
                        state.notified = true;
                        events.push(Event::AgentIdle {
                            machine: s.machine.clone(),
                            session_id: s.id.clone(),
                            tmux: s.tmux.clone(),
                            folder: s.folder.clone(),
                            agent: s.agent.clone(),
                        });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostTerminal;
    use crate::mesh::MeshView;
    use crate::snapshot::Health;
    use crate::state::{AgentView, EndedView, FolderView, MachineView, PortView, SessionView};

    fn machine(name: &str, up: bool) -> MachineView {
        MachineView {
            name: name.into(),
            up,
            reason: (!up).then(|| "ssh timed out".to_string()),
            last_seen: None,
            local: false,
            health: None,
            mesh_on: None,
        }
    }

    fn with_memory(name: &str, percent: u64) -> MachineView {
        MachineView {
            health: Some(Health {
                mem_total_kb: 1000,
                mem_used_kb: percent * 10,
                agent_kb: 0,
                load1: 0.0,
                cpus: 4,
            }),
            ..machine(name, true)
        }
    }

    fn session(id: &str, machine: &str, activity: Activity) -> SessionView {
        SessionView {
            id: id.into(),
            machine: machine.into(),
            agent: "claude".into(),
            pid: 1,
            folder: "api".into(),
            ticket: "ENG-1".into(),
            branch: "eng-1-x".into(),
            activity,
            attachable: true,
            tmux: Some("eng-1".into()),
            stale: false,
            ports: vec![],
        }
    }

    fn stale(id: &str, machine: &str) -> SessionView {
        SessionView {
            stale: true,
            ..session(id, machine, Activity::Idle)
        }
    }

    fn ended(id: &str, machine: &str) -> EndedView {
        EndedView {
            id: id.into(),
            machine: machine.into(),
            agent: "claude".into(),
            folder: "api".into(),
            ticket: "ENG-1".into(),
        }
    }

    fn view(
        machines: Vec<MachineView>,
        sessions: Vec<SessionView>,
        ended: Vec<EndedView>,
    ) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines,
            folders: vec![],
            sessions,
            ended,
            host_terminal: HostTerminal::None,
            mesh: None,
        }
    }

    fn one_machine(sessions: Vec<SessionView>) -> StateView {
        view(vec![machine("hp", true)], sessions, vec![])
    }

    fn idle_event() -> Event {
        Event::AgentIdle {
            machine: "hp".into(),
            session_id: "s1".into(),
            tmux: Some("eng-1".into()),
            folder: "api".into(),
            agent: "claude".into(),
        }
    }

    fn labelled() -> StateView {
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
            ..view(vec![], vec![], vec![])
        }
    }

    fn waiting(agent: &str) -> Event {
        Event::AgentIdle {
            machine: "devbox".into(),
            session_id: "s1".into(),
            tmux: None,
            folder: "acme/api".into(),
            agent: agent.into(),
        }
    }

    fn ended_event(agent: &str) -> Event {
        Event::SessionEnded {
            machine: "devbox".into(),
            session_id: "s1".into(),
            folder: "acme/api".into(),
            agent: agent.into(),
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

    fn memory(percent: u8) -> Event {
        Event::MemoryHigh {
            machine: "devbox".into(),
            percent,
        }
    }

    fn secs(t0: Instant, n: u64) -> Instant {
        t0 + Duration::from_secs(n)
    }

    #[test]
    fn first_observation_is_silent() {
        let mut t = Tracker::new();
        let v = view(
            vec![machine("hp", false), with_memory("pro", 99)],
            vec![session("s1", "hp", Activity::Idle)],
            vec![ended("s0", "hp")],
        );
        assert_eq!(t.observe(&v, Instant::now()), vec![]);
    }

    #[test]
    fn idle_fires_after_20_seconds() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let active = one_machine(vec![session("s1", "hp", Activity::Active)]);
        let idle = || one_machine(vec![session("s1", "hp", Activity::Idle)]);
        assert_eq!(t.observe(&active, t0), vec![]);
        assert_eq!(t.observe(&idle(), secs(t0, 5)), vec![]);
        assert_eq!(t.observe(&idle(), secs(t0, 26)), vec![idle_event()]);
        assert_eq!(t.observe(&idle(), secs(t0, 40)), vec![]);
    }

    #[test]
    fn blocked_fires_at_once_and_again_only_after_working() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let active = || one_machine(vec![session("s1", "hp", Activity::Active)]);
        let blocked = || one_machine(vec![session("s1", "hp", Activity::Blocked)]);
        assert_eq!(t.observe(&active(), t0), vec![]);
        assert_eq!(t.observe(&blocked(), secs(t0, 2)), vec![idle_event()]);
        assert_eq!(t.observe(&blocked(), secs(t0, 40)), vec![]);
        assert_eq!(t.observe(&active(), secs(t0, 41)), vec![]);
        assert_eq!(t.observe(&blocked(), secs(t0, 43)), vec![idle_event()]);
    }

    #[test]
    fn idle_flap_does_not_repeat() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let active = || one_machine(vec![session("s1", "hp", Activity::Active)]);
        let idle = || one_machine(vec![session("s1", "hp", Activity::Idle)]);
        let mut all = vec![];
        all.extend(t.observe(&active(), t0));
        all.extend(t.observe(&idle(), secs(t0, 2)));
        all.extend(t.observe(&active(), secs(t0, 10)));
        all.extend(t.observe(&idle(), secs(t0, 12)));
        all.extend(t.observe(&idle(), secs(t0, 37)));
        assert_eq!(all, vec![idle_event()]);
    }

    #[test]
    fn stale_sessions_are_silent() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        t.observe(
            &one_machine(vec![session("s1", "hp", Activity::Active)]),
            t0,
        );
        let stale_view = || one_machine(vec![stale("s1", "hp")]);
        assert_eq!(t.observe(&stale_view(), secs(t0, 1)), vec![]);
        assert_eq!(t.observe(&stale_view(), secs(t0, 31)), vec![]);
        let gone = view(vec![machine("hp", true)], vec![], vec![ended("s1", "hp")]);
        assert_eq!(t.observe(&gone, secs(t0, 40)), vec![]);
    }

    #[test]
    fn ended_session_fires_once() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        t.observe(
            &one_machine(vec![session("s1", "hp", Activity::Active)]),
            t0,
        );
        let gone = || view(vec![machine("hp", true)], vec![], vec![ended("s1", "hp")]);
        assert_eq!(
            t.observe(&gone(), secs(t0, 1)),
            vec![Event::SessionEnded {
                machine: "hp".into(),
                session_id: "s1".into(),
                folder: "api".into(),
                agent: "claude".into(),
            }]
        );
        assert_eq!(t.observe(&gone(), secs(t0, 2)), vec![]);
    }

    #[test]
    fn machine_down_after_a_minute_and_back() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |up| view(vec![machine("hp", up)], vec![], vec![]);
        assert_eq!(t.observe(&at(true), t0), vec![]);
        for n in (5..65).step_by(5) {
            assert_eq!(t.observe(&at(false), secs(t0, n)), vec![], "t({n})");
        }
        assert_eq!(
            t.observe(&at(false), secs(t0, 65)),
            vec![Event::MachineDown {
                machine: "hp".into(),
                reason: Some("ssh timed out".into()),
            }]
        );
        assert_eq!(
            t.observe(&at(true), secs(t0, 70)),
            vec![Event::MachineUp {
                machine: "hp".into()
            }]
        );
    }

    #[test]
    fn short_down_blips_are_silent() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |up| view(vec![machine("hp", up)], vec![], vec![]);
        let mut all = vec![];
        all.extend(t.observe(&at(true), t0));
        all.extend(t.observe(&at(false), secs(t0, 5)));
        all.extend(t.observe(&at(false), secs(t0, 10)));
        all.extend(t.observe(&at(false), secs(t0, 15)));
        all.extend(t.observe(&at(true), secs(t0, 20)));
        assert_eq!(all, vec![]);
    }

    #[test]
    fn a_blip_restarts_the_minute() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |up| view(vec![machine("hp", up)], vec![], vec![]);
        let mut all = vec![];
        all.extend(t.observe(&at(true), t0));
        for n in (5..=40).step_by(5) {
            all.extend(t.observe(&at(false), secs(t0, n)));
        }
        all.extend(t.observe(&at(true), secs(t0, 45)));
        for n in (50..110).step_by(5) {
            all.extend(t.observe(&at(false), secs(t0, n)));
        }
        assert_eq!(all, vec![]);
        assert_eq!(t.observe(&at(false), secs(t0, 110)).len(), 1);
    }

    #[test]
    fn no_session_ended_for_down_machine() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        t.observe(
            &one_machine(vec![session("s1", "hp", Activity::Active)]),
            t0,
        );
        let down = || view(vec![machine("hp", false)], vec![], vec![ended("s1", "hp")]);
        assert_eq!(t.observe(&down(), secs(t0, 1)), vec![]);
        let events = t.observe(&down(), secs(t0, 61));
        assert_eq!(events.len(), 1);
        assert!(events
            .iter()
            .all(|e| !matches!(e, Event::SessionEnded { .. })));
    }

    #[test]
    fn memory_high_once_and_rearms_below_90() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |p| view(vec![with_memory("hp", p)], vec![], vec![]);
        let high = |p| {
            vec![Event::MemoryHigh {
                machine: "hp".into(),
                percent: p,
            }]
        };
        assert_eq!(t.observe(&at(94), t0), vec![]);
        assert_eq!(t.observe(&at(96), secs(t0, 1)), high(96));
        assert_eq!(t.observe(&at(97), secs(t0, 2)), vec![]);
        assert_eq!(t.observe(&at(92), secs(t0, 3)), vec![]);
        assert_eq!(t.observe(&at(96), secs(t0, 4)), vec![]);
        assert_eq!(t.observe(&at(89), secs(t0, 5)), vec![]);
        assert_eq!(t.observe(&at(95), secs(t0, 6)), high(95));
    }

    #[test]
    fn memory_skips_missing_health_and_zero_total() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let mut zero = with_memory("hp", 99);
        zero.health.as_mut().unwrap().mem_total_kb = 0;
        let v = view(vec![machine("pro", true), zero], vec![], vec![]);
        t.observe(&v, t0);
        assert_eq!(t.observe(&v, secs(t0, 1)), vec![]);
    }

    #[test]
    fn removed_machine_is_silent() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let before = view(
            vec![machine("a", true), machine("b", true)],
            vec![session("s1", "a", Activity::Active)],
            vec![],
        );
        let after = view(vec![machine("b", true)], vec![], vec![]);
        t.observe(&before, t0);
        assert_eq!(t.observe(&after, secs(t0, 1)), vec![]);
    }

    #[test]
    fn reset_makes_next_observation_silent() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |up| view(vec![machine("hp", up)], vec![], vec![]);
        t.observe(&at(true), t0);
        t.observe(&at(false), secs(t0, 1));
        t.reset();
        assert_eq!(t.observe(&at(false), secs(t0, 2)), vec![]);
        assert_eq!(t.observe(&at(false), secs(t0, 3)), vec![]);
        assert_eq!(t.observe(&at(true), secs(t0, 4)), vec![]);
        assert_eq!(t.observe(&at(false), secs(t0, 5)), vec![]);
        assert_eq!(t.observe(&at(false), secs(t0, 65)).len(), 1);
    }

    #[test]
    fn never_up_machine_is_silent() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |up| view(vec![machine("hp", up)], vec![], vec![]);
        for n in 0..4 {
            assert_eq!(t.observe(&at(false), secs(t0, n)), vec![]);
        }
        let added = view(
            vec![machine("hp", false), machine("pro", false)],
            vec![],
            vec![],
        );
        assert_eq!(t.observe(&added, secs(t0, 5)), vec![]);
        assert_eq!(t.observe(&added, secs(t0, 6)), vec![]);
        assert_eq!(t.observe(&added, secs(t0, 65)), vec![]);
        assert_eq!(t.observe(&added, secs(t0, 125)), vec![]);
        assert_eq!(t.observe(&at(true), secs(t0, 130)), vec![]);
    }

    #[test]
    fn vanished_session_on_up_machine_fires_once() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        t.observe(
            &one_machine(vec![session("s1", "hp", Activity::Active)]),
            t0,
        );
        let gone = || one_machine(vec![]);
        assert_eq!(
            t.observe(&gone(), secs(t0, 1)),
            vec![Event::SessionEnded {
                machine: "hp".into(),
                session_id: "s1".into(),
                folder: "api".into(),
                agent: "claude".into(),
            }]
        );
        assert_eq!(t.observe(&gone(), secs(t0, 2)), vec![]);
    }

    #[test]
    fn vanished_session_is_silent_when_machine_down_or_removed() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let live = view(
            vec![machine("hp", true), machine("pro", true)],
            vec![
                session("s1", "hp", Activity::Active),
                session("s2", "pro", Activity::Active),
            ],
            vec![],
        );
        t.observe(&live, t0);
        let after = view(vec![machine("hp", false)], vec![], vec![]);
        assert_eq!(t.observe(&after, secs(t0, 1)), vec![]);
    }

    #[test]
    fn outside_tmux_session_vanishing_is_silent() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let outside = SessionView {
            id: "hp:4242".into(),
            pid: 4242,
            attachable: false,
            tmux: None,
            ..session("hp:4242", "hp", Activity::Active)
        };
        t.observe(&one_machine(vec![outside]), t0);
        let moved = one_machine(vec![session("hp:eng-1", "hp", Activity::Active)]);
        assert_eq!(t.observe(&moved, secs(t0, 1)), vec![]);
        assert_eq!(t.observe(&one_machine(vec![]), secs(t0, 2)).len(), 1);
    }

    #[test]
    fn session_in_ended_and_vanished_fires_once() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        t.observe(
            &one_machine(vec![session("s1", "hp", Activity::Active)]),
            t0,
        );
        let gone = view(vec![machine("hp", true)], vec![], vec![ended("s1", "hp")]);
        assert_eq!(t.observe(&gone, secs(t0, 1)).len(), 1);
    }

    #[test]
    fn state_view_round_trips() {
        let mut m = with_memory("hp", 50);
        m.last_seen = Some("12:00".into());
        m.mesh_on = Some(true);
        let mut s = session("s1", "hp", Activity::Active);
        s.ports = vec![PortView {
            service: "web".into(),
            remote: 3000,
            local: Some(13000),
            status: "tunnel up".into(),
            url: Some("http://localhost:13000".into()),
        }];
        let mut v = view(vec![m], vec![s], vec![ended("s0", "hp")]);
        v.agents = vec![AgentView {
            name: "claude".into(),
            label: "Claude".into(),
        }];
        v.folders = vec![FolderView {
            machine: "hp".into(),
            label: "api".into(),
            path: "/r/api".into(),
            branch: "main".into(),
        }];
        v.mesh = Some(MeshView {
            provider: crate::config::MeshProvider::Tailscale,
            label: "Tailscale".into(),
            on: Some(true),
            can_turn_on: false,
            hint: None,
        });

        let json = serde_json::to_value(&v).unwrap();
        let back: StateView = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), json);
    }

    #[test]
    fn message_texts() {
        let v = labelled();
        let texts = |e: &Event, waited| {
            let Message { title, body } = message(e, &v, waited);
            (title, body)
        };
        assert_eq!(
            texts(&waiting("codex"), 0),
            (
                "acme/api is waiting".into(),
                "Codex on devbox finished or needs you".into()
            )
        );
        assert_eq!(
            texts(&waiting("codex"), 2).1,
            "Codex on devbox has been waiting for 2 minutes"
        );
        assert_eq!(
            texts(&waiting("codex"), 1).1,
            "Codex on devbox has been waiting for 1 minute"
        );
        assert_eq!(
            texts(&ended_event("claude"), 0),
            ("acme/api ended".into(), "Claude Code on devbox".into())
        );
        assert_eq!(
            texts(&down(Some("ssh timeout")), 0),
            ("laptop is down".into(), "ssh timeout".into())
        );
        assert_eq!(
            texts(&down(None), 0),
            ("laptop is down".into(), String::new())
        );
        assert_eq!(texts(&up(), 0), ("laptop is back".into(), String::new()));
        assert_eq!(
            texts(&memory(96), 0),
            ("devbox memory at 96%".into(), String::new())
        );
    }

    #[test]
    fn unknown_agents_use_their_name() {
        assert_eq!(
            message(&waiting("amp"), &labelled(), 0).body,
            "amp on devbox finished or needs you"
        );
    }
}
