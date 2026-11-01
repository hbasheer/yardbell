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

pub trait ConnectorFeed: Send + Sync {
    fn list<'a>(
        &'a self,
        id: &'a str,
        params: &'a BTreeMap<String, String>,
    ) -> BoxFuture<'a, Result<crate::connectors::Listed, String>>;
}

// Where the triggers look, gathered for one round.
pub struct Sources<'a> {
    pub feeds: &'a dyn Feeds,
    pub gitlab: &'a dyn Reviewing,
    pub connectors: &'a dyn ConnectorFeed,
    pub accesses: Vec<GitLabAccess>,
    pub linear_key: Result<String, String>,
    pub pattern: Option<Regex>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Kept {
    // The trigger this was watched with; a different one starts a new baseline.
    pub trigger: String,
    pub baseline: bool,
    pub seen: BTreeMap<String, String>,
    pub anchor: String,
    pub checked: String,
    pub problem: String,
}

pub struct Watch {
    file: PathBuf,
    written: Mutex<Vec<u8>>,
    kept: Mutex<BTreeMap<String, Kept>>,
    polls: Mutex<HashMap<String, DateTime<Local>>>,
}

// The Linear identifier a pull or merge request names: in its branch first, then its title.
pub fn item_subject(
    source: &str,
    item: &crate::connectors::client::Item,
    params: &BTreeMap<String, String>,
) -> Subject {
    let mut fields = params.clone();
    fields.extend(item.fields.clone());
    Subject {
        ticket: Some(TicketRef {
            source: source.to_string(),
            item_id: item.item_id.clone(),
            id: item.id.clone(),
            title: item.title.clone(),
            url: item.url.clone(),
            description: String::new(),
            fields,
        }),
        pr: None,
    }
}

pub fn item_matches(
    item: &crate::connectors::client::Item,
    params: &BTreeMap<String, String>,
) -> bool {
    params.iter().all(|(k, v)| {
        v.is_empty()
            || item
                .fields
                .get(k)
                .is_none_or(|f| crate::connectors::client::field_holds(f, v))
    })
}

pub fn in_a_state(states: &[String], state: &str) -> bool {
    states.iter().any(|s| s.eq_ignore_ascii_case(state))
}

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
        source: String::new(),
        item_id: id.clone(),
        id,
        title: title.to_string(),
        url: String::new(),
        description: String::new(),
        fields: Default::default(),
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
            written: Mutex::new(Vec::new()),
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
        let mut written = self.written.lock().expect("watch written");
        if *written == bytes {
            return;
        }
        *written = bytes.clone();
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
        self.forget_all_but(defs);
        for def in defs.iter().filter(|d| d.enabled) {
            let found = match &def.trigger {
                Trigger::Manual | Trigger::Webhook { .. } => continue,
                Trigger::Schedule {
                    schedule,
                    state,
                    connector,
                    params,
                } => {
                    match self
                        .scheduled(def, schedule, state, (connector, params), src, now)
                        .await
                    {
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

    // A pipeline switched off, deleted or given a new trigger watches from scratch next time,
    // so what arrived meanwhile does not all start at once.
    fn forget_all_but(&self, defs: &[Definition]) {
        let on: BTreeMap<&str, String> = defs
            .iter()
            .filter(|d| d.enabled)
            .map(|d| {
                (
                    d.id.as_str(),
                    serde_json::to_string(&d.trigger).unwrap_or_default(),
                )
            })
            .collect();
        let mut kept = self.kept.lock().expect("watch lock");
        kept.retain(|id, _| on.contains_key(id.as_str()));
        for (id, trigger) in on {
            let k = kept.entry(id.to_string()).or_default();
            if k.trigger != trigger {
                *k = Kept {
                    trigger,
                    ..Kept::default()
                };
            }
        }
        let mut polls = self.polls.lock().expect("watch polls");
        polls.retain(|id, _| kept.contains_key(id));
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
        (connector, params): (&str, &BTreeMap<String, String>),
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
        if !connector.is_empty() {
            let listed = src.connectors.list(connector, params).await;
            let items = match listed {
                Ok(listed) => {
                    self.edit(&def.id, |k| k.problem = String::new());
                    listed.items
                }
                Err(problem) => {
                    self.edit(&def.id, |k| k.problem = problem);
                    return None;
                }
            };
            return Some(
                items
                    .iter()
                    .filter(|i| item_matches(i, params))
                    .filter(|i| i.state.eq_ignore_ascii_case(state.trim()))
                    .map(|i| item_subject(connector, i, params))
                    .collect(),
            );
        }
        let key = src.linear_key.clone().ok()?;
        let tickets = src.feeds.linear(&key).await.ok()?;
        Some(
            tickets
                .into_iter()
                .filter(|t| t.state.eq_ignore_ascii_case(state.trim()))
                .map(|t| Subject {
                    ticket: Some(TicketRef {
                        source: String::new(),
                        item_id: t.id,
                        id: t.ticket,
                        title: t.title,
                        url: t.url,
                        description: String::new(),
                        fields: Default::default(),
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
            Trigger::Connector {
                connector,
                params,
                states,
            } => {
                let listed = src.connectors.list(connector, params).await?;
                Ok(listed
                    .items
                    .iter()
                    .filter(|i| item_matches(i, params))
                    .filter_map(|i| {
                        let key = if states.is_empty() {
                            format!("item:{connector}:{}", i.item_id)
                        } else if in_a_state(states, &i.state) {
                            format!("state:{connector}:{}:{}", i.item_id, i.state.to_lowercase())
                        } else {
                            return None;
                        };
                        Some((key, item_subject(connector, i, params)))
                    })
                    .collect())
            }
            Trigger::Linear {
                assigned,
                states,
                filter,
            } => {
                let key = src.linear_key.clone()?;
                let mut items = Vec::new();
                for t in src.feeds.linear_where(&key, filter).await? {
                    let subject = Subject {
                        ticket: Some(TicketRef {
                            source: String::new(),
                            item_id: t.id.clone(),
                            id: t.ticket.clone(),
                            title: t.title.clone(),
                            url: t.url.clone(),
                            description: String::new(),
                            fields: Default::default(),
                        }),
                        pr: None,
                    };
                    if *assigned {
                        items.push((format!("assigned:{}", t.id), subject.clone()));
                    }
                    if in_a_state(states, &t.state) {
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
    use crate::triggers::{GhList, LinearFilter, Ticket};
    use chrono::TimeZone;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    pub(crate) struct Fakes {
        pub linear: StdMutex<Vec<Ticket>>,
        pub linear_asked: StdMutex<Vec<LinearFilter>>,
        pub reviews: StdMutex<Vec<Ticket>>,
        pub mrs: StdMutex<Vec<Mr>>,
        pub cards: StdMutex<Vec<crate::connectors::client::Item>>,
        pub card_problem: StdMutex<Option<String>>,
        pub card_params: StdMutex<Vec<BTreeMap<String, String>>>,
        pub card_hangs: StdMutex<bool>,
    }

    impl ConnectorFeed for Fakes {
        fn list<'a>(
            &'a self,
            _id: &'a str,
            params: &'a BTreeMap<String, String>,
        ) -> BoxFuture<'a, Result<crate::connectors::Listed, String>> {
            Box::pin(async move {
                self.card_params.lock().unwrap().push(params.clone());
                if *self.card_hangs.lock().unwrap() {
                    futures::future::pending::<()>().await;
                }
                if let Some(problem) = self.card_problem.lock().unwrap().clone() {
                    return Err(problem);
                }
                Ok(crate::connectors::Listed {
                    items: self.cards.lock().unwrap().clone(),
                    ..Default::default()
                })
            })
        }
    }

    impl Feeds for Fakes {
        fn linear<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, Result<Vec<Ticket>, String>> {
            let out = self.linear.lock().unwrap().clone();
            Box::pin(async move { Ok(out) })
        }
        fn linear_where<'a>(
            &'a self,
            key: &'a str,
            filter: &'a LinearFilter,
        ) -> BoxFuture<'a, Result<Vec<Ticket>, String>> {
            self.linear_asked.lock().unwrap().push(filter.clone());
            self.linear(key)
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
            connectors: f,
            accesses: vec![GitLabAccess {
                host: "git.commslayer.com".into(),
                api: String::new(),
                secret: "gitlab".into(),
                token: Ok("t".into()),
                glab: false,
                machine: None,
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

    fn item(id: &str, state: &str, board: &str) -> crate::connectors::client::Item {
        crate::connectors::client::Item {
            item_id: id.into(),
            id: id.to_uppercase(),
            title: format!("Card {id}"),
            url: format!("https://t/{id}"),
            state: state.into(),
            fields: [("board".to_string(), board.to_string())].into(),
            ..Default::default()
        }
    }

    fn connector_trigger(states: &[&str], params: &[(&str, &str)]) -> Trigger {
        Trigger::Connector {
            connector: "trello".into(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            states: states.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[tokio::test]
    async fn a_connector_trigger_watches_from_now() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        f.cards.lock().unwrap().push(item("a", "L1", "B1"));
        let defs = vec![pipeline(connector_trigger(&[], &[]), true)];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        f.cards.lock().unwrap().push(item("b", "L1", "B1"));
        let due = w.due(&defs, &sources(&f), at(9, 4)).await;
        assert_eq!(due.len(), 1);
        let t = due[0].1.ticket.as_ref().unwrap();
        assert_eq!(
            (
                t.source.as_str(),
                t.item_id.as_str(),
                t.id.as_str(),
                t.title.as_str()
            ),
            ("trello", "b", "B", "Card b")
        );
        assert!(w.due(&defs, &sources(&f), at(9, 8)).await.is_empty());
    }

    #[tokio::test]
    async fn a_connector_trigger_filters_by_state_and_param() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let defs = vec![pipeline(
            connector_trigger(&["todo"], &[("board", "B1")]),
            true,
        )];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        *f.cards.lock().unwrap() = vec![
            item("a", "Todo", "B1"),
            item("b", "Done", "B1"),
            item("c", "Todo", "B2"),
        ];
        let due = w.due(&defs, &sources(&f), at(9, 4)).await;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1.ticket.as_ref().unwrap().item_id, "a");
    }

    fn labelled(id: &str, labels: &str) -> crate::connectors::client::Item {
        crate::connectors::client::Item {
            item_id: id.into(),
            id: id.to_uppercase(),
            title: format!("Card {id}"),
            fields: [("label".to_string(), labels.to_string())].into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_filter_matches_one_of_many_labels_and_not_a_missing_one() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let defs = vec![pipeline(connector_trigger(&[], &[("label", "BUG")]), true)];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        *f.cards.lock().unwrap() = vec![
            labelled("a", r#"["ui","bug"]"#),
            labelled("b", r#"["ui"]"#),
            labelled("c", "[]"),
            labelled("d", ""),
        ];
        let due = w.due(&defs, &sources(&f), at(9, 4)).await;
        let ids: Vec<&str> = due
            .iter()
            .map(|(_, s)| s.ticket.as_ref().unwrap().item_id.as_str())
            .collect();
        assert_eq!(ids, ["a"]);
    }

    #[tokio::test]
    async fn a_ticket_that_gains_the_label_later_starts_once() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let defs = vec![pipeline(connector_trigger(&[], &[("label", "bug")]), true)];
        *f.cards.lock().unwrap() = vec![labelled("a", r#"["ui"]"#)];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        *f.cards.lock().unwrap() = vec![labelled("a", r#"["ui","bug"]"#)];
        assert_eq!(w.due(&defs, &sources(&f), at(9, 4)).await.len(), 1);
        assert!(w.due(&defs, &sources(&f), at(9, 8)).await.is_empty());
    }

    #[tokio::test]
    async fn changing_a_connector_filter_only_notes_what_matches() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.cards.lock().unwrap() = vec![labelled("a", r#"["bug"]"#), labelled("b", r#"["ui"]"#)];
        let narrow = vec![pipeline(connector_trigger(&[], &[("label", "bug")]), true)];
        w.due(&narrow, &sources(&f), at(9, 0)).await;
        let wide = vec![pipeline(connector_trigger(&[], &[("label", "ui")]), true)];
        assert!(
            w.due(&wide, &sources(&f), at(9, 4)).await.is_empty(),
            "old tickets that now match are left alone"
        );
        let none = vec![pipeline(connector_trigger(&[], &[]), true)];
        assert!(
            w.due(&none, &sources(&f), at(9, 8)).await.is_empty(),
            "removing the filter does not flood either"
        );
        f.cards.lock().unwrap().push(labelled("c", r#"["ui"]"#));
        assert_eq!(w.due(&none, &sources(&f), at(9, 12)).await.len(), 1);
    }

    fn ticket(id: &str) -> Ticket {
        Ticket {
            id: id.into(),
            ticket: id.to_uppercase(),
            title: format!("Ticket {id}"),
            url: String::new(),
            state: "Todo".into(),
            repo: String::new(),
        }
    }

    fn linear_with(labels: &[&str]) -> Trigger {
        Trigger::Linear {
            assigned: true,
            states: vec![],
            filter: LinearFilter {
                labels: labels.iter().map(|l| l.to_string()).collect(),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn a_linear_filter_is_asked_of_linear_and_a_change_only_notes() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.linear.lock().unwrap() = vec![ticket("a"), ticket("b")];
        let bug = vec![pipeline(linear_with(&["bug"]), true)];
        assert!(w.due(&bug, &sources(&f), at(9, 0)).await.is_empty());
        assert_eq!(f.linear_asked.lock().unwrap()[0].labels, ["bug"]);
        f.linear.lock().unwrap().push(ticket("c"));
        assert_eq!(w.due(&bug, &sources(&f), at(9, 4)).await.len(), 1);
        f.linear.lock().unwrap().push(ticket("d"));
        let ui = vec![pipeline(linear_with(&["ui"]), true)];
        assert!(
            w.due(&ui, &sources(&f), at(9, 8)).await.is_empty(),
            "a changed filter starts a new baseline"
        );
        f.linear.lock().unwrap().push(ticket("e"));
        let due = w.due(&ui, &sources(&f), at(9, 12)).await;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1.ticket.as_ref().unwrap().item_id, "e");
    }

    #[tokio::test]
    async fn a_pipeline_saved_before_filters_keeps_what_it_has_seen() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let def = pipeline(linear_with(&[]), true);
        let before = r#"{"kind":"linear","assigned":true,"states":[]}"#;
        w.edit(&def.id, |k| {
            k.trigger = before.to_string();
            k.baseline = true;
        });
        *f.linear.lock().unwrap() = vec![ticket("a")];
        assert_eq!(
            w.due(std::slice::from_ref(&def), &sources(&f), at(9, 0))
                .await
                .len(),
            1,
            "its baseline survives, so the new ticket starts"
        );
    }

    #[tokio::test]
    async fn a_filter_that_fails_notes_nothing_and_says_why() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.card_problem.lock().unwrap() = Some("GitHub answered 422".into());
        let def = pipeline(connector_trigger(&[], &[("label", "bug")]), true);
        let defs = vec![def.clone()];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        assert!(!w.kept(&def.id).baseline);
        assert!(w.kept(&def.id).problem.contains("422"));
    }

    #[tokio::test]
    async fn a_schedule_applies_a_filter_the_tool_cannot() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let mut a = labelled("a", r#"["bug"]"#);
        a.state = "Todo".into();
        let mut b = labelled("b", r#"["ui"]"#);
        b.state = "Todo".into();
        *f.cards.lock().unwrap() = vec![a, b];
        let defs = vec![pipeline(
            Trigger::Schedule {
                schedule: "weekdays 09:00".into(),
                state: "Todo".into(),
                connector: "trello".into(),
                params: [("label".to_string(), "bug".to_string())].into(),
            },
            true,
        )];
        w.due(&defs, &sources(&f), at(8, 0)).await;
        let due = w.due(&defs, &sources(&f), at(9, 1)).await;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1.ticket.as_ref().unwrap().item_id, "a");
    }

    #[tokio::test]
    async fn a_card_moved_into_a_state_starts_once() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        f.cards.lock().unwrap().push(item("a", "Backlog", "B1"));
        let defs = vec![pipeline(connector_trigger(&["Todo"], &[]), true)];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        *f.cards.lock().unwrap() = vec![item("a", "Todo", "B1")];
        assert_eq!(w.due(&defs, &sources(&f), at(9, 4)).await.len(), 1);
        assert!(w.due(&defs, &sources(&f), at(9, 8)).await.is_empty());
    }

    #[tokio::test]
    async fn a_connector_problem_shows_and_starts_nothing() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.card_problem.lock().unwrap() = Some("Trello: the secret trello_token is not set".into());
        let def = pipeline(connector_trigger(&[], &[]), true);
        let defs = vec![def.clone()];
        assert!(w.due(&defs, &sources(&f), at(9, 0)).await.is_empty());
        assert!(w.kept(&def.id).problem.contains("trello_token"));
    }

    #[tokio::test]
    async fn a_schedules_problem_clears_when_it_works_again() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.cards.lock().unwrap() = vec![item("a", "Todo", "B1")];
        *f.card_problem.lock().unwrap() = Some("the secret t is not set".into());
        let def = pipeline(
            Trigger::Schedule {
                schedule: "weekdays 09:00".into(),
                state: "Todo".into(),
                connector: "trello".into(),
                params: Default::default(),
            },
            true,
        );
        let defs = vec![def.clone()];
        w.due(&defs, &sources(&f), at(8, 0)).await;
        w.due(&defs, &sources(&f), at(9, 1)).await;
        assert!(w.kept(&def.id).problem.contains("the secret t"));
        *f.card_problem.lock().unwrap() = None;
        w.due(&defs, &sources(&f), at(9, 2)).await;
        let later = Local.with_ymd_and_hms(2026, 10, 30, 9, 1, 0).unwrap();
        assert_eq!(w.due(&defs, &sources(&f), later).await.len(), 1);
        assert_eq!(w.kept(&def.id).problem, "");
    }

    #[tokio::test]
    async fn a_schedule_passes_its_choices_to_the_connector() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.cards.lock().unwrap() = vec![item("a", "Todo", "B1")];
        let defs = vec![pipeline(
            Trigger::Schedule {
                schedule: "weekdays 09:00".into(),
                state: "Todo".into(),
                connector: "trello".into(),
                params: [("board".to_string(), "B1".to_string())].into(),
            },
            true,
        )];
        w.due(&defs, &sources(&f), at(8, 0)).await;
        w.due(&defs, &sources(&f), at(9, 1)).await;
        assert_eq!(f.card_params.lock().unwrap().last().unwrap()["board"], "B1");
    }

    #[tokio::test]
    async fn a_schedule_can_read_a_connector() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        *f.cards.lock().unwrap() = vec![item("a", "Todo", "B1"), item("b", "Done", "B1")];
        let defs = vec![pipeline(
            Trigger::Schedule {
                schedule: "weekdays 09:00".into(),
                state: "Todo".into(),
                connector: "trello".into(),
                params: Default::default(),
            },
            true,
        )];
        assert!(w.due(&defs, &sources(&f), at(8, 0)).await.is_empty());
        let due = w.due(&defs, &sources(&f), at(9, 1)).await;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1.ticket.as_ref().unwrap().source, "trello");
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
    async fn switching_back_on_or_changing_the_trigger_watches_from_then() {
        let (w, _dir) = watch();
        let f = Fakes::default();
        let reviewer = |on| {
            pipeline(
                Trigger::GitlabReviewer {
                    host: "git.commslayer.com".into(),
                },
                on,
            )
        };
        w.due(&[reviewer(true)], &sources(&f), at(9, 0)).await;
        w.due(&[reviewer(false)], &sources(&f), at(9, 4)).await;
        *f.mrs.lock().unwrap() = vec![mr(91, "com-1250-inbox", "Inbox filter")];
        assert!(
            w.due(&[reviewer(true)], &sources(&f), at(9, 8))
                .await
                .is_empty(),
            "what arrived while it was off is left alone"
        );
        f.mrs
            .lock()
            .unwrap()
            .push(mr(92, "com-1251-export", "Export"));
        let other = pipeline(
            Trigger::GitlabReviewer {
                host: "gl.example.com".into(),
            },
            true,
        );
        assert!(
            w.due(&[other], &sources(&f), at(9, 12)).await.is_empty(),
            "a changed trigger starts a new baseline"
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
                filter: Default::default(),
            },
            true,
        );
        let mut github = pipeline(Trigger::GithubReview, true);
        github.id = "gh".into();
        let mut nightly = pipeline(
            Trigger::Schedule {
                connector: String::new(),
                params: Default::default(),
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
        assert_eq!(due[2].1.ticket.as_ref().unwrap().item_id, "u-5");
        let again = Watch::load(dir.path().join("watch.json"));
        assert!(
            again.due(&defs, &sources(&f), at(10, 5)).await.is_empty(),
            "what was seen survives a restart"
        );
    }
}
