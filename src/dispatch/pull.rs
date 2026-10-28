use super::follow::Tracked;
use super::store::{new_id, now, title_of, Conversation, Stored};
use super::{missing, Dispatch, Refusal};
use serde_json::{json, Value};

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

fn is_pull(e: &Value) -> bool {
    e["role"] == "pull"
}

impl Dispatch {
    // A pull request card goes to the conversation that follows the session, or else the one that
    // already has cards for the same pull request, or else a new conversation that follows it.
    // A card already posted anywhere is not posted again.
    pub fn post_pull(
        &self,
        machine: &str,
        session: &str,
        path: &str,
        title: &str,
        card: Value,
    ) -> Option<String> {
        let id = {
            let mut chats = self.shared.lock();
            let posted = chats
                .values()
                .flat_map(|c| &c.stored.events)
                .any(|e| is_pull(e) && e["key"] == card["key"]);
            if posted {
                return None;
            }
            let newest = |found: Vec<&Conversation>| {
                found
                    .into_iter()
                    .max_by(|a, b| a.stored.updated.cmp(&b.stored.updated))
                    .map(|c| c.stored.id.clone())
            };
            let follows = newest(
                chats
                    .values()
                    .filter(|c| {
                        c.stored
                            .sessions
                            .iter()
                            .any(|t| t.machine == machine && t.name == session)
                    })
                    .collect(),
            );
            let same_pull = || {
                newest(
                    chats
                        .values()
                        .filter(|c| {
                            c.stored
                                .events
                                .iter()
                                .any(|e| is_pull(e) && e["pull"]["url"] == card["pull"]["url"])
                        })
                        .collect(),
                )
            };
            let id = match follows.or_else(same_pull) {
                Some(id) => id,
                None => {
                    let id = new_id();
                    let stamp = now();
                    chats.insert(
                        id.clone(),
                        Conversation::new(Stored {
                            id: id.clone(),
                            title: title_of(title),
                            created: stamp.clone(),
                            updated: stamp,
                            sessions: vec![Tracked {
                                machine: machine.to_string(),
                                name: session.to_string(),
                                path: path.to_string(),
                                last: String::new(),
                                review: None,
                            }],
                            ..Stored::default()
                        }),
                    );
                    id
                }
            };
            let c = chats.get_mut(&id).expect("conversation exists");
            c.stored.events.push(card.clone());
            c.stored.updated = now();
            id
        };
        self.shared.save(&id);
        self.shared.send_live(&id, &card);
        Some(id)
    }

    // Claims the card for one send, so a second click or a second device cannot type it twice. A
    // send whose step was rejected or withdrawn can be tried again.
    pub fn pull_claim(&self, id: &str, index: usize) -> Result<Value, Refusal> {
        let at = now();
        self.shared.edit(id, |s| {
            let step = s
                .events
                .get(index)
                .and_then(|card| card["sent"]["step"].as_str())
                .map(str::to_string);
            let undone = step.is_some_and(|step| {
                s.events.iter().any(|e| {
                    e["role"] == "action"
                        && e["id"] == step.as_str()
                        && (e["status"] == "rejected" || e["status"] == "withdrawn")
                })
            });
            let card = s
                .events
                .get_mut(index)
                .filter(|e| is_pull(e))
                .ok_or_else(|| missing("pull request card"))?;
            if card["sent"].is_object() && !undone {
                return Err(Refusal::Taken(
                    "this was already sent to the session".into(),
                ));
            }
            card["sent"] = json!({ "at": at });
            Ok(card.clone())
        })
    }

    pub fn pull_sent(&self, id: &str, index: usize, step: Option<&str>) -> Result<Value, Refusal> {
        self.shared.edit(id, |s| {
            let card = s
                .events
                .get_mut(index)
                .filter(|e| is_pull(e))
                .ok_or_else(|| missing("pull request card"))?;
            match step {
                Some(step) => card["sent"]["step"] = json!(step),
                None => {
                    if let Some(card) = card.as_object_mut() {
                        card.remove("sent");
                    }
                }
            }
            Ok(card.clone())
        })
    }
}

// Dispatch hears about a card once, in the next message, so it can talk about the failure.
pub fn untold(card: &mut Value) -> Option<String> {
    if card["told"] == true {
        return None;
    }
    card["told"] = json!(true);
    let pull = &card["pull"];
    let subject = format!(
        "Pull request #{} ({}) of {} on {}",
        pull["number"],
        text(pull, "title"),
        text(card, "name"),
        text(card, "machine")
    );
    let names = |key: &str, field: &str| -> Vec<String> {
        let mut found: Vec<String> = card[key]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| text(v, field).to_string())
            .filter(|v| !v.is_empty())
            .collect();
        found.dedup();
        found
    };
    Some(match text(card, "kind") {
        "ci" => format!(
            "{subject} failed CI on {}. Yardbell offers to send: {}",
            names("checks", "name").join(", "),
            text(card, "instruction")
        ),
        _ => format!(
            "{subject} has new review comments from {}. Yardbell offers to send: {}",
            names("notes", "author").join(", "),
            text(card, "instruction")
        ),
    })
}

#[cfg(test)]
mod tests {
    use crate::dispatch::tests::{conversation, fake_claude};
    use crate::dispatch::By;
    use serde_json::json;

    fn card(key: &str) -> serde_json::Value {
        json!({
            "role": "pull", "kind": "ci", "key": key,
            "machine": "hp", "name": "hp-app", "path": "/r/app", "branch": "eng-1",
            "pull": { "number": 7, "url": "https://github.com/o/r/pull/7", "title": "Fix login" },
            "checks": [{ "name": "test", "url": "u" }],
            "notes": [],
            "instruction": "CI failed on test for pull request #7. Fix it and push.",
        })
    }

    #[tokio::test]
    async fn a_card_goes_once_to_the_conversation_that_follows_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let other = conversation(&dispatch, "something else").await;
        let id = conversation(&dispatch, "fix it").await;
        dispatch.record(
            &id,
            "start_session",
            json!({ "machine": "hp", "folder": "app" }),
            None,
            None,
            &Ok(json!({ "machine": "hp", "name": "hp-app", "path": "/r/app" })),
        );
        assert_eq!(
            dispatch.post_pull("hp", "hp-app", "/r/app", "t", card("ci:1")),
            Some(id.clone())
        );
        assert_eq!(
            dispatch.post_pull("hp", "hp-app", "/r/app", "t", card("ci:1")),
            None
        );
        let events = dispatch.get(&id).unwrap()["events"].clone();
        assert_eq!(events.as_array().unwrap().last().unwrap()["key"], "ci:1");
        assert!(dispatch.get(&other).unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["role"] != "pull"));
    }

    #[tokio::test]
    async fn a_session_no_conversation_follows_gets_one_that_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = dispatch
            .post_pull(
                "hp",
                "hp-app",
                "/r/app",
                "Pull request #7: Fix login",
                card("ci:1"),
            )
            .unwrap();
        let convo = dispatch.get(&id).unwrap();
        assert_eq!(convo["title"], "Pull request #7: Fix login");
        assert_eq!(convo["sessions"][0]["name"], "hp-app");

        let reopened = fake_claude(dir.path(), "true");
        assert_eq!(
            reopened.post_pull("hp", "hp-app", "/r/app", "t", card("ci:1")),
            None,
            "the same card after a restart"
        );
        assert_eq!(
            reopened.post_pull("hp", "hp-other", "/r/app", "t", card("ci:2")),
            Some(id),
            "a card for the same pull request joins its conversation"
        );
    }

    #[tokio::test]
    async fn a_card_is_sent_once_unless_its_step_was_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = dispatch
            .post_pull("hp", "hp-app", "/r/app", "t", card("ci:1"))
            .unwrap();
        dispatch.pull_claim(&id, 0).unwrap();
        assert!(dispatch.pull_claim(&id, 0).is_err());
        let step = dispatch
            .propose(
                &id,
                "send_to_session",
                json!({ "machine": "hp", "name": "hp-app", "text": "fix" }),
                By::You,
                None,
                None,
            )
            .unwrap();
        let step = step["id"].as_str().unwrap();
        let sent = dispatch.pull_sent(&id, 0, Some(step)).unwrap();
        assert_eq!(sent["sent"]["step"], step);
        assert!(dispatch.pull_claim(&id, 0).is_err());
        dispatch.reject(&id, step).unwrap();
        assert!(
            dispatch.pull_claim(&id, 0).is_ok(),
            "rejected, so it can be sent again"
        );
        assert!(
            dispatch.pull_claim(&id, 1).is_err(),
            "not a pull request card"
        );
    }

    #[test]
    fn dispatch_hears_about_a_card_once() {
        let mut c = card("ci:1");
        let told = super::untold(&mut c).unwrap();
        assert!(
            told.starts_with("Pull request #7 (Fix login) of hp-app on hp failed CI on test."),
            "{told}"
        );
        assert_eq!(super::untold(&mut c), None);
    }
}
