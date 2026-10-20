use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_FAILURES: usize = 5;
const WINDOW: Duration = Duration::from_secs(60);
const LOCKOUT: Duration = Duration::from_secs(300);

pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Wrong,
    Locked,
}

pub fn hash(passcode: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(passcode.as_bytes(), &salt)
        .expect("argon2 hashing with default params")
        .to_string()
}

#[derive(Default)]
struct Attempts {
    failures: Vec<Instant>,
    locked_until: Option<Instant>,
}

pub struct Auth {
    hash: Mutex<String>,
    clock: Clock,
    attempts: Mutex<HashMap<IpAddr, Attempts>>,
}

impl Auth {
    pub fn new(hash: String, clock: Clock) -> Auth {
        Auth {
            hash: Mutex::new(hash),
            clock,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    pub fn verify(&self, passcode: &str, ip: IpAddr) -> Verdict {
        let now = (self.clock)();
        let mut attempts = self.attempts.lock().expect("auth lock");
        let entry = attempts.entry(ip).or_default();
        if let Some(until) = entry.locked_until {
            if now < until {
                return Verdict::Locked;
            }
            *entry = Attempts::default();
        }
        if self.matches(passcode) {
            entry.failures.clear();
            return Verdict::Ok;
        }
        entry.failures.retain(|t| now.duration_since(*t) < WINDOW);
        entry.failures.push(now);
        if entry.failures.len() >= MAX_FAILURES {
            entry.locked_until = Some(now + LOCKOUT);
        }
        Verdict::Wrong
    }

    pub fn set_hash(&self, hash: String) {
        *self.hash.lock().expect("auth lock") = hash;
    }

    fn matches(&self, passcode: &str) -> bool {
        let stored = self.hash.lock().expect("auth lock").clone();
        let Ok(parsed) = PasswordHash::new(&stored) else {
            return false;
        };
        Argon2::default()
            .verify_password(passcode.as_bytes(), &parsed)
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::sync::Mutex;

    struct Rig {
        now: Arc<Mutex<Instant>>,
        start: Instant,
        auth: Auth,
    }

    fn rig() -> Rig {
        let start = Instant::now();
        let now = Arc::new(Mutex::new(start));
        let clock_now = now.clone();
        let auth = Auth::new(
            hash("open sesame"),
            Arc::new(move || *clock_now.lock().unwrap()),
        );
        Rig { now, start, auth }
    }

    impl Rig {
        fn at(&self, secs: u64) {
            *self.now.lock().unwrap() = self.start + Duration::from_secs(secs);
        }
    }

    fn ip(last: u8) -> IpAddr {
        IpAddr::from([100, 64, 0, last])
    }

    #[test]
    fn right_and_wrong() {
        let r = rig();
        assert_eq!(r.auth.verify("open sesame", ip(1)), Verdict::Ok);
        assert_eq!(r.auth.verify("nope", ip(1)), Verdict::Wrong);
    }

    #[test]
    fn five_failures_lock_for_five_minutes() {
        let r = rig();
        for _ in 0..5 {
            assert_eq!(r.auth.verify("nope", ip(1)), Verdict::Wrong);
        }
        assert_eq!(r.auth.verify("open sesame", ip(1)), Verdict::Locked);
        r.at(299);
        assert_eq!(r.auth.verify("open sesame", ip(1)), Verdict::Locked);
        r.at(300);
        assert_eq!(r.auth.verify("open sesame", ip(1)), Verdict::Ok);
    }

    #[test]
    fn old_failures_expire() {
        let r = rig();
        for _ in 0..4 {
            r.auth.verify("nope", ip(1));
        }
        r.at(61);
        assert_eq!(r.auth.verify("nope", ip(1)), Verdict::Wrong);
        assert_eq!(r.auth.verify("open sesame", ip(1)), Verdict::Ok);
    }

    #[test]
    fn lockout_is_per_ip() {
        let r = rig();
        for _ in 0..5 {
            r.auth.verify("nope", ip(1));
        }
        assert_eq!(r.auth.verify("open sesame", ip(2)), Verdict::Ok);
    }

    #[test]
    fn hash_is_argon2id() {
        assert!(hash("x").starts_with("$argon2id$"));
    }

    #[test]
    fn bad_stored_hash_never_matches() {
        let auth = Auth::new("garbage".into(), Arc::new(Instant::now));
        assert_eq!(auth.verify("garbage", ip(1)), Verdict::Wrong);
    }
}
