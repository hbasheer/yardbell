use super::client::{Client, Vars};
use super::{validate, CallKind, Connector, ToolCaller};
use crate::mcp_client::{Failure, ToolReply};
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Tools {
    replies: Mutex<VecDeque<Result<ToolReply, Failure>>>,
    asked: Mutex<Vec<(String, String, Value)>>,
}

impl ToolCaller for Tools {
    fn call<'a>(
        &'a self,
        server: &'a str,
        tool: &'a str,
        arguments: Value,
    ) -> BoxFuture<'a, Result<ToolReply, Failure>> {
        Box::pin(async move {
            self.asked
                .lock()
                .unwrap()
                .push((server.into(), tool.into(), arguments));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(Failure::Other("no answer stubbed".into())))
        })
    }
}

fn text(value: Value) -> Result<ToolReply, Failure> {
    Ok(ToolReply {
        text: value.to_string(),
        structured: None,
        is_error: false,
    })
}

fn connector() -> Connector {
    serde_yaml::from_str(r#"
id: t
name: Tracker
server: tracker
params:
  - { name: board, label: Board, options: boards }
calls:
  boards:
    tool: readBoards
    kind: lookup
    arguments: { action: list }
    items: boards
    map: { id: id, name: name }
  list:
    tool: readCards
    kind: lookup
    arguments: { action: list_by_board, board: "{{board}}", cursor: "{{cursor}}" }
    items: lists[].cards
    map: { item_id: id, id: shortUrl, title: name, url: url, description: description, state: _parent.id }
    page: { style: cursor, param: "", next: nextCursor, has_more: hasNextPage }
  read:
    tool: readCard
    kind: lookup
    arguments: { action: get, card: "{{item_id}}" }
    map: { title: name, url: url, description: description, closed: closed }
  move:
    tool: writeCard
    kind: change
    arguments: { action: move, card: "{{item_id}}", list: "{{value}}" }
"#).unwrap()
}

fn client(tools: &Arc<Tools>) -> Client {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.yml");
    std::fs::write(&path, "").unwrap();
    let secrets = crate::secrets::Secrets::load(&path).unwrap();
    Client::new(&connector(), &secrets, vec!["shh-secret-1".into()])
        .unwrap()
        .with_tools(tools.clone())
}

fn vars(pairs: &[(&str, &str)]) -> Vars {
    Vars(
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn cards_page(next: &str, more: bool) -> Value {
    json!({
        "board": { "id": "b1", "name": "Work" },
        "hasNextPage": more,
        "nextCursor": next,
        "lists": [
            { "id": "todo", "name": "To do", "cards": [
                { "id": "ari:card/1", "name": "Fix login", "description": "It fails", "url": "https://trello.com/c/AbCd/1-fix", "shortUrl": "https://trello.com/c/AbCd", "secret_field": "kept out" }
            ] },
            { "id": "done", "name": "Done", "cards": [
                { "id": "ari:card/2", "name": "Old", "url": "https://trello.com/c/EfGh/2-old", "shortUrl": "https://trello.com/c/EfGh" }
            ] },
        ],
    })
}

#[test]
fn a_connector_can_use_a_server() {
    assert!(validate(&[connector()]).is_ok());
}

#[test]
fn exactly_one_of_address_and_server() {
    let mut both = connector();
    both.base_url = "https://x.example".into();
    assert!(validate(&[both]).unwrap_err().contains("server"));
    let mut neither = connector();
    neither.server.clear();
    assert!(validate(&[neither]).is_err());
}

#[test]
fn a_call_must_match_its_kind() {
    let mut c = connector();
    c.calls.get_mut("list").unwrap().tool.clear();
    assert!(validate(&[c]).unwrap_err().contains("tool"));
    let http: Connector = serde_yaml::from_str(
        r#"
id: h
base_url: https://x.example
calls:
  list: { tool: readCards }
"#,
    )
    .unwrap();
    assert!(validate(&[http]).is_err());
}

#[test]
fn old_connectors_still_load() {
    let old: Connector = serde_yaml::from_str(
        r#"
id: h
base_url: https://x.example
calls:
  list: { request: { method: GET, path: /items }, map: { item_id: id, title: name } }
"#,
    )
    .unwrap();
    assert!(validate(std::slice::from_ref(&old)).is_ok());
    assert_eq!(old.server, "");
    let saved = serde_yaml::to_string(&old).unwrap();
    assert!(
        !saved.contains("server") && !saved.contains("tool") && !saved.contains("arguments"),
        "{saved}"
    );
}

#[test]
fn a_tool_call_changes_unless_marked() {
    let c = connector();
    assert_eq!(c.calls["move"].kind(), CallKind::Change);
    let mut unmarked = c.calls["move"].clone();
    unmarked.kind = None;
    assert_eq!(unmarked.kind(), CallKind::Change);
}

#[tokio::test]
async fn a_list_flattens_cards_and_knows_their_list() {
    let tools = Arc::new(Tools::default());
    tools
        .replies
        .lock()
        .unwrap()
        .push_back(text(cards_page("", false)));
    let listed = client(&tools)
        .list(&vars(&[("board", "b1")]))
        .await
        .unwrap();
    assert_eq!(listed.items.len(), 2);
    assert_eq!(listed.items[0].state, "todo");
    assert_eq!(listed.items[1].state, "done");
    assert_eq!(listed.items[0].item_id, "ari:card/1");
    assert_eq!(listed.items[0].id, "AbCd", "a link reads as its last part");
    let asked = tools.asked.lock().unwrap();
    assert_eq!(asked[0].0, "tracker");
    assert_eq!(asked[0].2["board"], "b1");
    assert!(
        asked[0].2.get("cursor").is_none(),
        "an empty value is left out: {:?}",
        asked[0].2
    );
}

#[tokio::test]
async fn structured_content_is_used_first() {
    let tools = Arc::new(Tools::default());
    tools.replies.lock().unwrap().push_back(Ok(ToolReply {
        text: "Here are your cards".into(),
        structured: Some(cards_page("", false)),
        is_error: false,
    }));
    assert_eq!(
        client(&tools)
            .list(&vars(&[("board", "b1")]))
            .await
            .unwrap()
            .items
            .len(),
        2
    );
}

#[tokio::test]
async fn text_that_is_not_json_says_so() {
    let tools = Arc::new(Tools::default());
    tools.replies.lock().unwrap().push_back(Ok(ToolReply {
        text: "Sorry".into(),
        structured: None,
        is_error: false,
    }));
    let e = client(&tools)
        .list(&vars(&[("board", "b1")]))
        .await
        .unwrap_err();
    assert!(e.contains("readCards") && e.contains("JSON"), "{e}");
}

#[tokio::test]
async fn is_error_fails_the_list() {
    let tools = Arc::new(Tools::default());
    tools.replies.lock().unwrap().push_back(Ok(ToolReply {
        text: "Board gone shh-secret-1".into(),
        structured: None,
        is_error: true,
    }));
    let e = client(&tools)
        .list(&vars(&[("board", "b1")]))
        .await
        .unwrap_err();
    assert!(
        e.contains("Board gone") && !e.contains("shh-secret-1"),
        "{e}"
    );
}

#[tokio::test]
async fn a_cursor_argument_pages_a_tool() {
    let tools = Arc::new(Tools::default());
    {
        let mut replies = tools.replies.lock().unwrap();
        replies.push_back(text(cards_page("next-1", true)));
        replies.push_back(text(cards_page("", false)));
    }
    let listed = client(&tools)
        .list(&vars(&[("board", "b1")]))
        .await
        .unwrap();
    assert_eq!(listed.items.len(), 4);
    assert_eq!(tools.asked.lock().unwrap()[1].2["cursor"], "next-1");
}

#[tokio::test]
async fn limits_still_cut_off() {
    let tools = Arc::new(Tools::default());
    {
        let mut replies = tools.replies.lock().unwrap();
        replies.push_back(text(cards_page("same", true)));
        replies.push_back(text(cards_page("same", true)));
    }
    let listed = client(&tools)
        .list(&vars(&[("board", "b1")]))
        .await
        .unwrap();
    assert!(listed.cut_off.unwrap().contains("repeated"));
}

#[tokio::test]
async fn sign_in_again_shows_as_the_problem() {
    let tools = Arc::new(Tools::default());
    tools
        .replies
        .lock()
        .unwrap()
        .push_back(Err(Failure::NeedsSignIn(Default::default())));
    let e = client(&tools)
        .list(&vars(&[("board", "b1")]))
        .await
        .unwrap_err();
    assert!(e.contains("sign in again"), "{e}");
}

#[tokio::test]
async fn a_change_with_a_plain_text_reply_still_succeeds() {
    let tools = Arc::new(Tools::default());
    tools.replies.lock().unwrap().push_back(Ok(ToolReply {
        text: "Moved".into(),
        structured: None,
        is_error: false,
    }));
    let got = client(&tools)
        .call("move", &vars(&[("item_id", "c1"), ("value", "done")]))
        .await
        .unwrap();
    assert_eq!(got, json!("Moved"));
    let asked = tools.asked.lock().unwrap();
    assert_eq!(
        asked[0].2,
        json!({ "action": "move", "card": "c1", "list": "done" })
    );
}

#[tokio::test]
async fn options_read_through_a_tool() {
    let tools = Arc::new(Tools::default());
    tools
        .replies
        .lock()
        .unwrap()
        .push_back(text(json!({ "boards": [{ "id": "b1", "name": "Work" }] })));
    let got = client(&tools).options("boards", &vars(&[])).await.unwrap();
    assert_eq!(got, [("b1".to_string(), "Work".to_string())]);
}

#[tokio::test]
async fn no_way_to_call_tools_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.yml");
    std::fs::write(&path, "").unwrap();
    let secrets = crate::secrets::Secrets::load(&path).unwrap();
    let plain = Client::new(&connector(), &secrets, vec![]).unwrap();
    assert!(plain.list(&vars(&[("board", "b1")])).await.is_err());
}

#[test]
fn every_sign_in_example_is_valid() {
    let tools = super::sign_in_tools();
    let with_example: Vec<&str> = tools
        .iter()
        .map(|t| t.id)
        .filter(|id| super::sign_in_template(id).is_some())
        .collect();
    assert_eq!(
        with_example,
        ["trello"],
        "only tools whose replies were read get one"
    );
    for id in with_example {
        let example = super::sign_in_template(id).unwrap();
        validate(std::slice::from_ref(&example)).unwrap();
        for name in ["boards", "states", "list", "read"] {
            assert_eq!(example.calls[name].kind(), CallKind::Lookup, "{name}");
        }
        for name in ["move", "comment"] {
            assert_eq!(example.calls[name].kind(), CallKind::Change, "{name}");
        }
    }
}

#[tokio::test]
async fn the_trello_example_reads_its_real_reply() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.yml");
    std::fs::write(&path, "").unwrap();
    let secrets = crate::secrets::Secrets::load(&path).unwrap();
    let tools = Arc::new(Tools::default());
    tools
        .replies
        .lock()
        .unwrap()
        .push_back(text(cards_page("", false)));
    let example = super::sign_in_template("trello").unwrap();
    let client = Client::new(&example, &secrets, vec![])
        .unwrap()
        .with_tools(tools.clone());
    let listed = client
        .list(&vars(&[("board", "ari:board/1")]))
        .await
        .unwrap();
    assert_eq!(listed.items[0].title, "Fix login");
    assert_eq!(listed.items[0].id, "AbCd");
    assert_eq!(listed.items[0].state, "todo");
    assert_eq!(
        tools.asked.lock().unwrap()[0].2["boardIdOrUrl"],
        "ari:board/1"
    );
}

#[test]
fn a_tool_call_names_the_values_it_needs() {
    let example = super::sign_in_template("trello").unwrap();
    assert_eq!(super::client::needs_of(&example.calls["move"]), ["value"]);
    assert_eq!(super::client::needs_of(&example.calls["list"]), ["board"]);
}
