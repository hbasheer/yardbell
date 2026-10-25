use super::Push;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const KEPT: usize = 50;
pub const LISTENING_FOR: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub title: String,
    pub message: String,
    pub priority: u8,
    pub click: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page {
    pub boot: String,
    pub next: u64,
    pub notes: Vec<Note>,
}

#[derive(Default)]
struct Kept {
    next: u64,
    notes: VecDeque<(u64, Note)>,
    polled: Option<Instant>,
}

// The phone app long-polls this instead of a push service. Sequence numbers start over when the
// server restarts, so `boot` tells the app its cursor belongs to an earlier run.
pub struct Inbox {
    boot: String,
    kept: Mutex<Kept>,
    changed: Notify,
}

impl Default for Inbox {
    fn default() -> Inbox {
        Inbox {
            boot: format!("{:016x}", rand::random::<u64>()),
            kept: Mutex::new(Kept::default()),
            changed: Notify::new(),
        }
    }
}

impl Inbox {
    pub fn add(&self, pushes: &[Push]) {
        if pushes.is_empty() {
            return;
        }
        let mut kept = self.kept.lock().expect("inbox lock");
        for push in pushes {
            let seq = kept.next;
            kept.next += 1;
            kept.notes.push_back((
                seq,
                Note {
                    title: push.title.clone(),
                    message: push.message.clone(),
                    priority: push.priority,
                    click: push.click.clone(),
                },
            ));
        }
        while kept.notes.len() > KEPT {
            kept.notes.pop_front();
        }
        drop(kept);
        self.changed.notify_waiters();
    }

    pub fn listening(&self, now: Instant) -> bool {
        let kept = self.kept.lock().expect("inbox lock");
        kept.polled
            .is_some_and(|at| now.saturating_duration_since(at) < LISTENING_FOR)
    }

    pub fn page(&self, boot: Option<&str>, after: u64, now: Instant) -> Page {
        let mut kept = self.kept.lock().expect("inbox lock");
        kept.polled = Some(now);
        let notes = match boot {
            None => Vec::new(),
            Some(boot) if boot != self.boot => kept.notes.iter().map(|(_, n)| n.clone()).collect(),
            Some(_) => kept
                .notes
                .iter()
                .filter(|(seq, _)| *seq >= after)
                .map(|(_, n)| n.clone())
                .collect(),
        };
        Page {
            boot: self.boot.clone(),
            next: kept.next,
            notes,
        }
    }

    pub async fn wait(&self, boot: Option<&str>, after: u64, timeout: Duration) -> Page {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let changed = self.changed.notified();
            let page = self.page(boot, after, Instant::now());
            if !page.notes.is_empty() || boot.is_none() {
                return page;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.page(boot, after, Instant::now());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(title: &str) -> Push {
        Push {
            title: title.into(),
            message: "m".into(),
            tags: Vec::new(),
            priority: 3,
            click: None,
        }
    }

    fn titles(page: &Page) -> Vec<&str> {
        page.notes.iter().map(|n| n.title.as_str()).collect()
    }

    #[test]
    fn first_contact_only_gets_a_cursor() {
        let inbox = Inbox::default();
        inbox.add(&[push("old")]);
        let page = inbox.page(None, 0, Instant::now());
        assert!(page.notes.is_empty());
        assert_eq!(page.next, 1);
    }

    #[test]
    fn a_cursor_gets_what_came_after_it() {
        let inbox = Inbox::default();
        let start = inbox.page(None, 0, Instant::now());
        inbox.add(&[push("a"), push("b")]);
        let page = inbox.page(Some(&start.boot), start.next, Instant::now());
        assert_eq!(titles(&page), ["a", "b"]);
        let again = inbox.page(Some(&page.boot), page.next, Instant::now());
        assert!(again.notes.is_empty());
    }

    #[test]
    fn a_cursor_from_an_earlier_run_gets_everything_kept() {
        let inbox = Inbox::default();
        inbox.add(&[push("since restart")]);
        let page = inbox.page(Some("earlier"), 7, Instant::now());
        assert_eq!(titles(&page), ["since restart"]);
    }

    #[test]
    fn only_the_latest_are_kept() {
        let inbox = Inbox::default();
        let start = inbox.page(None, 0, Instant::now());
        let many: Vec<Push> = (0..KEPT + 5).map(|i| push(&i.to_string())).collect();
        inbox.add(&many);
        let page = inbox.page(Some(&start.boot), 0, Instant::now());
        assert_eq!(page.notes.len(), KEPT);
        assert_eq!(page.notes[0].title, "5");
    }

    #[test]
    fn listening_lasts_a_while_after_a_poll() {
        let inbox = Inbox::default();
        let now = Instant::now();
        assert!(!inbox.listening(now));
        inbox.page(None, 0, now);
        assert!(inbox.listening(now + LISTENING_FOR / 2));
        assert!(!inbox.listening(now + LISTENING_FOR));
    }

    #[tokio::test]
    async fn a_waiting_poll_wakes_when_a_note_arrives() {
        let inbox = std::sync::Arc::new(Inbox::default());
        let start = inbox.page(None, 0, Instant::now());
        let waiter = {
            let inbox = inbox.clone();
            let boot = start.boot.clone();
            tokio::spawn(async move {
                inbox
                    .wait(Some(&boot), start.next, Duration::from_secs(5))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        inbox.add(&[push("now")]);
        let page = waiter.await.unwrap();
        assert_eq!(titles(&page), ["now"]);
    }
}
