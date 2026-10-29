use super::definition::{Definition, Trigger};
use super::record::{PrRef, Subject, TicketRef};
use crate::pulls::{GitLab, GitLabAccess, Mr};
use crate::triggers::{Feeds, GhList, Schedule};
use chrono::{DateTime, Duration, Local};
use futures::future::BoxFuture;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

const POLL_MINUTES: i64 = 3;
const KEEP_DAYS: i64 = 30;

pub trait Reviewing: Send + Sync {
    fn reviewing<'a>(&'a self, access: &'a GitLabAccess) -> BoxFuture<'a, Result<Vec<Mr>, String>>;
}

impl Reviewing for GitLab {
    fn reviewing<'a>(&'a self, access: &'a GitLabAccess) -> BoxFuture<'a, Result<Vec<Mr>, String>> {
        Box::pin(GitLab::reviewing(self, access))
    }
}

// Where the triggers look, gathered for one round.
pub struct Sources<'a> {
    pub feeds: &'a dyn Feeds,
    pub gitlab: &'a dyn Reviewing,
    pub accesses: Vec<GitLabAccess>,
    pub linear_key: Result<String, String>,
    pub pattern: Option<Regex>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Kept {
    pub baseline: bool,
    pub seen: BTreeMap<String, String>,
    pub anchor: String,
    pub checked: String,
    pub problem: String,
}

pub struct Watch {
    file: PathBuf,
    kept: Mutex<BTreeMap<String, Kept>>,
    polls: Mutex<HashMap<String, DateTime<Local>>>,
}

// The Linear identifier a pull or merge request names: in its branch first, then its title.
pub fn ticket_in(branch: &str, title: &str, pattern: Option<&Regex>) -> Option<String> {
    let shape = Regex::new(r"(?i)\b([a-z][a-z0-9]+-\d+)").expect("static regex");
    for text in [branch, title] {
        let found = match pattern {
            Some(p) => p.find(text).map(|m| m.as_str().to_string()),
            None => None,
        }
        .or_else(|| shape.captures(text).map(|c| c[1].to_string()));
        if let Some(id) = found {
            return Some(id.to_uppercase());
        }
    }
    None
}

fn named(id: Option<String>, title: &str) -> Option<TicketRef> {
    id.map(|id| TicketRef {
        linear_id: id.clone(),
        id,
        title: title.to_string(),
        url: String::new(),
    })
}

impl Watch {
    pub fn load(file: PathBuf) -> Watch {
        let kept = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Watch {
            file,
            kept: Mutex::new(kept),
            polls: Mutex::new(HashMap::new()),
        }
    }

    pub fn kept(&self, id: &str) -> Kept {
        self.kept
            .lock()
            .expect("watch lock")
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    fn save(&self) {
        let bytes =
            serde_json::to_vec_pretty(&*self.kept.lock().expect("watch lock")).unwrap_or_default();
        let tmp = self.file.with_extension("tmp");
        let written = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = written {
            tracing::warn!(error = %e, "could not save {}", self.file.display());
        }
    }

    fn time_to_poll(&self, id: &str, now: DateTime<Local>) -> bool {
        let mut polls = self.polls.lock().expect("watch polls");
        match polls.get(id) {
            Some(last) if now - *last < Duration::minutes(POLL_MINUTES) => false,
            _ => {
                polls.insert(id.to_string(), now);
                true
            }
        }
    }

    // The items each switched-on pipeline should start a run for now.
    pub async fn due(
        &self,
        defs: &[Definition],
        src: &Sources<'_>,
        now: DateTime<Local>,
    ) -> Vec<(String, Subject)> {
        let mut out = Vec::new();
        for def in defs.iter().filter(|d| d.enabled) {
            let found = match &def.trigger {
                Trigger::Manual => continue,
                Trigger::Schedule { schedule, state } => {
                    match self.scheduled(def, schedule, state, src, now).await {
                        Some(subjects) => subjects,
                        None => continue,
                    }
                }
                _ if !self.time_to_poll(&def.id, now) => continue,
                trigger => match self.items(trigger, src).await {
                    Ok(items) => self.fresh(&def.id, items, now),
                    Err(problem) => {
                        self.edit(&def.id, |k| k.problem = problem);
                        continue;
                    }
                },
            };
            out.extend(found.into_iter().map(|s| (def.id.clone(), s)));
        }
        self.save();
        out
    }

    fn edit<T>(&self, id: &str, change: impl FnOnce(&mut Kept) -> T) -> T {
        change(
            self.kept
                .lock()
                .expect("watch lock")
                .entry(id.to_string())
                .or_default(),
        )
    }

    async fn scheduled(
        &self,
        def: &Definition,
        schedule: &str,
        state: &str,
        src: &Sources<'_>,
        now: DateTime<Local>,
    ) -> Option<Vec<Subject>> {
        let s = Schedule::parse(schedule).ok()?;
        let anchor = self.edit(&def.id, |k| {
            DateTime::parse_from_rfc3339(&k.anchor)
                .ok()
                .map(|a| a.with_timezone(&Local))
        });
        let Some(anchor) = anchor else {
            self.edit(&def.id, |k| k.anchor = now.to_rfc3339());
            return None;
        };
        s.due(&anchor, &now)?;
        self.edit(&def.id, |k| k.anchor = now.to_rfc3339());
        if state.trim().is_empty() {
            return Some(vec![Subject::default()]);
        }
        let key = src.linear_key.clone().ok()?;
        let tickets = src.feeds.linear(&key).await.ok()?;
        Some(
            tickets
                .into_iter()
                .filter(|t| t.state.eq_ignore_ascii_case(state.trim()))
                .map(|t| Subject {
                    ticket: Some(TicketRef {
                        linear_id: t.id,
                        id: t.ticket,
                        title: t.title,
                        url: t.url,
                    }),
                    pr: None,
                })
                .collect(),
        )
    }

    async fn items(
        &self,
        trigger: &Trigger,
        src: &Sources<'_>,
    ) -> Result<Vec<(String, Subject)>, String> {
        let pattern = src.pattern.as_ref();
        match trigger {
            Trigger::Linear { assigned, states } => {
                let key = src.linear_key.clone()?;
                let mut items = Vec::new();
                for t in src.feeds.linear(&key).await? {
                    let subject = Subject {
                        ticket: Some(TicketRef {
                            linear_id: t.id.clone(),
                            id: t.ticket.clone(),
                            title: t.title.clone(),
                            url: t.url.clone(),
                        }),
                        pr: None,
                    };
                    if *assigned {
                        items.push((format!("assigned:{}", t.id), subject.clone()));
                    }
                    if states.iter().any(|s| s.eq_ignore_ascii_case(&t.state)) {
                        items.push((
                            format!("state:{}:{}", t.id, t.state.to_lowercase()),
                            subject,
                        ));
                    }
                }
                Ok(items)
            }
            Trigger::GithubReview => Ok(src
                .feeds
                .github(GhList::ReviewRequested)
                .await?
                .into_iter()
                .map(|t| {
                    let number = t
                        .url
                        .rsplit('/')
                        .next()
                        .and_then(|n| n.parse().ok())
                        .unwrap_or_default();
                    let subject = Subject {
                        ticket: named(ticket_in("", &t.title, pattern), &t.title),
                        pr: Some(PrRef {
                            url: t.url.clone(),
                            number,
                            branch: String::new(),
                            host: "github.com".into(),
                            project: t.repo.clone(),
                            forge: "github".into(),
                        }),
                    };
                    (format!("pr:{}", t.url), subject)
                })
                .collect()),
            Trigger::GitlabReviewer { host } => {
                let access = src
                    .accesses
                    .iter()
                    .find(|a| a.host.eq_ignore_ascii_case(host.trim()))
                    .ok_or_else(|| format!("{host} is not under pull_requests.gitlab"))?;
                Ok(src
                    .gitlab
                    .reviewing(access)
                    .await?
                    .into_iter()
                    .map(|m| {
                        let subject = Subject {
                            ticket: named(ticket_in(&m.source_branch, &m.title, pattern), &m.title),
                            pr: Some(PrRef {
                                url: m.url.clone(),
                                number: m.iid,
                                branch: m.source_branch.clone(),
                                host: access.host.clone(),
                                project: m.project.clone(),
                                forge: "gitlab".into(),
                            }),
                        };
                        (format!("pr:{}", m.url), subject)
                    })
                    .collect())
            }
            _ => Ok(vec![]),
        }
    }

    // Items not seen before; the first look only notes what is already there.
    fn fresh(&self, id: &str, items: Vec<(String, Subject)>, now: DateTime<Local>) -> Vec<Subject> {
        let today = now.format("%Y-%m-%d").to_string();
        let oldest = (now - Duration::days(KEEP_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        self.edit(id, |k| {
            k.problem.clear();
            k.checked = now.to_rfc3339();
            k.seen.retain(|_, day| *day >= oldest);
            let mut out = Vec::new();
            for (key, subject) in items {
                let new = k.seen.insert(key, today.clone()).is_none();
                if new && k.baseline && !out.iter().any(|s: &Subject| s.key() == subject.key()) {
                    out.push(subject);
                }
            }
            k.baseline = true;
            out
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pipeline::definition::{Definition, Trigger};
    use crate::triggers::{GhList, Ticket};
    use chrono::TimeZone;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    pub(crate) struct Fakes {
        pub linear: StdMutex<Vec<Ticket>>,
        pub reviews: StdMutex<Vec<Ticket>>,
        pub mrs: StdMutex<Vec<Mr>>,
    }

    impl Feeds for Fakes {
        fn linear<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, Result<Vec<Ticket>, String>> {
            let out = self.linear.lock().unwrap().clone();
            Box::pin(async move { Ok(out) })
        }
        fn github(&self, list: GhList) -> BoxFuture<'_, Result<Vec<Ticket>, String>> {
            assert_eq!(list, GhList::ReviewRequested);
            let out = self.reviews.lock().unwrap().clone();
            Box::pin(async move { Ok(out) })
        }
    }

    impl Reviewing for Fakes {
        fn reviewing<'a>(
            &'a self,
            _access: &'a GitLabAccess,
        ) -> BoxFuture<'a, Result<Vec<Mr>, String>> {
            let out = self.mrs.lock().unwrap().clone();
            Box::pin(async move { Ok(out) })
        }
    }

    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 29, h, m, 0).unwrap()
    }

    fn sources(f: &Fakes) -> Sources<'_> {
        Sources {
            feeds: f,
            gitlab: f,
            accesses: vec![GitLabAccess {
                host: "git.commslayer.com".into(),
                api: String::new(),
                secret: "gitlab".into(),
                token: Ok("t".into()),
            }],
            linear_key: Ok("lin".into()),
            pattern: None,
        }
    }

    fn pipeline(trigger: Trigger, enabled: bool) -> Definition {
        let mut def = crate::pipeline::templates::all().remove(1);
        def.trigger = trigger;
        def.enabled = enabled;
        def
    }

    fn mr(iid: u64, branch: &str, title: &str) -> Mr {
        Mr {
            url: format!("https://git.commslayer.com/commslayer/app/-/merge_requests/{iid}"),
            iid,
            title: title.into(),
            source_branch: branch.into(),
            project: "commslayer/app".into(),
        }
    }

    fn watch() -> (Watch, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Watch::load(dir.path().join("watch.json")), dir)
    }

    #[test]
    fn a_merge_request_finds_its_ticket_from_the_branch() {
        assert_eq!(
            ticket_in("com-1234-webhook-dedup", "Fix it", None),
            Some("COM-1234".into())
        );
        assert_eq!(
            ticket_in("feature/login", "COM-77: Login redirect", None),
            Some("COM-77".into())
        );
        assert_eq!(ticket_in("main", "Tidy up", None), None);
        let pattern = regex::Regex::new(r"(?i)eng-\d+").unwrap();
        assert_eq!(
            ticket_in("x-eng-9-y", "", Some(&pattern)),
            Some("ENG-9".into())
        );
    }

    #[tokio::test]
    async fn a_new_pipeline_watches_from_now() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.mrs.lock().unwrap() = vec![mr(87, "com-1234-webhook", "Webhook dedup")];
        let defs = vec![pipeline(
            Trigger::GitlabReviewer {
                host: "git.commslayer.com".into(),
            },
            true,
        )];
        assert!(
            w.due(&defs, &sources(&f), at(9, 0)).await.is_empty(),
            "what is already there is left alone"
        );
        f.mrs
            .lock()
            .unwrap()
            .push(mr(91, "com-1250-inbox", "Inbox filter"));
        assert!(
            w.due(&defs, &sources(&f), at(9, 1)).await.is_empty(),
            "asked every 3 minutes"
        );
        let due = w.due(&defs, &sources(&f), at(9, 4)).await;
        assert_eq!(due.len(), 1);
        let (id, subject) = &due[0];
        assert_eq!(id, "review-my-merge-requests");
        let pr = subject.pr.as_ref().unwrap();
        assert_eq!(
            (pr.number, pr.branch.as_str(), pr.forge.as_str()),
            (91, "com-1250-inbox", "gitlab")
        );
        assert_eq!(subject.ticket.as_ref().unwrap().id, "COM-1250");
        assert!(
            w.due(&defs, &sources(&f), at(9, 8)).await.is_empty(),
            "each item fires once"
        );
    }

    #[tokio::test]
    async fn a_switched_off_pipeline_does_not_fire() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let defs = vec![pipeline(
            Trigger::GitlabReviewer {
                host: "git.commslayer.com".into(),
            },
            false,
        )];
        w.due(&defs, &sources(&f), at(9, 0)).await;
        *f.mrs.lock().unwrap() = vec![mr(91, "com-1250-inbox", "Inbox filter")];
        assert!(w.due(&defs, &sources(&f), at(9, 4)).await.is_empty());
    }

    #[tokio::test]
    async fn linear_github_and_schedule_triggers() {
        let (w, dir) = watch();
        let f = Fakes::default();
        let linear = pipeline(
            Trigger::Linear {
                assigned: true,
                states: vec![],
            },
            true,
        );
        let mut github = pipeline(Trigger::GithubReview, true);
        github.id = "gh".into();
        let mut nightly = pipeline(
            Trigger::Schedule {
                schedule: "every 1h".into(),
                state: "Todo".into(),
            },
            true,
        );
        nightly.id = "nightly".into();
        let defs = vec![linear, github, nightly];
        w.due(&defs, &sources(&f), at(9, 10)).await;
        *f.linear.lock().unwrap() = vec![Ticket {
            id: "u-5".into(),
            ticket: "COM-5".into(),
            title: "Export".into(),
            url: "https://linear.app/c/COM-5".into(),
            state: "Todo".into(),
            repo: String::new(),
        }];
        *f.reviews.lock().unwrap() = vec![Ticket {
            id: "https://github.com/acme/app/pull/12".into(),
            ticket: "acme/app#12".into(),
            title: "COM-6 Search".into(),
            url: "https://github.com/acme/app/pull/12".into(),
            state: "open".into(),
            repo: "acme/app".into(),
        }];
        let mut due = w.due(&defs, &sources(&f), at(10, 1)).await;
        due.sort_by(|a, b| a.0.cmp(&b.0));
        let ids: Vec<&str> = due.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["gh", "nightly", "review-my-merge-requests"]);
        assert_eq!(due[0].1.pr.as_ref().unwrap().number, 12);
        assert_eq!(due[0].1.ticket.as_ref().unwrap().id, "COM-6");
        assert_eq!(due[1].1.ticket.as_ref().unwrap().id, "COM-5");
        assert_eq!(due[2].1.ticket.as_ref().unwrap().linear_id, "u-5");
        let again = Watch::load(dir.path().join("watch.json"));
        assert!(
            again.due(&defs, &sources(&f), at(10, 5)).await.is_empty(),
            "what was seen survives a restart"
        );
    }
}
