use crate::pulls::{Ci, Mergeable, PullView};
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
    Pull {
        machine: String,
        session_id: String,
        tmux: Option<String>,
        folder: String,
        change: PullChange,
        pull: PullView,
    },
    LimitReset {
        machine: String,
        session_id: String,
        tmux: Option<String>,
        folder: String,
        agent: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullChange {
    CiFailed,
    Conflicts,
    Ready,
    Merged,
    Closed,
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
            session_id,
            folder,
            agent,
            ..
        } => {
            let who = format!("{} on {machine}", agent_label(view, agent));
            let error = view
                .sessions
                .iter()
                .find(|s| s.id == *session_id)
                .and_then(|s| s.stopped.as_deref());
            if let Some(error) = error {
                return Message {
                    title: format!("{folder} stopped on an error"),
                    body: format!("{who}: {error}"),
                };
            }
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
        Event::Pull {
            machine,
            folder,
            change,
            pull,
            ..
        } => pull_message(machine, folder, *change, pull),
        Event::LimitReset {
            machine,
            folder,
            agent,
            ..
        } => (
            format!("{folder}: the usage limit has reset"),
            format!(
                "{} on {machine} stopped at its limit and can go on",
                agent_label(view, agent)
            ),
        ),
    };
    Message { title, body }
}

fn pull_message(
    machine: &str,
    folder: &str,
    change: PullChange,
    pull: &PullView,
) -> (String, String) {
    let mark = if pull.forge == "gitlab" { '!' } else { '#' };
    let number = format!("{mark}{}", pull.number);
    let base = if pull.base.is_empty() {
        "its base branch"
    } else {
        &pull.base
    };
    let what = match change {
        PullChange::CiFailed => format!("CI failed on {number}"),
        PullChange::Conflicts => format!("{number} has merge conflicts with {base}"),
        PullChange::Ready => format!("{number} is ready to merge"),
        PullChange::Merged => format!("{number} was merged"),
        PullChange::Closed => format!("{number} was closed without merging"),
    };
    let mut body = format!("{}, on {machine}", pull.title);
    if change == PullChange::CiFailed && !pull.failed.is_empty() {
        body.push_str(&format!(". Failed: {}", pull.failed.join(", ")));
    }
    (format!("{folder}: {what}"), body)
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

// What has been told of one pull request: each head is the commit a change was told for.
struct PullState {
    state: String,
    ci_failed: String,
    conflict: String,
    ready: String,
}

fn ready(p: &PullView) -> bool {
    p.state == "open"
        && !p.draft
        && p.review == "approved"
        && matches!(p.ci, Ci::Passing | Ci::None)
        && p.mergeable == Mergeable::Clean
}

impl PullState {
    // A pull request seen for the first time only sets what is known.
    fn first(p: &PullView) -> PullState {
        let head_if = |yes: bool| if yes { p.head.clone() } else { String::new() };
        PullState {
            state: p.state.clone(),
            ci_failed: head_if(p.ci == Ci::Failing),
            conflict: head_if(p.mergeable == Mergeable::Conflicting),
            ready: head_if(ready(p)),
        }
    }

    fn next(&mut self, p: &PullView) -> Vec<PullChange> {
        let mut changes = Vec::new();
        let was_open = self.state == "open";
        self.state.clone_from(&p.state);
        match p.state.as_str() {
            "merged" if was_open => return vec![PullChange::Merged],
            "closed" if was_open => return vec![PullChange::Closed],
            "open" => {}
            _ => return changes,
        }
        if p.ci == Ci::Failing && self.ci_failed != p.head {
            self.ci_failed.clone_from(&p.head);
            changes.push(PullChange::CiFailed);
        }
        match p.mergeable {
            Mergeable::Clean => self.conflict.clear(),
            Mergeable::Conflicting if self.conflict != p.head => {
                self.conflict.clone_from(&p.head);
                changes.push(PullChange::Conflicts);
            }
            _ => {}
        }
        if ready(p) && self.ready != p.head {
            self.ready.clone_from(&p.head);
            changes.push(PullChange::Ready);
        }
        changes
    }
}

#[derive(Default)]
pub struct Tracker {
    sessions: HashMap<String, SessionState>,
    machines: HashMap<String, MachineState>,
    pulls: HashMap<String, PullState>,
    // The reset each session was told about, so a limit is told once however long it waits.
    limits: HashMap<String, String>,
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
        self.observe_pulls(view, &mut events);
        self.observe_limits(view, chrono::Utc::now(), &mut events);
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

            let Some(percent) = m.health.and_then(|h| h.pressure()) else {
                continue;
            };
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

    fn observe_limits(
        &mut self,
        view: &StateView,
        now: chrono::DateTime<chrono::Utc>,
        events: &mut Vec<Event>,
    ) {
        let live: HashSet<&str> = view
            .sessions
            .iter()
            .filter(|s| !s.stale)
            .map(|s| s.id.as_str())
            .collect();
        self.limits.retain(|id, _| live.contains(id.as_str()));
        for s in view
            .sessions
            .iter()
            .filter(|s| !s.stale && s.stopped.is_some())
        {
            let Some(resets) = s.resets.as_deref() else {
                continue;
            };
            let passed = chrono::DateTime::parse_from_rfc3339(resets).is_ok_and(|at| at <= now);
            if !passed || self.limits.get(&s.id).is_some_and(|told| told == resets) {
                continue;
            }
            self.limits.insert(s.id.clone(), resets.to_string());
            events.push(Event::LimitReset {
                machine: s.machine.clone(),
                session_id: s.id.clone(),
                tmux: s.tmux.clone(),
                folder: s.folder.clone(),
                agent: s.agent.clone(),
            });
        }
    }

    fn observe_pulls(&mut self, view: &StateView, events: &mut Vec<Event>) {
        let mut seen: HashSet<&str> = HashSet::new();
        for s in view.sessions.iter().filter(|s| !s.stale) {
            let Some(pull) = &s.pull else {
                continue;
            };
            if !seen.insert(pull.url.as_str()) {
                continue;
            }
            let changes = match self.pulls.get_mut(&pull.url) {
                Some(state) => state.next(pull),
                None => {
                    self.pulls.insert(pull.url.clone(), PullState::first(pull));
                    Vec::new()
                }
            };
            events.extend(changes.into_iter().map(|change| Event::Pull {
                machine: s.machine.clone(),
                session_id: s.id.clone(),
                tmux: s.tmux.clone(),
                folder: s.folder.clone(),
                change,
                pull: pull.clone(),
            }));
        }
        self.pulls.retain(|url, _| seen.contains(url.as_str()));
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
                    // An error is as sure a stop as a question, so it need not wait to be sure.
                    if s.stopped.is_some() || now.duration_since(since) >= IDLE_AFTER {
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
    use crate::pulls::{Ci, Mergeable, PullView};
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
            accounts: Vec::new(),
            mesh_on: None,
        }
    }

    fn with_memory(name: &str, percent: u64) -> MachineView {
        MachineView {
            health: Some(Health {
                mem_total_kb: 1000,
                mem_used_kb: percent * 10,
                agent_kb: 0,
                user_kb: 0,
                limit_kb: 0,
                limit_used_kb: 0,
                load1: 0.0,
                cpus: 4,
                disk_total_kb: 0,
                disk_used_kb: 0,
            }),
            ..machine(name, true)
        }
    }

    fn session(id: &str, machine: &str, activity: Activity) -> SessionView {
        SessionView {
            cwd: String::new(),
            pull_why: None,
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
            pull: None,
            path: String::new(),
            worktree: false,
            setup: None,
            stopped: None,
            review: None,
            resets: None,
        }
    }

    fn stale(id: &str, machine: &str) -> SessionView {
        SessionView {
            cwd: String::new(),
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
            path: String::new(),
            branch: String::new(),
            worktree: false,
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
            server: None,
            proposals: 0,
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
                    read_only: true,
                },
                AgentView {
                    name: "codex".into(),
                    label: "Codex".into(),
                    read_only: true,
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
    fn memory_high_also_counts_an_account_limit_on_a_roomy_machine() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let at = |limit_used_kb| {
            let mut m = with_memory("hp", 20);
            let h = m.health.as_mut().unwrap();
            h.limit_kb = 500;
            h.limit_used_kb = limit_used_kb;
            view(vec![m], vec![], vec![])
        };
        assert_eq!(t.observe(&at(100), t0), vec![]);
        assert_eq!(
            t.observe(&at(485), secs(t0, 1)),
            vec![Event::MemoryHigh {
                machine: "hp".into(),
                percent: 97,
            }]
        );
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
            cwd: String::new(),
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
            read_only: true,
        }];
        v.folders = vec![FolderView {
            machine: "hp".into(),
            label: "api".into(),
            path: "/r/api".into(),
            branch: "main".into(),
            worktree: false,
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
    fn an_agent_stopped_on_an_error_is_told_at_once_with_the_error() {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        let active = one_machine(vec![session("s1", "hp", Activity::Active)]);
        let stopped = || {
            let mut v = one_machine(vec![SessionView {
                cwd: String::new(),
                stopped: Some("API Error: 529 overloaded".into()),
                resets: None,
                ..session("s1", "hp", Activity::Idle)
            }]);
            v.agents = labelled().agents;
            v
        };
        assert_eq!(t.observe(&active, t0), vec![]);
        assert_eq!(t.observe(&stopped(), secs(t0, 2)), vec![idle_event()]);
        assert_eq!(t.observe(&stopped(), secs(t0, 40)), vec![]);
        let Message { title, body } = message(&idle_event(), &stopped(), 0);
        assert_eq!(title, "api stopped on an error");
        assert_eq!(body, "Claude Code on hp: API Error: 529 overloaded");
    }

    #[test]
    fn a_usage_limit_is_told_once_when_its_reset_time_passes() {
        let mut t = Tracker::new();
        let limited = |resets: &str| {
            let mut v = one_machine(vec![SessionView {
                cwd: String::new(),
                stopped: Some("You've hit your limit · resets 3pm".into()),
                resets: Some(resets.into()),
                ..session("s1", "hp", Activity::Idle)
            }]);
            v.agents = labelled().agents;
            v
        };
        let at = |text: &str| {
            chrono::DateTime::parse_from_rfc3339(text)
                .unwrap()
                .with_timezone(&chrono::Utc)
        };
        let reset = "2026-11-09T15:00:00+03:00";
        let told = |t: &mut Tracker, now: &str| {
            let mut events = Vec::new();
            t.observe_limits(&limited(reset), at(now), &mut events);
            events
        };
        assert_eq!(told(&mut t, "2026-11-09T14:59:00+03:00"), vec![]);
        let event = Event::LimitReset {
            machine: "hp".into(),
            session_id: "s1".into(),
            tmux: Some("eng-1".into()),
            folder: "api".into(),
            agent: "claude".into(),
        };
        assert_eq!(
            told(&mut t, "2026-11-09T15:00:30+03:00"),
            vec![event.clone()]
        );
        assert_eq!(told(&mut t, "2026-11-09T16:00:00+03:00"), vec![]);
        let Message { title, body } = message(&event, &limited(reset), 0);
        assert_eq!(title, "api: the usage limit has reset");
        assert_eq!(body, "Claude Code on hp stopped at its limit and can go on");

        let mut events = Vec::new();
        let next = "2026-11-09T20:00:00+03:00";
        t.observe_limits(&limited(next), at("2026-11-09T20:01:00+03:00"), &mut events);
        assert_eq!(events.len(), 1, "a later limit is told again");
    }

    #[test]
    fn an_error_without_a_reset_time_is_never_told_as_reset() {
        let mut t = Tracker::new();
        let mut v = one_machine(vec![SessionView {
            cwd: String::new(),
            stopped: Some("API Error: 529 overloaded".into()),
            resets: None,
            ..session("s1", "hp", Activity::Idle)
        }]);
        let mut events = Vec::new();
        t.observe_limits(&v, chrono::Utc::now(), &mut events);
        v.sessions[0].stopped = None;
        v.sessions[0].resets = Some("2026-11-09T15:00:00+03:00".into());
        t.observe_limits(&v, chrono::Utc::now(), &mut events);
        assert_eq!(events, vec![], "only a session still stopped is told");
    }

    fn texts(e: &Event, waited: u64) -> (String, String) {
        let Message { title, body } = message(e, &labelled(), waited);
        (title, body)
    }

    fn pr(state: &str, ci: Ci, head: &str) -> PullView {
        PullView {
            forge: "github".into(),
            number: 12,
            url: "https://github.com/acme/api/pull/12".into(),
            title: "Fix login".into(),
            state: state.into(),
            draft: false,
            review: String::new(),
            ci,
            failed: vec!["test".into()],
            head: head.into(),
            base: "main".into(),
            mergeable: Mergeable::Unknown,
        }
    }

    fn with_pull(pull: PullView) -> StateView {
        one_machine(vec![SessionView {
            cwd: String::new(),
            pull: Some(pull),
            ..session("s1", "hp", Activity::Idle)
        }])
    }

    fn kinds(events: &[Event]) -> Vec<PullChange> {
        events
            .iter()
            .filter_map(|e| match e {
                Event::Pull { change, .. } => Some(*change),
                _ => None,
            })
            .collect()
    }

    fn primed(first: PullView) -> (Tracker, Instant) {
        let mut t = Tracker::new();
        let t0 = Instant::now();
        assert_eq!(t.observe(&with_pull(first), t0), vec![]);
        (t, t0)
    }

    #[test]
    fn ci_failing_is_told_once_per_commit() {
        let (mut t, t0) = primed(pr("open", Ci::Pending, "a"));
        let failing = || with_pull(pr("open", Ci::Failing, "a"));
        assert_eq!(kinds(&t.observe(&failing(), t0)), [PullChange::CiFailed]);
        assert_eq!(t.observe(&failing(), t0), vec![]);
        t.observe(&with_pull(pr("open", Ci::Pending, "a")), t0);
        assert_eq!(
            t.observe(&failing(), t0),
            vec![],
            "a rerun on the same commit"
        );
        assert_eq!(
            kinds(&t.observe(&with_pull(pr("open", Ci::Failing, "b")), t0)),
            [PullChange::CiFailed]
        );
    }

    #[test]
    fn a_pull_request_seen_for_the_first_time_says_nothing() {
        let (mut t, t0) = primed(pr("open", Ci::Pending, "a"));
        let mut other = pr("open", Ci::Failing, "x");
        other.url = "https://github.com/acme/api/pull/13".into();
        let both = one_machine(vec![
            SessionView {
                cwd: String::new(),
                pull: Some(pr("open", Ci::Pending, "a")),
                ..session("s1", "hp", Activity::Idle)
            },
            SessionView {
                cwd: String::new(),
                pull: Some(other),
                ..session("s2", "hp", Activity::Idle)
            },
        ]);
        assert_eq!(t.observe(&both, t0), vec![]);
    }

    #[test]
    fn conflicts_are_told_once_and_again_after_they_cleared() {
        let (mut t, t0) = primed(pr("open", Ci::Passing, "a"));
        let with = |m: Mergeable| {
            let mut p = pr("open", Ci::Passing, "a");
            p.mergeable = m;
            with_pull(p)
        };
        assert_eq!(
            kinds(&t.observe(&with(Mergeable::Conflicting), t0)),
            [PullChange::Conflicts]
        );
        assert_eq!(t.observe(&with(Mergeable::Unknown), t0), vec![]);
        assert_eq!(t.observe(&with(Mergeable::Conflicting), t0), vec![]);
        t.observe(&with(Mergeable::Clean), t0);
        assert_eq!(
            kinds(&t.observe(&with(Mergeable::Conflicting), t0)),
            [PullChange::Conflicts]
        );
    }

    #[test]
    fn ready_to_merge_needs_an_approval_green_ci_and_no_conflict() {
        let (mut t, t0) = primed(pr("open", Ci::Pending, "a"));
        let ready = |ci: Ci, review: &str, m: Mergeable, draft: bool| {
            let mut p = pr("open", ci, "a");
            p.review = review.into();
            p.mergeable = m;
            p.draft = draft;
            with_pull(p)
        };
        assert_eq!(
            t.observe(&ready(Ci::Passing, "", Mergeable::Clean, false), t0),
            vec![]
        );
        assert_eq!(
            t.observe(&ready(Ci::Pending, "approved", Mergeable::Clean, false), t0),
            vec![]
        );
        assert_eq!(
            t.observe(
                &ready(Ci::Passing, "approved", Mergeable::Unknown, false),
                t0
            ),
            vec![]
        );
        assert_eq!(
            t.observe(&ready(Ci::Passing, "approved", Mergeable::Clean, true), t0),
            vec![]
        );
        assert_eq!(
            kinds(&t.observe(&ready(Ci::Passing, "approved", Mergeable::Clean, false), t0)),
            [PullChange::Ready]
        );
        assert_eq!(
            t.observe(&ready(Ci::None, "approved", Mergeable::Clean, false), t0),
            vec![],
            "once per commit"
        );
    }

    #[test]
    fn merged_and_closed_are_told_when_they_happen() {
        let (mut t, t0) = primed(pr("open", Ci::Passing, "a"));
        assert_eq!(
            kinds(&t.observe(&with_pull(pr("merged", Ci::Passing, "a")), t0)),
            [PullChange::Merged]
        );
        assert_eq!(
            t.observe(&with_pull(pr("merged", Ci::Passing, "a")), t0),
            vec![]
        );
        let (mut t, t0) = primed(pr("open", Ci::Passing, "a"));
        assert_eq!(
            kinds(&t.observe(&with_pull(pr("closed", Ci::Failing, "b")), t0)),
            [PullChange::Closed],
            "a closed pull request is not told as failing"
        );
        let (mut t, t0) = primed(pr("merged", Ci::Passing, "a"));
        assert_eq!(
            t.observe(&with_pull(pr("merged", Ci::Passing, "a")), t0),
            vec![]
        );
    }

    #[test]
    fn one_pull_request_in_two_sessions_is_told_once() {
        let (mut t, t0) = primed(pr("open", Ci::Pending, "a"));
        let twice = one_machine(vec![
            SessionView {
                cwd: String::new(),
                pull: Some(pr("open", Ci::Failing, "a")),
                ..session("s1", "hp", Activity::Idle)
            },
            SessionView {
                cwd: String::new(),
                pull: Some(pr("open", Ci::Failing, "a")),
                ..session("s2", "hp", Activity::Idle)
            },
        ]);
        assert_eq!(kinds(&t.observe(&twice, t0)), [PullChange::CiFailed]);
    }

    #[test]
    fn pull_request_messages_name_the_folder_and_the_number() {
        let event = |change: PullChange, forge: &str| {
            let mut pull = pr("open", Ci::Failing, "a");
            pull.forge = forge.into();
            Event::Pull {
                machine: "devbox".into(),
                session_id: "s1".into(),
                tmux: None,
                folder: "acme/api".into(),
                change,
                pull,
            }
        };
        let said = |change, forge| texts(&event(change, forge), 0);
        assert_eq!(
            said(PullChange::CiFailed, "github"),
            (
                "acme/api: CI failed on #12".into(),
                "Fix login, on devbox. Failed: test".into()
            )
        );
        assert_eq!(
            said(PullChange::Conflicts, "gitlab").0,
            "acme/api: !12 has merge conflicts with main"
        );
        assert_eq!(
            said(PullChange::Ready, "github").0,
            "acme/api: #12 is ready to merge"
        );
        assert_eq!(
            said(PullChange::Merged, "github").0,
            "acme/api: #12 was merged"
        );
        assert_eq!(
            said(PullChange::Closed, "github").0,
            "acme/api: #12 was closed without merging"
        );
        assert_eq!(said(PullChange::Merged, "github").1, "Fix login, on devbox");
    }

    #[test]
    fn unknown_agents_use_their_name() {
        assert_eq!(
            message(&waiting("amp"), &labelled(), 0).body,
            "amp on devbox finished or needs you"
        );
    }
}
