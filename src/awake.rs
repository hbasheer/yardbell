use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    On,
    Agent,
    #[default]
    Off,
}

impl Mode {
    pub fn is_off(&self) -> bool {
        *self == Mode::Off
    }
}

pub fn wanted(mode: Mode, working: bool) -> bool {
    match mode {
        Mode::On => true,
        Mode::Agent => working,
        Mode::Off => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Start,
    Stop,
    Stay,
}

pub fn step(want: bool, holding: bool) -> Step {
    match (want, holding) {
        (true, false) => Step::Start,
        (false, true) => Step::Stop,
        _ => Step::Stay,
    }
}

pub trait Hold: Send {
    // None while the hold is in place, or why it ended.
    fn ended(&mut self) -> Option<String>;
    fn release(&mut self);
}

pub trait Inhibitor: Send + Sync {
    fn tool(&self) -> Option<String>;
    fn hold(&self) -> Result<Box<dyn Hold>, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub mode: Mode,
    pub holding: bool,
    pub working: bool,
    pub tool: Option<String>,
    pub error: Option<String>,
}

struct Inner {
    mode: Mode,
    // The mode in yardbell.yml at the last check. A check reads the file before Settings may
    // change it, so only a change in the file itself moves the mode.
    seen: Option<Mode>,
    working: bool,
    hold: Option<Box<dyn Hold>>,
    error: Option<String>,
}

pub struct Awake {
    inhibitor: Box<dyn Inhibitor>,
    inner: Mutex<Inner>,
}

impl Awake {
    pub fn new(inhibitor: Box<dyn Inhibitor>) -> Awake {
        Awake {
            inhibitor,
            inner: Mutex::new(Inner {
                mode: Mode::Off,
                seen: None,
                working: false,
                hold: None,
                error: None,
            }),
        }
    }

    pub fn system() -> Awake {
        Awake::new(Box::new(System::from_path(std::process::id())))
    }

    pub fn observe(&self, configured: Mode, working: bool) -> Status {
        let mut inner = self.inner.lock().expect("awake lock");
        if inner.seen != Some(configured) {
            inner.seen = Some(configured);
            inner.mode = configured;
        }
        inner.working = working;
        self.apply(&mut inner);
        self.status_of(&inner)
    }

    pub fn set_mode(&self, mode: Mode) -> Status {
        let mut inner = self.inner.lock().expect("awake lock");
        inner.mode = mode;
        self.apply(&mut inner);
        self.status_of(&inner)
    }

    pub fn status(&self) -> Status {
        let mut inner = self.inner.lock().expect("awake lock");
        self.check(&mut inner);
        self.status_of(&inner)
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().expect("awake lock");
        if let Some(mut hold) = inner.hold.take() {
            hold.release();
        }
    }

    fn check(&self, inner: &mut Inner) {
        let ended = inner.hold.as_mut().and_then(|h| h.ended());
        if let Some(why) = ended {
            tracing::warn!(why = %why, "keeping the computer awake stopped");
            inner.hold = None;
            inner.error = Some(why);
        }
    }

    fn apply(&self, inner: &mut Inner) {
        self.check(inner);
        match step(wanted(inner.mode, inner.working), inner.hold.is_some()) {
            Step::Start => match self.inhibitor.hold() {
                Ok(hold) => {
                    inner.hold = Some(hold);
                    inner.error = None;
                }
                Err(e) => {
                    if inner.error.as_deref() != Some(e.as_str()) {
                        tracing::warn!(error = %e, "cannot keep the computer awake");
                    }
                    inner.error = Some(e);
                }
            },
            Step::Stop => {
                if let Some(mut hold) = inner.hold.take() {
                    hold.release();
                }
                inner.error = None;
            }
            Step::Stay => {
                if inner.mode.is_off() {
                    inner.error = None;
                }
            }
        }
    }

    fn status_of(&self, inner: &Inner) -> Status {
        Status {
            mode: inner.mode,
            holding: inner.hold.is_some(),
            working: inner.working,
            tool: self.inhibitor.tool(),
            error: inner.error.clone(),
        }
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct System {
    tool: Option<PathBuf>,
    owner: u32,
}

impl System {
    pub fn from_path(owner: u32) -> System {
        let name = if cfg!(target_os = "macos") {
            "caffeinate"
        } else {
            "systemd-inhibit"
        };
        let tool = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(name))
                .find(|p| is_executable(p))
        });
        System { tool, owner }
    }

    fn command(&self, tool: &Path) -> Command {
        let mut cmd = Command::new(tool);
        if cfg!(target_os = "macos") {
            cmd.args(["-i", "-w", &self.owner.to_string()]);
        } else {
            // The held command ends with Yardbell, so a Yardbell that is killed outright leaves
            // nothing behind.
            cmd.args([
                "--what=idle:sleep",
                "--who=Yardbell",
                "--why=Keeping the computer awake",
                "--mode=block",
                "sh",
                "-c",
                "while kill -0 \"$1\" 2>/dev/null; do sleep 5; done",
                "sh",
                &self.owner.to_string(),
            ]);
        }
        cmd
    }
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

impl Inhibitor for System {
    fn tool(&self) -> Option<String> {
        self.tool
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
    }

    fn hold(&self) -> Result<Box<dyn Hold>, String> {
        let Some(tool) = &self.tool else {
            return Err(if cfg!(target_os = "macos") {
                "caffeinate is not on this computer's PATH".into()
            } else {
                "systemd-inhibit is not on this computer's PATH, so Yardbell cannot keep it awake"
                    .into()
            });
        };
        use std::os::unix::process::CommandExt;
        let child = self
            .command(tool)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", tool.display()))?;
        Ok(Box::new(Held { child }))
    }
}

struct Held {
    child: Child,
}

impl Held {
    fn stderr(&mut self) -> String {
        let mut text = String::new();
        if let Some(mut err) = self.child.stderr.take() {
            let _ = err.read_to_string(&mut text);
        }
        text.trim().to_string()
    }
}

impl Hold for Held {
    fn ended(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => {
                let said = self.stderr();
                Some(if said.is_empty() {
                    format!("the inhibitor exited ({status})")
                } else {
                    format!("the inhibitor exited: {said}")
                })
            }
            Err(e) => Some(format!("the inhibitor cannot be checked: {e}")),
        }
    }

    // The group goes too: systemd-inhibit does not pass a signal on to the command it holds.
    fn release(&mut self) {
        let Ok(group) = i32::try_from(self.child.id()) else {
            return;
        };
        unsafe {
            libc::kill(-group, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
        let _ = self.child.wait();
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            self.release();
        }
    }
}

#[cfg(test)]
pub struct Pretend;

#[cfg(test)]
impl Inhibitor for Pretend {
    fn tool(&self) -> Option<String> {
        Some("systemd-inhibit".into())
    }
    fn hold(&self) -> Result<Box<dyn Hold>, String> {
        struct Still;
        impl Hold for Still {
            fn ended(&mut self) -> Option<String> {
                None
            }
            fn release(&mut self) {}
        }
        Ok(Box::new(Still))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    struct Counts {
        holds: AtomicUsize,
        releases: AtomicUsize,
        fail: AtomicBool,
        die: AtomicBool,
    }

    struct Fake(Arc<Counts>);

    struct FakeHold(Arc<Counts>, bool);

    impl Hold for FakeHold {
        fn ended(&mut self) -> Option<String> {
            self.0
                .die
                .swap(false, Ordering::SeqCst)
                .then(|| "the inhibitor exited (signal 9)".to_string())
        }
        fn release(&mut self) {
            if !self.1 {
                self.1 = true;
                self.0.releases.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    impl Drop for FakeHold {
        fn drop(&mut self) {
            self.release();
        }
    }

    impl Inhibitor for Fake {
        fn tool(&self) -> Option<String> {
            Some("systemd-inhibit".into())
        }
        fn hold(&self) -> Result<Box<dyn Hold>, String> {
            if self.0.fail.load(Ordering::SeqCst) {
                return Err("systemd-inhibit is not on this computer's PATH".into());
            }
            self.0.holds.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeHold(self.0.clone(), false)))
        }
    }

    fn awake() -> (Awake, Arc<Counts>) {
        let counts = Arc::new(Counts::default());
        (Awake::new(Box::new(Fake(counts.clone()))), counts)
    }

    fn holds(c: &Counts) -> (usize, usize) {
        (
            c.holds.load(Ordering::SeqCst),
            c.releases.load(Ordering::SeqCst),
        )
    }

    #[test]
    fn each_mode_wants_what_its_name_says() {
        assert!(wanted(Mode::On, false));
        assert!(wanted(Mode::On, true));
        assert!(wanted(Mode::Agent, true));
        assert!(!wanted(Mode::Agent, false));
        assert!(!wanted(Mode::Off, true));
        assert!(!wanted(Mode::Off, false));
    }

    #[test]
    fn a_step_starts_or_stops_only_on_a_change() {
        assert_eq!(step(true, false), Step::Start);
        assert_eq!(step(false, true), Step::Stop);
        assert_eq!(step(true, true), Step::Stay);
        assert_eq!(step(false, false), Step::Stay);
    }

    #[test]
    fn on_holds_once_however_often_it_is_told() {
        let (a, c) = awake();
        assert!(a.observe(Mode::On, false).holding);
        a.observe(Mode::On, false);
        a.observe(Mode::On, true);
        assert_eq!(holds(&c), (1, 0));
        let off = a.set_mode(Mode::Off);
        assert!(!off.holding);
        assert_eq!(holds(&c), (1, 1));
    }

    #[test]
    fn agent_holds_only_while_a_session_works() {
        let (a, c) = awake();
        assert!(!a.observe(Mode::Agent, false).holding);
        assert!(a.observe(Mode::Agent, true).holding);
        assert!(a.observe(Mode::Agent, true).holding);
        assert!(!a.observe(Mode::Agent, false).holding);
        assert!(a.observe(Mode::Agent, true).holding);
        assert_eq!(holds(&c), (2, 1));
    }

    #[test]
    fn switching_to_agent_keeps_the_last_known_work() {
        let (a, c) = awake();
        a.observe(Mode::Off, true);
        assert!(a.set_mode(Mode::Agent).holding);
        assert_eq!(holds(&c), (1, 0));
    }

    #[test]
    fn a_check_that_read_the_file_before_a_change_does_not_undo_it() {
        let (a, c) = awake();
        a.observe(Mode::Off, false);
        assert!(a.set_mode(Mode::On).holding);
        assert!(a.observe(Mode::Off, false).holding);
        assert!(a.observe(Mode::On, false).holding);
        assert_eq!(holds(&c), (1, 0));
        assert!(
            !a.observe(Mode::Off, false).holding,
            "an edit to the file still counts"
        );
    }

    #[test]
    fn a_hold_that_dies_is_reported_and_taken_again() {
        let (a, c) = awake();
        a.observe(Mode::On, false);
        c.die.store(true, Ordering::SeqCst);
        let seen = a.status();
        assert!(!seen.holding);
        assert_eq!(
            seen.error.as_deref(),
            Some("the inhibitor exited (signal 9)")
        );
        let again = a.observe(Mode::On, false);
        assert!(again.holding);
        assert_eq!(again.error, None);
        assert_eq!(holds(&c).0, 2);
    }

    #[test]
    fn a_missing_tool_is_reported_until_off() {
        let (a, c) = awake();
        c.fail.store(true, Ordering::SeqCst);
        let on = a.observe(Mode::On, false);
        assert!(!on.holding);
        assert_eq!(
            on.error.as_deref(),
            Some("systemd-inhibit is not on this computer's PATH")
        );
        assert_eq!(a.set_mode(Mode::Off).error, None);
    }

    #[test]
    fn stop_and_drop_release_the_hold() {
        let (a, c) = awake();
        a.observe(Mode::On, false);
        a.stop();
        assert_eq!(holds(&c), (1, 1));
        a.observe(Mode::On, false);
        drop(a);
        assert_eq!(holds(&c), (2, 2));
    }

    #[test]
    fn the_mode_reads_and_writes_as_lowercase_words() {
        assert_eq!(serde_json::to_string(&Mode::Agent).unwrap(), "\"agent\"");
        let on: Mode = serde_json::from_str("\"on\"").unwrap();
        assert_eq!(on, Mode::On);
        assert!(serde_json::from_str::<Mode>("\"always\"").is_err());
    }

    #[test]
    fn the_real_inhibitor_is_released_with_its_group() {
        let dir = std::env::temp_dir().join(format!("yardbell-awake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("systemd-inhibit");
        std::fs::write(
            &fake,
            "#!/bin/sh\nwhile [ \"${1#--}\" != \"$1\" ]; do shift; done\nexec \"$@\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let system = System {
            tool: Some(if cfg!(target_os = "macos") {
                PathBuf::from("/usr/bin/caffeinate")
            } else {
                fake.clone()
            }),
            owner: std::process::id(),
        };
        if cfg!(target_os = "macos") && !is_executable(Path::new("/usr/bin/caffeinate")) {
            return;
        }
        let mut hold = system.hold().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(hold.ended(), None);
        hold.release();
        assert!(hold.ended().is_some());
        std::fs::remove_dir_all(&dir).ok();
    }
}
