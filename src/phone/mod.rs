pub mod ntfy;

use crate::config::{Config, PhoneNotifications};
use crate::events::{self, Event, Message, Tracker};
use crate::snapshot::Activity;
use crate::state::StateView;
use chrono::Local;
use ntfy::{Push, Sender, Target};
use serde::Serialize;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const HOLD_CAP: usize = 100;
pub const RETRY_AFTER: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    pub last_sent: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

struct Held {
    session_id: String,
    event: Event,
    due: Instant,
    wait_minutes: u64,
}

#[derive(Default)]
struct Watch {
    tracker: Tracker,
    held: Vec<Held>,
}

impl Watch {
    fn hold(&mut self, session_id: String, event: Event, due: Instant, wait_minutes: u64) {
        self.held.retain(|held| held.session_id != session_id);
        self.held.push(Held {
            session_id,
            event,
            due,
            wait_minutes,
        });
        if self.held.len() <= HOLD_CAP {
            return;
        }
        let earliest = self
            .held
            .iter()
            .enumerate()
            .min_by_key(|(_, held)| held.due)
            .map(|(index, _)| index);
        if let Some(index) = earliest {
            let dropped = self.held.remove(index);
            tracing::warn!(
                session = %dropped.session_id,
                "too many waiting notifications held, dropped the earliest"
            );
        }
    }

    fn release(
        &mut self,
        settings: &PhoneNotifications,
        view: &StateView,
        base: Option<&str>,
        now: Instant,
    ) -> Vec<Push> {
        let (mut due, waiting): (Vec<Held>, Vec<Held>) = std::mem::take(&mut self.held)
            .into_iter()
            .partition(|held| held.due <= now);
        self.held = waiting;
        due.sort_by_key(|held| held.due);
        due.iter()
            .filter(|held| settings.agent_waiting && still_waiting(view, &held.session_id))
            .map(|held| push_for(&held.event, view, base, held.wait_minutes))
            .collect()
    }
}

pub struct Phone {
    sender: Arc<dyn Sender>,
    watch: Mutex<Watch>,
    status: Mutex<Status>,
}

impl Phone {
    pub fn new(sender: Arc<dyn Sender>) -> Phone {
        Phone {
            sender,
            watch: Mutex::new(Watch::default()),
            status: Mutex::new(Status::default()),
        }
    }

    pub fn observe(
        &self,
        settings: &PhoneNotifications,
        view: &StateView,
        base: Option<&str>,
        now: Instant,
    ) -> Vec<Push> {
        let mut watch = self.watch.lock().expect("phone lock");
        let events = watch.tracker.observe(view, now);
        if !settings.on() {
            watch.held.clear();
            return Vec::new();
        }
        watch.held.retain(|held| !answered(view, &held.session_id));
        let mut pushes = Vec::new();
        for event in events.into_iter().filter(|event| enabled(settings, event)) {
            match waiting_session(&event) {
                Some(id) if settings.wait_minutes > 0 => {
                    let id = id.to_string();
                    let due = now + Duration::from_secs(settings.wait_minutes * 60);
                    watch.hold(id, event, due, settings.wait_minutes);
                }
                _ => pushes.push(push_for(&event, view, base, 0)),
            }
        }
        pushes.extend(watch.release(settings, view, base, now));
        pushes
    }

    pub async fn deliver(&self, to: &Target, push: &Push) {
        let mut result = self.attempt(to, push).await;
        if result.is_err() {
            tokio::time::sleep(RETRY_AFTER).await;
            result = self.attempt(to, push).await;
        }
        if let Err(error) = &result {
            tracing::warn!(error = %error, "phone notification not sent");
        }
        self.record(&result);
    }

    pub fn dispatch(self: &Arc<Self>, to: Target, pushes: Vec<Push>) {
        for push in pushes {
            let phone = Arc::clone(self);
            let to = to.clone();
            tokio::spawn(async move { phone.deliver(&to, &push).await });
        }
    }

    pub async fn test(&self, to: &Target, host: &str) -> Result<(), String> {
        let push = Push {
            title: "Yardbell".into(),
            message: format!("Notifications from {host} work."),
            tags: Vec::new(),
            priority: 3,
            click: None,
        };
        let result = self.attempt(to, &push).await;
        self.record(&result);
        result
    }

    pub fn status(&self) -> Status {
        self.status.lock().expect("phone lock").clone()
    }

    async fn attempt(&self, to: &Target, push: &Push) -> Result<(), String> {
        self.sender
            .send(to, push)
            .await
            .map_err(|error| to.redact(&error))
    }

    fn record(&self, result: &Result<(), String>) {
        let now = Local::now().to_rfc3339();
        let mut status = self.status.lock().expect("phone lock");
        match result {
            Ok(()) => status.last_sent = Some(now),
            Err(error) => {
                status.last_error = Some(error.clone());
                status.last_error_at = Some(now);
            }
        }
    }
}

pub fn push_for(event: &Event, view: &StateView, base: Option<&str>, waited_minutes: u64) -> Push {
    let Message { title, body } = events::message(event, view, waited_minutes);
    // ntfy replaces an empty message with the word "triggered".
    let (title, message) = if body.is_empty() {
        ("Yardbell".to_string(), title)
    } else {
        (title, body)
    };
    let (tag, priority) = match event {
        Event::AgentIdle { .. } => ("hourglass_flowing_sand", 3),
        Event::SessionEnded { .. } => ("checkered_flag", 2),
        Event::MachineDown { .. } => ("red_circle", 4),
        Event::MachineUp { .. } => ("green_circle", 3),
        Event::MemoryHigh { .. } => ("warning", 4),
    };
    Push {
        title,
        message,
        tags: vec![tag.to_string()],
        priority,
        click: base.map(|base| link(event, base)),
    }
}

pub fn base_url(cfg: &Config) -> Option<String> {
    cfg.bind_addresses()
        .iter()
        .filter_map(|address| address.parse::<IpAddr>().ok())
        .find(|ip| !ip.is_loopback())
        .map(|ip| format!("http://{ip}:{}", cfg.port))
}

fn link(event: &Event, base: &str) -> String {
    match event {
        Event::AgentIdle {
            machine,
            tmux: Some(tmux),
            ..
        } if !tmux.is_empty() => format!("{base}/term/{}/{}", segment(machine), segment(tmux)),
        _ => format!("{base}/"),
    }
}

fn segment(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn enabled(settings: &PhoneNotifications, event: &Event) -> bool {
    match event {
        Event::AgentIdle { .. } => settings.agent_waiting,
        Event::SessionEnded { .. } => settings.session_ended,
        Event::MachineDown { .. } | Event::MachineUp { .. } => settings.machines,
        Event::MemoryHigh { .. } => settings.memory,
    }
}

fn waiting_session(event: &Event) -> Option<&str> {
    match event {
        Event::AgentIdle { session_id, .. } => Some(session_id),
        _ => None,
    }
}

fn answered(view: &StateView, session_id: &str) -> bool {
    view.sessions
        .iter()
        .any(|s| s.id == session_id && s.activity == Activity::Active)
}

fn still_waiting(view: &StateView, session_id: &str) -> bool {
    view.sessions.iter().any(|s| {
        s.id == session_id
            && !s.stale
            && s.activity == Activity::Idle
            && view.machines.iter().any(|m| m.name == s.machine && m.up)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostTerminal;
    use crate::snapshot::Health;
    use crate::state::{AgentView, MachineView, SessionView};
    use crate::testing::FakeSender;
    use std::path::Path;

    const BASE: &str = "http://100.64.0.10:4000";

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

    fn session(id: &str, activity: Activity) -> SessionView {
        SessionView {
            id: id.into(),
            machine: "devbox".into(),
            agent: "codex".into(),
            pid: 1,
            folder: "acme/api".into(),
            ticket: String::new(),
            branch: String::new(),
            activity,
            attachable: true,
            tmux: Some(id.into()),
            stale: false,
            ports: vec![],
        }
    }

    fn view(machines: Vec<MachineView>, sessions: Vec<SessionView>) -> StateView {
        StateView {
            agents: vec![AgentView {
                name: "codex".into(),
                label: "Codex".into(),
            }],
            default_agent: "codex".into(),
            machines,
            folders: vec![],
            sessions,
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
        }
    }

    fn devbox(sessions: Vec<SessionView>) -> StateView {
        view(vec![machine("devbox", true)], sessions)
    }

    fn active() -> StateView {
        devbox(vec![session("s1", Activity::Active)])
    }

    fn idle() -> StateView {
        devbox(vec![session("s1", Activity::Idle)])
    }

    fn crowd(idle: u64) -> StateView {
        devbox(
            (0..101)
                .map(|i| {
                    let activity = if i < idle {
                        Activity::Idle
                    } else {
                        Activity::Active
                    };
                    session(&format!("s{i}"), activity)
                })
                .collect(),
        )
    }

    fn waiting_on(machine: &str, tmux: Option<&str>) -> Event {
        Event::AgentIdle {
            machine: machine.into(),
            session_id: "s1".into(),
            tmux: tmux.map(str::to_string),
            folder: "acme/api".into(),
            agent: "codex".into(),
        }
    }

    fn waiting_event() -> Event {
        waiting_on("devbox", Some("s1"))
    }

    fn ended_event() -> Event {
        Event::SessionEnded {
            machine: "devbox".into(),
            session_id: "s1".into(),
            folder: "acme/api".into(),
            agent: "codex".into(),
        }
    }

    fn down_event(reason: Option<&str>) -> Event {
        Event::MachineDown {
            machine: "laptop".into(),
            reason: reason.map(str::to_string),
        }
    }

    fn back_event() -> Event {
        Event::MachineUp {
            machine: "laptop".into(),
        }
    }

    fn memory_event() -> Event {
        Event::MemoryHigh {
            machine: "devbox".into(),
            percent: 96,
        }
    }

    struct Rig {
        phone: Phone,
        settings: PhoneNotifications,
        base: Option<&'static str>,
        t0: Instant,
    }

    impl Rig {
        fn new() -> Rig {
            Rig {
                phone: Phone::new(Arc::new(FakeSender::default())),
                settings: PhoneNotifications {
                    topic: "t".into(),
                    ..PhoneNotifications::default()
                },
                base: Some(BASE),
                t0: Instant::now(),
            }
        }

        fn observe(&self, view: &StateView, secs: u64) -> Vec<Push> {
            self.phone.observe(
                &self.settings,
                view,
                self.base,
                self.t0 + Duration::from_secs(secs),
            )
        }
    }

    fn holding() -> Rig {
        let rig = Rig::new();
        rig.observe(&active(), 0);
        rig.observe(&idle(), 1);
        assert_eq!(rig.observe(&idle(), 21), vec![]);
        rig
    }

    fn kinds_sent(settings: PhoneNotifications) -> Vec<String> {
        let rig = Rig {
            settings,
            ..Rig::new()
        };
        let at = |laptop_up: bool, memory: u64, sessions: Vec<SessionView>| {
            view(
                vec![with_memory("devbox", memory), machine("laptop", laptop_up)],
                sessions,
            )
        };
        let active_s1 = || vec![session("s1", Activity::Active)];
        let idle_s1 = || vec![session("s1", Activity::Idle)];
        let steps = [
            (
                0,
                at(
                    true,
                    50,
                    vec![
                        session("s1", Activity::Active),
                        session("s2", Activity::Active),
                    ],
                ),
            ),
            (1, at(false, 96, active_s1())),
            (61, at(false, 96, active_s1())),
            (62, at(true, 96, idle_s1())),
            (82, at(true, 96, idle_s1())),
            (142, at(true, 96, idle_s1())),
        ];
        steps
            .iter()
            .flat_map(|(secs, view)| rig.observe(view, *secs))
            .map(|push| push.tags[0].clone())
            .collect()
    }

    fn fixture() -> Config {
        Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap()
    }

    fn target() -> Target {
        Target {
            server: "http://127.0.0.1:1".into(),
            topic: "t".into(),
            token: None,
        }
    }

    fn push(title: &str) -> Push {
        Push {
            title: title.into(),
            message: "m".into(),
            tags: vec![],
            priority: 3,
            click: None,
        }
    }

    fn fake_phone() -> (Arc<Phone>, Arc<FakeSender>) {
        let sender = Arc::new(FakeSender::default());
        (Arc::new(Phone::new(sender.clone())), sender)
    }

    fn is_rfc3339(stamp: Option<&str>) -> bool {
        stamp.is_some_and(|text| chrono::DateTime::parse_from_rfc3339(text).is_ok())
    }

    #[test]
    fn first_observation_sends_nothing() {
        let rig = Rig::new();
        let v = view(
            vec![machine("devbox", false), with_memory("laptop", 99)],
            vec![session("s1", Activity::Idle)],
        );
        assert_eq!(rig.observe(&v, 0), vec![]);
    }

    #[test]
    fn waiting_is_held_then_sent_when_still_idle() {
        let rig = Rig::new();
        assert_eq!(rig.observe(&active(), 0), vec![]);
        assert_eq!(rig.observe(&idle(), 1), vec![]);
        assert_eq!(rig.observe(&idle(), 21), vec![]);
        assert_eq!(rig.observe(&idle(), 140), vec![]);
        assert_eq!(
            rig.observe(&idle(), 141),
            vec![Push {
                title: "acme/api is waiting".into(),
                message: "Codex on devbox has been waiting for 2 minutes".into(),
                tags: vec!["hourglass_flowing_sand".into()],
                priority: 3,
                click: Some("http://100.64.0.10:4000/term/devbox/s1".into()),
            }]
        );
        assert_eq!(rig.observe(&idle(), 142), vec![]);
    }

    #[test]
    fn waiting_is_dropped_when_answered() {
        let rig = holding();
        assert_eq!(rig.observe(&active(), 141), vec![]);
        assert_eq!(rig.observe(&idle(), 142), vec![]);
    }

    #[test]
    fn waiting_is_dropped_when_answered_then_idle_again_before_due() {
        let rig = holding();
        assert_eq!(rig.observe(&active(), 60), vec![]);
        assert_eq!(rig.observe(&idle(), 125), vec![]);
        assert_eq!(rig.observe(&idle(), 141), vec![]);
        assert_eq!(rig.observe(&idle(), 145), vec![]);
        let pushes = rig.observe(&idle(), 265);
        assert_eq!(pushes.len(), 1);
        assert_eq!(pushes[0].title, "acme/api is waiting");
        assert_eq!(rig.observe(&idle(), 266), vec![]);
    }

    #[test]
    fn waiting_is_dropped_when_the_session_is_gone_or_stale() {
        let rig = holding();
        let titles: Vec<String> = rig
            .observe(&devbox(vec![]), 141)
            .into_iter()
            .map(|push| push.title)
            .collect();
        assert_eq!(titles, ["acme/api ended"]);

        let rig = holding();
        let stale = SessionView {
            stale: true,
            ..session("s1", Activity::Idle)
        };
        assert_eq!(rig.observe(&devbox(vec![stale]), 141), vec![]);
    }

    #[test]
    fn waiting_is_dropped_when_the_machine_is_down_or_removed() {
        let rig = holding();
        let down = view(
            vec![machine("devbox", false)],
            vec![session("s1", Activity::Idle)],
        );
        assert_eq!(rig.observe(&down, 141), vec![]);

        let rig = holding();
        let removed = view(vec![], vec![session("s1", Activity::Idle)]);
        assert_eq!(rig.observe(&removed, 141), vec![]);
    }

    #[test]
    fn zero_wait_sends_at_once() {
        let mut rig = Rig::new();
        rig.settings.wait_minutes = 0;
        assert_eq!(rig.observe(&active(), 0), vec![]);
        assert_eq!(rig.observe(&idle(), 1), vec![]);
        assert_eq!(
            rig.observe(&idle(), 21),
            vec![Push {
                title: "acme/api is waiting".into(),
                message: "Codex on devbox finished or needs you".into(),
                tags: vec!["hourglass_flowing_sand".into()],
                priority: 3,
                click: Some("http://100.64.0.10:4000/term/devbox/s1".into()),
            }]
        );
        assert_eq!(rig.observe(&idle(), 22), vec![]);
    }

    #[test]
    fn a_second_waiting_event_replaces_the_first() {
        let rig = holding();
        assert_eq!(rig.observe(&active(), 30), vec![]);
        assert_eq!(rig.observe(&idle(), 31), vec![]);
        assert_eq!(rig.observe(&idle(), 51), vec![]);
        assert_eq!(rig.observe(&idle(), 141), vec![]);
        assert_eq!(rig.observe(&idle(), 170), vec![]);
        assert_eq!(rig.observe(&idle(), 171).len(), 1);
        assert_eq!(rig.observe(&idle(), 172), vec![]);
    }

    #[test]
    fn the_hold_cap_drops_the_earliest() {
        let mut rig = Rig::new();
        rig.settings.wait_minutes = 5;
        assert_eq!(rig.observe(&crowd(0), 0), vec![]);
        for n in 1..=121 {
            assert_eq!(rig.observe(&crowd(n.min(101)), n), vec![], "t({n})");
        }
        let clicks: Vec<String> = rig
            .observe(&crowd(101), 500)
            .into_iter()
            .filter_map(|push| push.click)
            .collect();
        let expected: Vec<String> = (1..=100)
            .map(|i| format!("{BASE}/term/devbox/s{i}"))
            .collect();
        assert_eq!(clicks, expected);
    }

    #[test]
    fn switches_silence_each_kind() {
        for wait_minutes in [1, 0] {
            let on = || PhoneNotifications {
                topic: "t".into(),
                wait_minutes,
                ..PhoneNotifications::default()
            };
            let cases = [
                (
                    on(),
                    vec![
                        "warning",
                        "checkered_flag",
                        "red_circle",
                        "green_circle",
                        "hourglass_flowing_sand",
                    ],
                ),
                (
                    PhoneNotifications {
                        agent_waiting: false,
                        ..on()
                    },
                    vec!["warning", "checkered_flag", "red_circle", "green_circle"],
                ),
                (
                    PhoneNotifications {
                        session_ended: false,
                        ..on()
                    },
                    vec![
                        "warning",
                        "red_circle",
                        "green_circle",
                        "hourglass_flowing_sand",
                    ],
                ),
                (
                    PhoneNotifications {
                        machines: false,
                        ..on()
                    },
                    vec!["warning", "checkered_flag", "hourglass_flowing_sand"],
                ),
                (
                    PhoneNotifications {
                        memory: false,
                        ..on()
                    },
                    vec![
                        "checkered_flag",
                        "red_circle",
                        "green_circle",
                        "hourglass_flowing_sand",
                    ],
                ),
            ];
            for (settings, expected) in cases {
                assert_eq!(
                    kinds_sent(settings),
                    expected,
                    "wait_minutes {wait_minutes}"
                );
            }
        }
    }

    #[test]
    fn off_sends_nothing_and_forgets_held() {
        let mut rig = holding();
        rig.settings.topic.clear();
        assert_eq!(rig.observe(&idle(), 30), vec![]);
        rig.settings.topic = "t".into();
        assert_eq!(rig.observe(&idle(), 141), vec![]);

        let mut rig = Rig::new();
        rig.settings.topic.clear();
        rig.settings.wait_minutes = 0;
        assert_eq!(rig.observe(&active(), 0), vec![]);
        assert_eq!(rig.observe(&idle(), 1), vec![]);
        assert_eq!(rig.observe(&idle(), 21), vec![]);
        rig.settings.topic = "t".into();
        assert_eq!(rig.observe(&idle(), 141), vec![]);
    }

    #[test]
    fn held_waiting_follows_the_settings_at_release() {
        let mut rig = holding();
        rig.settings.agent_waiting = false;
        assert_eq!(rig.observe(&idle(), 141), vec![]);

        let mut rig = holding();
        rig.settings.agent_waiting = false;
        assert_eq!(rig.observe(&idle(), 60), vec![]);
        rig.settings.agent_waiting = true;
        assert_eq!(rig.observe(&idle(), 141).len(), 1);
    }

    #[test]
    fn held_waiting_keeps_the_minutes_it_was_held_with() {
        for changed_to in [10, 0] {
            let mut rig = holding();
            rig.settings.wait_minutes = changed_to;

            let messages: Vec<String> = rig
                .observe(&idle(), 141)
                .into_iter()
                .map(|push| push.message)
                .collect();

            assert_eq!(
                messages,
                ["Codex on devbox has been waiting for 2 minutes"],
                "wait_minutes changed to {changed_to}"
            );
        }
    }

    #[test]
    fn new_events_come_first_then_released_entries_in_due_order() {
        use Activity::{Active, Idle};
        let mut rig = Rig::new();
        let both = |laptop_up: bool, s1: Activity, s2: Activity| {
            view(
                vec![machine("devbox", true), machine("laptop", laptop_up)],
                vec![session("s1", s1), session("s2", s2)],
            )
        };
        rig.observe(&both(true, Active, Active), 0);
        rig.observe(&both(true, Idle, Active), 1);
        rig.observe(&both(true, Idle, Active), 21);
        rig.settings.wait_minutes = 1;
        rig.observe(&both(true, Idle, Idle), 30);
        rig.observe(&both(true, Idle, Idle), 50);
        rig.observe(&both(false, Idle, Idle), 51);

        let clicks: Vec<Option<String>> = rig
            .observe(&both(false, Idle, Idle), 145)
            .into_iter()
            .map(|push| push.click)
            .collect();

        assert_eq!(
            clicks,
            [
                Some(format!("{BASE}/")),
                Some(format!("{BASE}/term/devbox/s2")),
                Some(format!("{BASE}/term/devbox/s1")),
            ]
        );
    }

    #[test]
    fn push_fields_match_the_table() {
        let expect = |title: &str, message: &str, tag: &str, priority, click: &str| Push {
            title: title.into(),
            message: message.into(),
            tags: vec![tag.into()],
            priority,
            click: Some(click.into()),
        };
        let home = format!("{BASE}/");
        let cases = [
            (
                waiting_event(),
                expect(
                    "acme/api is waiting",
                    "Codex on devbox has been waiting for 2 minutes",
                    "hourglass_flowing_sand",
                    3,
                    &format!("{BASE}/term/devbox/s1"),
                ),
            ),
            (
                ended_event(),
                expect(
                    "acme/api ended",
                    "Codex on devbox",
                    "checkered_flag",
                    2,
                    &home,
                ),
            ),
            (
                down_event(Some("ssh timed out")),
                expect("laptop is down", "ssh timed out", "red_circle", 4, &home),
            ),
            (
                down_event(None),
                expect("Yardbell", "laptop is down", "red_circle", 4, &home),
            ),
            (
                back_event(),
                expect("Yardbell", "laptop is back", "green_circle", 3, &home),
            ),
            (
                memory_event(),
                expect("Yardbell", "devbox memory at 96%", "warning", 4, &home),
            ),
        ];
        let v = devbox(vec![]);
        for (event, expected) in cases {
            assert_eq!(push_for(&event, &v, Some(BASE), 2), expected);
        }
    }

    #[test]
    fn click_link_encodes_each_segment() {
        let click = |machine: &str, tmux: &str| {
            push_for(
                &waiting_on(machine, Some(tmux)),
                &devbox(vec![]),
                Some(BASE),
                2,
            )
            .click
        };
        assert_eq!(
            click("dev box", "a b/ü").as_deref(),
            Some("http://100.64.0.10:4000/term/dev%20box/a%20b%2F%C3%BC")
        );
        assert_eq!(
            click("dev-box.1", "Eng_1~x").as_deref(),
            Some("http://100.64.0.10:4000/term/dev-box.1/Eng_1~x")
        );
    }

    #[test]
    fn a_waiting_session_without_a_tmux_name_links_to_the_dashboard() {
        for tmux in [None, Some("")] {
            let push = push_for(&waiting_on("devbox", tmux), &devbox(vec![]), Some(BASE), 2);
            assert_eq!(push.click.as_deref(), Some("http://100.64.0.10:4000/"));
        }
    }

    #[test]
    fn click_is_left_out_without_a_base() {
        let v = devbox(vec![]);
        for event in [
            waiting_event(),
            ended_event(),
            down_event(None),
            back_event(),
            memory_event(),
        ] {
            assert_eq!(push_for(&event, &v, None, 2).click, None);
        }

        let mut rig = holding();
        rig.base = None;
        let pushes = rig.observe(&idle(), 141);
        assert_eq!(pushes.len(), 1);
        assert_eq!(pushes[0].click, None);
    }

    #[test]
    fn base_url_uses_the_first_non_loopback_address() {
        let mut cfg = fixture();
        assert_eq!(base_url(&cfg).as_deref(), Some("http://100.64.0.10:4000"));

        cfg.listen_ip = Some("100.64.0.99".into());
        cfg.port = 4100;
        assert_eq!(base_url(&cfg).as_deref(), Some("http://100.64.0.99:4100"));

        cfg.listen_ip = None;
        cfg.machines[0].mesh_ip = None;
        assert_eq!(base_url(&cfg), None);
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_records_last_sent() {
        let (phone, sender) = fake_phone();

        phone.deliver(&target(), &push("a")).await;

        assert_eq!(sender.calls(), vec![(target(), push("a"))]);
        let status = phone.status();
        assert!(is_rfc3339(status.last_sent.as_deref()));
        assert_eq!(status.last_error, None);
        assert_eq!(status.last_error_at, None);
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_retries_once_then_records_the_error() {
        let (phone, sender) = fake_phone();
        sender.fail_all("ntfy answered 500");
        let started = tokio::time::Instant::now();

        phone.deliver(&target(), &push("a")).await;

        assert_eq!(sender.calls().len(), 2);
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        let status = phone.status();
        assert_eq!(status.last_error.as_deref(), Some("ntfy answered 500"));
        assert!(is_rfc3339(status.last_error_at.as_deref()));
        assert_eq!(status.last_sent, None);
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_succeeds_on_the_retry() {
        let (phone, sender) = fake_phone();
        sender.fail_next(1, "ntfy answered 503");

        phone.deliver(&target(), &push("a")).await;

        assert_eq!(sender.calls().len(), 2);
        let status = phone.status();
        assert!(is_rfc3339(status.last_sent.as_deref()));
        assert_eq!(status.last_error, None);
        assert_eq!(status.last_error_at, None);
    }

    #[tokio::test]
    async fn test_sends_exactly_one_request() {
        let (phone, sender) = fake_phone();
        assert_eq!(phone.test(&target(), "mini").await, Ok(()));
        assert_eq!(
            sender.calls(),
            vec![(
                target(),
                Push {
                    title: "Yardbell".into(),
                    message: "Notifications from mini work.".into(),
                    tags: vec![],
                    priority: 3,
                    click: None,
                }
            )]
        );
        assert!(is_rfc3339(phone.status().last_sent.as_deref()));

        let (phone, sender) = fake_phone();
        sender.fail_all("no route");
        assert_eq!(
            phone.test(&target(), "mini").await,
            Err("no route".to_string())
        );
        assert_eq!(sender.calls().len(), 1);
        let status = phone.status();
        assert_eq!(status.last_error.as_deref(), Some("no route"));
        assert!(is_rfc3339(status.last_error_at.as_deref()));
    }

    #[tokio::test(start_paused = true)]
    async fn dispatch_sends_every_push_even_when_one_fails() {
        let (phone, sender) = fake_phone();
        sender.fail_title("push 2", "ntfy answered 500");
        let pushes: Vec<Push> = (1..=5).map(|n| push(&format!("push {n}"))).collect();

        phone.dispatch(target(), pushes);
        tokio::time::sleep(Duration::from_secs(60)).await;

        let titles: Vec<String> = sender
            .calls()
            .into_iter()
            .map(|(_, push)| push.title)
            .collect();
        assert_eq!(
            titles,
            ["push 1", "push 2", "push 3", "push 4", "push 5", "push 2"]
        );
        let status = phone.status();
        assert!(is_rfc3339(status.last_sent.as_deref()));
        assert_eq!(status.last_error.as_deref(), Some("ntfy answered 500"));
    }

    #[tokio::test(start_paused = true)]
    async fn errors_never_keep_the_token() {
        let to = Target {
            token: Some("tk_secret".into()),
            ..target()
        };

        let (phone, sender) = fake_phone();
        sender.fail_all("denied tk_secret");
        phone.deliver(&to, &push("a")).await;
        assert_eq!(phone.status().last_error.as_deref(), Some("denied [token]"));
        assert_eq!(
            phone.test(&to, "mini").await,
            Err("denied [token]".to_string())
        );
        assert_eq!(phone.status().last_error.as_deref(), Some("denied [token]"));

        let (phone, sender) = fake_phone();
        sender.fail_all("tk_secret then tk_secret");
        assert_eq!(
            phone.test(&to, "mini").await,
            Err("[token] then [token]".to_string())
        );
    }

    #[tokio::test]
    async fn errors_are_unchanged_without_a_token() {
        let (phone, sender) = fake_phone();
        sender.fail_all("denied");
        assert_eq!(
            phone.test(&target(), "mini").await,
            Err("denied".to_string())
        );
        let empty = Target {
            token: Some(String::new()),
            ..target()
        };
        assert_eq!(phone.test(&empty, "mini").await, Err("denied".to_string()));
    }
}
