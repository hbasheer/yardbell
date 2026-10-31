use super::client::{Client, Vars};
use super::map::path;
use super::net::is_private;
use super::*;
use crate::secrets::Secrets;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(crate) struct Stub {
    pub base: String,
    pub answers: Arc<Mutex<HashMap<String, (u16, Vec<(String, String)>, String)>>>,
    pub asked: Arc<Mutex<Vec<(String, String, String, String)>>>,
    pub fallback: Arc<Mutex<Option<fn(&str) -> String>>>,
}

impl Stub {
    pub fn answer(&self, path_and_query: &str, status: u16, body: &str) {
        self.answer_with(path_and_query, status, vec![], body);
    }

    pub fn answer_with(&self, at: &str, status: u16, headers: Vec<(&str, String)>, body: &str) {
        let headers = headers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        self.answers
            .lock()
            .unwrap()
            .insert(at.into(), (status, headers, body.into()));
    }

    pub fn urls(&self) -> Vec<String> {
        self.asked
            .lock()
            .unwrap()
            .iter()
            .map(|a| a.1.clone())
            .collect()
    }
}

async fn stub_answer(
    axum::extract::State(stub): axum::extract::State<Stub>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let at = uri
        .path_and_query()
        .map_or_else(String::new, |p| p.to_string());
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    stub.asked.lock().unwrap().push((
        method.to_string(),
        at.clone(),
        auth,
        String::from_utf8_lossy(&body).into_owned(),
    ));
    let found = stub.answers.lock().unwrap().get(&at).cloned();
    let (status, extra, text) = match found {
        Some(a) => a,
        None => match *stub.fallback.lock().unwrap() {
            Some(f) => (200, vec![], f(&at)),
            None => (404, vec![], "{\"message\":\"no such thing\"}".to_string()),
        },
    };
    let mut res = (StatusCode::from_u16(status).unwrap(), text).into_response();
    for (k, v) in extra {
        res.headers_mut().insert(
            axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    res
}

pub(crate) async fn stub() -> Stub {
    let mut s = Stub::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    s.base = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new()
        .fallback(stub_answer)
        .with_state(s.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    s
}

pub(crate) fn connector(base: &str, yaml: &str) -> Connector {
    let mut c: Connector = serde_yaml::from_str(&format!(
        "id: t\nname: Tool\nbase_url: {base}\nallow_private: true\nheaders:\n  Authorization: 'Bearer ${{secret:tok}}'\ncalls:\n{yaml}"
    ))
    .unwrap();
    c.enabled = true;
    c
}

pub(crate) fn secrets(dir: &tempfile::TempDir) -> Secrets {
    let p = dir.path().join("secrets.yml");
    std::fs::write(&p, "tok: sekret-value\n").unwrap();
    Secrets::load(&p).unwrap()
}

pub(crate) fn client(c: &Connector, dir: &tempfile::TempDir) -> Client {
    Client::new(c, &secrets(dir), vec!["sekret-value".to_string()]).unwrap()
}

fn vars(pairs: &[(&str, &str)]) -> Vars {
    Vars(
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

const GET_ITEM: &str = "  one:\n    request: { method: GET, path: '/item/{{x}}' }\n";

#[test]
fn values_are_encoded_where_they_go() {
    let v = vars(&[("x", "a b/c")]);
    assert_eq!(
        super::client::render_path("/i/{{x}}", &v).unwrap(),
        "/i/a%20b%2Fc"
    );
    let v = vars(&[("x", "a \"b\"")]);
    let body = serde_json::json!({ "q": "{{x}}", "n": [ "{{x}}" ] });
    let out = super::client::render_json(&body, &v).unwrap();
    assert_eq!(out["q"], "a \"b\"");
    assert_eq!(out["n"][0], "a \"b\"");
    assert!(super::client::render_path("/i/{{gone}}", &v).is_err());
    assert!(super::client::render_path("/i/{{x}}", &vars(&[("x", "..")])).is_err());
}

#[test]
fn a_private_address_is_refused() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "192.168.1.1",
        "169.254.1.1",
        "100.64.0.1",
        "172.16.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "0.0.0.0",
    ] {
        assert!(is_private(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "2606:4700:4700::1111"] {
        assert!(!is_private(ip.parse().unwrap()), "{ip}");
    }
}

#[tokio::test]
async fn a_host_resolving_to_a_private_address_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    for base in ["https://localhost:9", "https://127.0.0.1:9"] {
        let mut c = connector(base, GET_ITEM);
        c.allow_private = false;
        let e = client(&c, &dir)
            .call("one", &vars(&[("x", "1")]))
            .await
            .unwrap_err();
        assert!(e.contains("private address"), "{e}");
    }
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let s = stub().await;
    s.answer_with(
        "/item/1",
        302,
        vec![("location", format!("{}/other", s.base))],
        "",
    );
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    let e = client(&c, &dir)
        .call("one", &vars(&[("x", "1")]))
        .await
        .unwrap_err();
    assert!(e.contains("redirect"), "{e}");
    assert_eq!(s.urls(), ["/item/1"]);
}

#[tokio::test]
async fn before_requests_feed_the_main_one() {
    let s = stub().await;
    s.answer("/users", 200, r#"{"users":[{"id":7}]}"#);
    s.answer("/orders/7", 200, r#"{"ok":true}"#);
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        "  one:\n    before:\n      - { name: find, method: GET, path: /users }\n    request: { method: GET, path: '/orders/{{steps.find.users.0.id}}' }\n",
    );
    let out = client(&c, &dir).call("one", &vars(&[])).await.unwrap();
    assert_eq!(out["ok"], true);
    assert_eq!(s.urls(), ["/users", "/orders/7"]);
}

#[tokio::test]
async fn credentials_stay_on_the_host() {
    let s = stub().await;
    s.answer("/item/%2F%2Fevil.example%2Fx", 200, "{}");
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    client(&c, &dir)
        .call("one", &vars(&[("x", "//evil.example/x")]))
        .await
        .unwrap();
    let asked = s.asked.lock().unwrap().clone();
    assert_eq!(asked[0].1, "/item/%2F%2Fevil.example%2Fx");
    assert_eq!(asked[0].2, "Bearer sekret-value");
}

#[tokio::test]
async fn a_reply_over_1_mb_fails() {
    let s = stub().await;
    s.answer("/item/1", 200, &"x".repeat(1024 * 1024 + 10));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    let e = client(&c, &dir)
        .call("one", &vars(&[("x", "1")]))
        .await
        .unwrap_err();
    assert!(e.contains("over 1 MB"), "{e}");
}

#[tokio::test]
async fn a_secret_in_a_reply_or_error_is_scrubbed() {
    let s = stub().await;
    s.answer("/item/1", 200, r#"{"echo":"sekret-value"}"#);
    s.answer("/item/2", 500, "bad token sekret-value");
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    let cl = client(&c, &dir);
    let out = cl.call("one", &vars(&[("x", "1")])).await.unwrap();
    assert!(!out.to_string().contains("sekret-value"), "{out}");
    let e = cl.call("one", &vars(&[("x", "2")])).await.unwrap_err();
    assert!(!e.contains("sekret-value"), "{e}");
}

#[tokio::test]
async fn a_missing_secret_is_named() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = connector("https://x.example", GET_ITEM);
    c.headers
        .insert("Authorization".into(), "Bearer ${secret:gone}".into());
    let e = Client::new(&c, &secrets(&dir), vec![]).err().unwrap();
    assert!(e.contains("gone"), "{e}");
}

#[tokio::test]
async fn an_error_field_fails_a_200_reply() {
    let s = stub().await;
    s.answer("/item/1", 200, r#"{"errors":[{"message":"bad"}]}"#);
    s.answer("/item/2", 200, r#"{"errors":[],"data":1}"#);
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        "  one:\n    error: errors\n    request: { method: GET, path: '/item/{{x}}' }\n",
    );
    let cl = client(&c, &dir);
    let e = cl.call("one", &vars(&[("x", "1")])).await.unwrap_err();
    assert!(e.contains("bad"), "{e}");
    assert!(cl.call("one", &vars(&[("x", "2")])).await.is_ok());
}

#[tokio::test]
async fn a_4xx_says_the_status() {
    let s = stub().await;
    s.answer("/item/1", 401, r#"{"message":"nope"}"#);
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    let e = client(&c, &dir)
        .call("one", &vars(&[("x", "1")]))
        .await
        .unwrap_err();
    assert!(e.contains("401"), "{e}");
}

#[tokio::test]
async fn not_json_says_so() {
    let s = stub().await;
    s.answer("/item/1", 200, "<html>hi</html>");
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    let e = client(&c, &dir)
        .call("one", &vars(&[("x", "1")]))
        .await
        .unwrap_err();
    assert!(e.contains("not JSON"), "{e}");
}

#[tokio::test]
async fn an_empty_reply_is_fine() {
    let s = stub().await;
    s.answer("/item/1", 204, "");
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, GET_ITEM);
    assert!(client(&c, &dir)
        .call("one", &vars(&[("x", "1")]))
        .await
        .is_ok());
}

#[test]
fn paths_read_a_reply() {
    let v = serde_json::json!({ "a": { "b": 1 }, "items": [{ "id": 1 }, { "id": 2 }], "users": [{ "id": 7 }] });
    assert_eq!(path(&v, "a.b"), Some(serde_json::json!(1)));
    assert_eq!(path(&v, "items[].id"), Some(serde_json::json!([1, 2])));
    assert_eq!(path(&v, "users.0.id"), Some(serde_json::json!(7)));
    assert_eq!(path(&v, "gone.x"), None);
    assert_eq!(
        path(&serde_json::json!([{ "id": 3 }]), "[].id"),
        Some(serde_json::json!([3]))
    );
    assert_eq!(path(&v, ""), Some(v.clone()));
}

#[test]
fn mapping_reads_a_row() {
    let c = template("trello").unwrap();
    let row = serde_json::json!({
        "id": "abc", "idShort": 12, "name": "Fix it", "shortUrl": "https://t/1", "desc": "Long",
        "idList": "L1", "idBoard": "B1", "closed": true, "other": "dropped"
    });
    let item = Client::item_of(&c.calls["list"], &row).unwrap();
    assert_eq!(
        (item.item_id.as_str(), item.id.as_str(), item.title.as_str()),
        ("abc", "12", "Fix it")
    );
    assert_eq!(
        (
            item.state.as_str(),
            item.url.as_str(),
            item.description.as_str()
        ),
        ("L1", "https://t/1", "Long")
    );
    assert_eq!(item.fields["board"], "B1");
    assert!(!item.fields.contains_key("other"));
    let read = serde_json::json!({ "name": "Fix it", "closed": true });
    let c2 = &c.calls["read"];
    assert!(Client::read_item(c2, &read, "abc").unwrap().closed);
}

#[test]
fn a_row_without_its_id_or_title_is_refused() {
    let c = template("trello").unwrap();
    let e = Client::item_of(&c.calls["list"], &serde_json::json!({ "id": "abc" })).unwrap_err();
    assert!(e.contains("name"), "{e}");
    let e = Client::item_of(&c.calls["list"], &serde_json::json!({ "name": "x" })).unwrap_err();
    assert!(e.contains("id"), "{e}");
    let e = Client::item_of(
        &c.calls["list"],
        &serde_json::json!({ "id": "a", "name": "   " }),
    )
    .unwrap_err();
    assert!(e.contains("name"), "{e}");
}

fn good() -> Connector {
    template("trello").unwrap()
}

fn refused(c: Connector) -> String {
    validate(&[c]).unwrap_err()
}

#[test]
fn connectors_are_validated() {
    let mut c = good();
    c.id = String::new();
    assert_eq!(refused(c), "connector 1 needs an id");
    assert_eq!(
        validate(&[good(), good()]).unwrap_err(),
        "two connectors have the id trello"
    );
    for url in ["http://api.example.com", "not a url"] {
        let mut c = good();
        c.base_url = url.into();
        assert_eq!(
            refused(c),
            "connector trello: base_url must be an https address"
        );
    }
    let mut c = good();
    c.base_url = "http://jira.mesh:8080".into();
    c.allow_private = true;
    assert_eq!(validate(&[c]), Ok(()));

    let mut c = good();
    c.headers.insert("Authorization".into(), "abc".into());
    assert_eq!(
        refused(c),
        "connector trello: header Authorization must use ${secret:NAME}"
    );
    let mut c = good();
    c.headers.insert("Accept".into(), "application/json".into());
    c.headers
        .insert("Notion-Version".into(), "2022-06-28".into());
    assert_eq!(validate(&[c]), Ok(()));

    for path in [
        "https://evil.example/x",
        "evil://x",
        "x/y",
        "//evil.example/x",
    ] {
        let mut c = good();
        c.calls.get_mut("list").unwrap().request.path = path.into();
        assert_eq!(
            refused(c),
            "connector trello: call list: path must start with /"
        );
    }
    let mut c = good();
    let list = c.calls.get_mut("list").unwrap();
    list.before = (0..4)
        .map(|i| NamedRequest {
            name: format!("s{i}"),
            request: list.request.clone(),
        })
        .collect();
    assert_eq!(
        refused(c),
        "connector trello: call list: at most 3 before requests"
    );
}

fn with_page(page: Page) -> String {
    let mut c = good();
    c.calls.get_mut("list").unwrap().page = Some(page);
    refused(c)
}

fn page(style: PageStyle) -> Page {
    Page {
        style,
        param: "p".into(),
        next: String::new(),
        has_more: String::new(),
        size: 0,
        max_pages: None,
    }
}

#[test]
fn paging_is_validated() {
    let mut p = page(PageStyle::Link);
    p.max_pages = Some(101);
    assert_eq!(
        with_page(p),
        "connector trello: call list: max_pages must be from 1 to 100"
    );
    assert_eq!(
        with_page(page(PageStyle::Cursor)),
        "connector trello: call list: a cursor page needs next"
    );
    for style in [PageStyle::Number, PageStyle::Offset] {
        assert_eq!(
            with_page(page(style)),
            "connector trello: call list: this page style needs size"
        );
    }
}

#[test]
fn the_kind_defaults_by_method() {
    let c = good();
    assert_eq!(c.calls["list"].kind(), CallKind::Lookup);
    let mut put = c.calls["list"].clone();
    put.request.method = "PUT".into();
    assert_eq!(put.kind(), CallKind::Change);
    put.kind = Some(CallKind::Lookup);
    assert_eq!(put.kind(), CallKind::Lookup);
}

#[test]
fn the_trello_template_is_valid() {
    let c = good();
    assert_eq!(validate(std::slice::from_ref(&c)), Ok(()));
    let names: Vec<&str> = c.calls.keys().map(String::as_str).collect();
    assert_eq!(
        names,
        ["boards", "comment", "list", "move", "read", "states"]
    );
    assert_eq!(c.calls["move"].kind(), CallKind::Change);
    assert_eq!(c.calls["comment"].kind(), CallKind::Change);
    assert_eq!(c.calls["list"].map["id"], "idShort");
    assert!(c.enabled);
}

const LIST: &str = "    map: { item_id: id, title: name }\n";

fn rows(from: u32, n: u32) -> String {
    let list: Vec<_> = (from..from + n)
        .map(|i| serde_json::json!({ "id": i.to_string(), "name": format!("Item {i}") }))
        .collect();
    serde_json::Value::Array(list).to_string()
}

fn list_call(yaml: &str) -> String {
    format!("  list:\n    request: {{ method: GET, path: /l }}\n{LIST}{yaml}")
}

#[tokio::test]
async fn a_list_with_no_page_setting_reads_once() {
    let s = stub().await;
    s.answer("/l", 200, &rows(1, 2));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, &list_call(""));
    let out = client(&c, &dir).list(&vars(&[])).await.unwrap();
    assert_eq!(out.items.len(), 2);
    assert_eq!(out.cut_off, None);
    assert_eq!(s.urls(), ["/l"]);
}

#[tokio::test]
async fn items_can_sit_inside_the_reply() {
    let s = stub().await;
    s.answer(
        "/l",
        200,
        &format!("{{\"data\":{{\"rows\":{}}}}}", rows(1, 1)),
    );
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, &list_call("    items: data.rows\n"));
    assert_eq!(
        client(&c, &dir).list(&vars(&[])).await.unwrap().items.len(),
        1
    );
}

#[tokio::test]
async fn a_cursor_list_follows_next() {
    let s = stub().await;
    let page = |r: String, next: &str| format!("{{\"rows\":{r},\"next\":\"{next}\"}}");
    s.answer("/l", 200, &page(rows(1, 1), "b"));
    s.answer("/l?after=b", 200, &page(rows(2, 1), "c"));
    s.answer("/l?after=c", 200, &page(rows(3, 1), ""));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    items: rows\n    page: { style: cursor, param: after, next: next }\n"),
    );
    assert_eq!(
        client(&c, &dir).list(&vars(&[])).await.unwrap().items.len(),
        3
    );
}

#[tokio::test]
async fn a_cursor_in_a_graphql_body() {
    let s = stub().await;
    s.answer("/g", 200, &format!("{{\"data\":{{\"rows\":{},\"pageInfo\":{{\"hasNextPage\":false,\"endCursor\":\"z\"}}}}}}", rows(1, 2)));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        "  list:\n    request: { method: POST, path: /g, body: { query: q, variables: { after: '{{cursor}}' } } }\n    items: data.rows\n    map: { item_id: id, title: name }\n    page: { style: cursor, next: data.pageInfo.endCursor, has_more: data.pageInfo.hasNextPage }\n",
    );
    assert_eq!(
        client(&c, &dir).list(&vars(&[])).await.unwrap().items.len(),
        2
    );
    let asked = s.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].3.contains("\"after\":\"\""), "{}", asked[0].3);
}

#[tokio::test]
async fn a_number_list_stops_on_a_short_page() {
    let s = stub().await;
    s.answer("/l?page=1", 200, &rows(1, 2));
    s.answer("/l?page=2", 200, &rows(3, 2));
    s.answer("/l?page=3", 200, &rows(5, 1));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    page: { style: number, param: page, size: 2 }\n"),
    );
    assert_eq!(
        client(&c, &dir).list(&vars(&[])).await.unwrap().items.len(),
        5
    );
    assert_eq!(s.urls().len(), 3);
}

#[tokio::test]
async fn an_offset_list_sends_items_read() {
    let s = stub().await;
    s.answer("/l?start=0", 200, &rows(1, 2));
    s.answer("/l?start=2", 200, &rows(3, 2));
    s.answer("/l?start=4", 200, "[]");
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    page: { style: offset, param: start, size: 2 }\n"),
    );
    assert_eq!(
        client(&c, &dir).list(&vars(&[])).await.unwrap().items.len(),
        4
    );
    assert_eq!(s.urls(), ["/l?start=0", "/l?start=2", "/l?start=4"]);
}

#[tokio::test]
async fn a_link_list_follows_the_header() {
    let s = stub().await;
    s.answer_with(
        "/l",
        200,
        vec![(
            "link",
            format!(
                "<{}/l?p=2>; rel=\"next\", <{}/l?p=9>; rel=\"last\"",
                s.base, s.base
            ),
        )],
        &rows(1, 1),
    );
    s.answer("/l?p=2", 200, &rows(2, 1));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, &list_call("    page: { style: link }\n"));
    assert_eq!(
        client(&c, &dir).list(&vars(&[])).await.unwrap().items.len(),
        2
    );
}

#[tokio::test]
async fn a_link_to_another_host_is_refused() {
    let s = stub().await;
    s.answer_with(
        "/l",
        200,
        vec![("link", "<https://evil.example/x>; rel=\"next\"".to_string())],
        &rows(1, 1),
    );
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, &list_call("    page: { style: link }\n"));
    let e = client(&c, &dir).list(&vars(&[])).await.err().unwrap();
    assert!(e.contains("another host"), "{e}");
    assert_eq!(s.urls(), ["/l"]);
}

#[tokio::test]
async fn a_repeated_cursor_stops_and_says_so() {
    let s = stub().await;
    let page = format!("{{\"rows\":{},\"next\":\"same\"}}", rows(1, 1));
    s.answer("/l", 200, &page);
    s.answer("/l?after=same", 200, &page);
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    items: rows\n    page: { style: cursor, param: after, next: next }\n"),
    );
    let out = client(&c, &dir).list(&vars(&[])).await.unwrap();
    assert!(out.cut_off.unwrap().contains("repeated"));
    assert_eq!(s.urls().len(), 2);
}

#[tokio::test]
async fn the_page_limit_stops_and_says_so() {
    let s = stub().await;
    *s.fallback.lock().unwrap() = Some(|_| rows(1, 2));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    page: { style: number, param: page, size: 2 }\n"),
    );
    let out = client(&c, &dir).list(&vars(&[])).await.unwrap();
    assert!(out.cut_off.unwrap().contains("20 pages"));
    assert_eq!(s.urls().len(), 20);
    let s = stub().await;
    *s.fallback.lock().unwrap() = Some(|_| rows(1, 2));
    let c = connector(
        &s.base,
        &list_call("    page: { style: number, param: page, size: 2, max_pages: 3 }\n"),
    );
    let out = client(&c, &dir).list(&vars(&[])).await.unwrap();
    assert!(out.cut_off.unwrap().contains("3 pages"));
    assert_eq!(s.urls().len(), 3);
}

#[tokio::test]
async fn the_item_limit_stops_and_says_so() {
    let s = stub().await;
    *s.fallback.lock().unwrap() = Some(|_| rows(1, 400));
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    page: { style: number, param: page, size: 400, max_pages: 100 }\n"),
    );
    let out = client(&c, &dir).list(&vars(&[])).await.unwrap();
    assert_eq!(out.items.len(), 5000);
    assert!(out.cut_off.unwrap().contains("5000 items"));
}

#[tokio::test]
async fn a_failed_page_fails_the_list() {
    let s = stub().await;
    s.answer("/l?page=1", 200, &rows(1, 2));
    s.answer("/l?page=2", 500, "boom");
    let dir = tempfile::tempdir().unwrap();
    let c = connector(
        &s.base,
        &list_call("    page: { style: number, param: page, size: 2 }\n"),
    );
    assert!(client(&c, &dir).list(&vars(&[])).await.is_err());
}

#[tokio::test]
async fn a_bad_row_is_skipped_and_named() {
    let s = stub().await;
    s.answer("/l", 200, r#"[{"id":"1","name":"Good"},{"id":"2"},"junk"]"#);
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, &list_call(""));
    let out = client(&c, &dir).list(&vars(&[])).await.unwrap();
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.skipped.len(), 2);
    assert!(out.skipped[0].contains("name"), "{:?}", out.skipped);
}

#[tokio::test]
async fn a_reply_that_is_no_list_fails() {
    let s = stub().await;
    s.answer("/l", 200, r#"{"rows":"nope"}"#);
    let dir = tempfile::tempdir().unwrap();
    let c = connector(&s.base, &list_call("    items: rows\n"));
    let e = client(&c, &dir).list(&vars(&[])).await.err().unwrap();
    assert!(e.contains("no list"), "{e}");
}

#[test]
fn health_keeps_the_last_status() {
    let h = Health::default();
    h.set(
        "t",
        Status {
            ok: false,
            at: "now".into(),
            message: "bad".into(),
        },
    );
    assert_eq!(h.all()["t"].message, "bad");
}
